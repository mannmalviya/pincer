# Deploying the Pincer agent to Brev

Goal: run the Node.js agent persistently on a Brev VM so it can watch posts
24/7 while your laptop is off, while still letting the dashboard on your
laptop talk to it.

What runs where after this:

```
Laptop                                    Brev VM
─────────────────────────                 ─────────────────────────
Dashboard (Next.js)            ──HTTPS──► Agent (Node + SQLite)
Browser sidecar (Playwright)              Public reads: Reddit/HN JSON APIs
./profile/ (cookies)                      pm2 keeps it alive
```

## One-time: prepare the repo

```bash
# from your laptop
cd /home/mann/pincer
git add agent/
git commit -m "Add Brev deploy artifacts"
git push origin main
```

## Step 1: create a Brev launchable

In the Brev console, create a new instance with:

- **Compute**: smallest tier (no GPU needed; this is plain Node + SQLite).
  The cheapest `cpu-2x-4gb`-class works.
- **OS**: Ubuntu 22.04 (the setup script assumes Debian/Ubuntu `apt`).
- **Exposed ports**: add port `8000`. This is what the agent binds to.
- **No NVIDIA drivers needed** for the agent itself.

Boot the instance.

## Step 2: SSH in and run setup

Brev's UI gives you an SSH command. Once connected:

```bash
curl -fsSL https://raw.githubusercontent.com/mannmalviya/pincer/main/agent/brev/setup.sh | bash
```

The script:

1. Installs Node 22 (NodeSource) and build tools (better-sqlite3 needs them).
2. Clones the repo to `~/pincer/`.
3. `npm install` and `npm run build`.
4. Starts the agent under PM2 with `HOST=0.0.0.0 PORT=8000` so Brev can
   route traffic to it.
5. Registers PM2 with systemd so the agent auto-starts on reboot.

Total runtime ~3 minutes on a cold VM.

If you'd rather see what the script does before running it as a pipe:

```bash
git clone https://github.com/mannmalviya/pincer.git ~/pincer
cat ~/pincer/agent/brev/setup.sh   # read it
bash ~/pincer/agent/brev/setup.sh
```

## Step 3: confirm it's live

From the VM (local check):

```bash
curl -s http://127.0.0.1:8000/health
# → {"ok":true,"service":"pincer-agent","ts":...}

pm2 status
# pincer-agent  online
```

From your laptop (public check). Brev gives each exposed port a URL like
`https://agent-port-8000-xxxxx.brevlab.com`. Use that:

```bash
curl -s https://your-brev-agent-url/health
```

## Step 4: configure the agent's runtime env

The agent reads its config from `agent/.env` at boot via dotenv. `setup.sh`
creates one for you from `.env.example` on first run.

```bash
vi ~/pincer/agent/.env       # set NIM_API_KEY, optionally pick models
pm2 restart pincer-agent     # pick up the changes
```

Required: `NIM_API_KEY`. Without it, the reply-drafting and onboarding
analyze routes return 503. Everything else (ports, paths, model IDs)
has sensible defaults in `.env.example`.

You can still set vars via PM2 (`pm2 set pincer-agent:VAR value`); those
override anything in `.env` because they reach `process.env` first. Pick
one source of truth and stick with it; mixing them gets confusing.

## Step 5: point the dashboard at the Brev agent

On your laptop, set an env var the dashboard reads when it talks to the
agent. Add to `dashboard/.env.local`:

```
NEXT_PUBLIC_AGENT_URL=https://your-brev-agent-url
```

(Once the dashboard's auto-register patch lands, it reads this; for now the
agent is reachable but no UI code calls it yet.)

## Iterating after deploy

```bash
# from laptop
git push

# from Brev VM
cd ~/pincer && git pull
cd agent && npm install && npm run build
pm2 restart pincer-agent
```

Or just re-run `setup.sh`; it's idempotent and handles pull + install + restart.

## Tail logs

```bash
pm2 logs pincer-agent          # stream live
pm2 logs pincer-agent --lines 200   # last 200
cat ~/pincer-agent.out.log     # raw stdout
cat ~/pincer-agent.err.log     # raw stderr
```

## Stop / remove

```bash
pm2 stop pincer-agent          # halt but keep config
pm2 delete pincer-agent        # remove from PM2 entirely
pm2 unstartup systemd          # de-register from boot
```

To wipe the agent's DB:

```bash
pm2 stop pincer-agent
rm ~/.pincer/agent.sqlite*
pm2 start pincer-agent
```

## What the agent does from Brev

- Polls Reddit + HN public JSON endpoints every 60s for every watched post.
- No auth needed for reads, so no cookies, no Playwright on this layer.
- Writes snapshots + comments to `~/.pincer/agent.sqlite`.

## What it does NOT do (yet)

- **Posting.** Writing to Reddit/HN still requires your laptop's browser
  sidecar (cookies live there). When you publish from the dashboard, the
  laptop sidecar runs the post and the laptop dashboard tells the Brev
  agent "watch this URL".
- **Auth.** The agent currently binds 0.0.0.0 with no token check. Fine for
  a short-lived hackathon VM; before any longer-term deploy, add a bearer
  token in `lib/http.ts` and check it in `server.ts` before each handler.
- **Comment classification.** NIM hookup is a later iteration.

## Troubleshooting

- **`curl: (7) Failed to connect`** from laptop → check Brev's exposed-ports
  config and confirm port 8000 is open. Also verify the agent is binding
  `0.0.0.0` (check `pm2 logs pincer-agent` for `"agent listening" {"port":8000,"host":"0.0.0.0"}`).
- **`better-sqlite3` segfault** → Node version mismatch between install
  and runtime. Re-run `setup.sh`; it does a clean `rm -rf node_modules`
  before installing.
- **CORS error in the dashboard** → the agent's CORS regex is open to any
  localhost origin, so this only triggers if your laptop dashboard is
  served from a non-localhost domain. Edit `agent/src/config.ts`'s
  `CORS_ORIGIN_REGEX` and redeploy.
