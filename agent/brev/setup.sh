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

# Env baked into the PM2 process. Override before invoking setup if you want
# different ports, intervals, or a custom User-Agent.
PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"          # 0.0.0.0 so Brev's port routing can reach us
WATCH_INTERVAL_MS="${WATCH_INTERVAL_MS:-60000}"
USER_AGENT="${USER_AGENT:-pincer-agent/0.1 (+https://github.com/mannmalviya/pincer)}"
DB_PATH="${DB_PATH:-$HOME/.pincer/agent.sqlite}"

# --- helpers -----------------------------------------------------------------
log() { printf "\n\033[1;36m[setup]\033[0m %s\n" "$*"; }

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
  git -C "$REPO_DIR" fetch origin "$BRANCH"
  git -C "$REPO_DIR" checkout "$BRANCH"
  git -C "$REPO_DIR" reset --hard "origin/$BRANCH"
else
  log "cloning $REPO_URL to $REPO_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi

# --- 3. npm install (forces native rebuild for the active Node version) -----
log "npm install in $REPO_DIR/agent"
cd "$REPO_DIR/agent"
rm -rf node_modules package-lock.json
npm install

# --- 4. Build the TypeScript output for `npm start` -------------------------
log "compiling TypeScript"
npm run build

# --- 5. Ensure the DB directory exists --------------------------------------
mkdir -p "$(dirname "$DB_PATH")"

# --- 6. PM2 install + start -------------------------------------------------
if ! command -v pm2 >/dev/null 2>&1; then
  log "installing PM2 globally"
  sudo npm install -g pm2
fi

log "(re)starting pincer-agent under PM2"
pm2 delete pincer-agent 2>/dev/null || true
PORT="$PORT" HOST="$HOST" WATCH_INTERVAL_MS="$WATCH_INTERVAL_MS" \
  USER_AGENT="$USER_AGENT" DB_PATH="$DB_PATH" \
  pm2 start "$REPO_DIR/agent/dist/index.js" --name pincer-agent \
    --time --output "$HOME/pincer-agent.out.log" --error "$HOME/pincer-agent.err.log"

# --- 7. Persist PM2 across reboots ------------------------------------------
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

# --- 8. Smoke test ----------------------------------------------------------
log "verifying /health responds"
sleep 2
if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null; then
  log "agent is live on :${PORT}"
  echo
  echo "  Public URL: whatever Brev exposes port ${PORT} as."
  echo "  Logs:        pm2 logs pincer-agent"
  echo "  Restart:     pm2 restart pincer-agent"
  echo "  Stop:        pm2 stop pincer-agent"
else
  echo
  echo "  Health check failed; inspect:"
  echo "    pm2 logs pincer-agent --lines 100"
  exit 1
fi
