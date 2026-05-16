#!/usr/bin/env bash
# Brev VM setup for the Pincer agent.
#
# Run this ONCE on a fresh Brev launchable. It installs Node 22, clones the
# repo (or pulls latest if it's already there), installs deps, and brings
# the agent up under PM2 so it survives crashes and VM reboots.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mannmalviya/pincer/main/agent/brev/setup.sh | bash
#
# Or after `git clone`-ing locally:
#   bash agent/brev/setup.sh
#
# Idempotent: re-running pulls latest, rebuilds, restarts. Safe to use as
# the launchable's startup hook.

set -euo pipefail

# --- knobs -------------------------------------------------------------------
REPO_URL="${PINCER_REPO_URL:-https://github.com/mannmalviya/pincer.git}"
REPO_DIR="${PINCER_REPO_DIR:-$HOME/pincer}"
BRANCH="${PINCER_BRANCH:-main}"
NODE_MAJOR="${NODE_MAJOR:-22}"
GITHUB_TOKEN="${PINCER_GITHUB_TOKEN:-}"

# DB dir, needed unconditionally for the `mkdir -p` below. Real DB_PATH
# is read at runtime by the agent from .env (or process.env if not set).
DB_PATH_DEFAULT="$HOME/.pincer/agent.sqlite"

# --- helpers -----------------------------------------------------------------
log() { printf "\n\033[1;36m[setup]\033[0m %s\n" "$*"; }

git_auth_args=()
if [[ -n "$GITHUB_TOKEN" ]]; then
  if [[ "$REPO_URL" != https://github.com/* ]]; then
    log "PINCER_GITHUB_TOKEN is set, but PINCER_REPO_URL is not a GitHub HTTPS URL; token auth will be skipped"
  else
    git_auth_header="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w 0)"
    git_auth_args=(
      -c "http.https://github.com/.extraheader=Authorization: Basic ${git_auth_header}"
    )
  fi
fi

# --- 1. Node 22 via NodeSource ----------------------------------------------
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v${NODE_MAJOR}.* ]]; then
  log "installing Node ${NODE_MAJOR}.x via NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs build-essential
else
  log "Node $(node -v) already present"
fi

# --- 2. Repo (clone or pull) -------------------------------------------------
if [[ -d "$REPO_DIR/.git" ]]; then
  log "updating existing repo at $REPO_DIR"
  git "${git_auth_args[@]}" -C "$REPO_DIR" fetch origin "$BRANCH"
  git -C "$REPO_DIR" checkout "$BRANCH"
  git -C "$REPO_DIR" reset --hard "origin/$BRANCH"
else
  log "cloning $REPO_URL to $REPO_DIR"
  git "${git_auth_args[@]}" clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi

# --- 3. npm install (forces native rebuild for the active Node version) -----
log "npm install in $REPO_DIR/agent"
cd "$REPO_DIR/agent"
rm -rf node_modules package-lock.json
npm install

# --- 4. Build the TypeScript output for `npm start` -------------------------
log "compiling TypeScript"
npm run build

# --- 5. Seed .env from .env.example if the user hasn't created one ----------
# The agent loads its config from this file at startup via dotenv. On first
# run we copy the example so the user has something to edit; we never
# overwrite an existing .env (would clobber a real NIM_API_KEY).
if [[ ! -f "$REPO_DIR/agent/.env" && -f "$REPO_DIR/agent/.env.example" ]]; then
  log "creating agent/.env from .env.example (edit it to set NIM_API_KEY)"
  cp "$REPO_DIR/agent/.env.example" "$REPO_DIR/agent/.env"
fi

if [[ -f "$REPO_DIR/agent/.env" ]]; then
  if ! grep -qE '^HOST=' "$REPO_DIR/agent/.env"; then
    log "adding HOST=0.0.0.0 to agent/.env for Brev routing"
    printf '\nHOST=0.0.0.0\n' >> "$REPO_DIR/agent/.env"
  fi
  if ! grep -qE '^PORT=' "$REPO_DIR/agent/.env"; then
    log "adding PORT=8000 to agent/.env for Brev routing"
    printf '\nPORT=8000\n' >> "$REPO_DIR/agent/.env"
  fi
fi

# --- 6. Ensure the DB directory exists --------------------------------------
# Honour DB_PATH from the .env if present; fall back to the default.
DB_PATH="$(grep -E '^DB_PATH=' "$REPO_DIR/agent/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)"
DB_PATH="${DB_PATH:-$DB_PATH_DEFAULT}"
mkdir -p "$(dirname "$DB_PATH")"

# --- 7. PM2 install + start -------------------------------------------------
if ! command -v pm2 >/dev/null 2>&1; then
  log "installing PM2 globally"
  sudo npm install -g pm2
fi

log "(re)starting pincer-agent under PM2"
pm2 delete pincer-agent 2>/dev/null || true
# No env vars on this line. The agent's dotenv import reads .env at boot,
# and PM2 inherits the working directory ($REPO_DIR/agent) via --cwd so
# dotenv's default lookup ("./.env") finds it.
pm2 start "$REPO_DIR/agent/dist/index.js" --name pincer-agent \
  --cwd "$REPO_DIR/agent" \
  --time --output "$HOME/pincer-agent.out.log" --error "$HOME/pincer-agent.err.log"

# --- 8. Persist PM2 across reboots ------------------------------------------
# `pm2 startup` prints a sudo command on stdout that registers a systemd
# service for the current user. We execute it ourselves so the whole script
# is hands-off. If you'd rather inspect the command first, comment out the
# eval and run `pm2 startup` manually.
PM2_STARTUP_CMD="$(pm2 startup systemd -u "$USER" --hp "$HOME" | tail -1)"
if [[ "$PM2_STARTUP_CMD" == sudo* ]]; then
  log "registering PM2 with systemd"
  eval "$PM2_STARTUP_CMD"
fi
pm2 save

# --- 9. Smoke test ----------------------------------------------------------
# Health check uses 8000 unless the user overrode it in .env. Mirror the
# same precedence the agent uses: .env wins, default 8000 as fallback.
PORT="$(grep -E '^PORT=' "$REPO_DIR/agent/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)"
PORT="${PORT:-8000}"
log "verifying /health responds on :${PORT}"
sleep 2
if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null; then
  log "agent is live on :${PORT}"
  echo
  echo "  Public URL: whatever Brev exposes port ${PORT} as."
  echo "  Edit config: vi $REPO_DIR/agent/.env (then pm2 restart pincer-agent)"
  echo "  Logs:        pm2 logs pincer-agent"
  echo "  Restart:     pm2 restart pincer-agent"
  echo "  Stop:        pm2 stop pincer-agent"
else
  echo
  echo "  Health check failed; inspect:"
  echo "    pm2 logs pincer-agent --lines 100"
  exit 1
fi
