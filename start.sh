#!/usr/bin/env bash
# Start the Outreach Agent: ./start.sh  (on macOS you can copy it to "Start Outreach Agent.command" and double-click it).
# Installs on first run, then opens the app in your browser.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.13+ is required: https://nodejs.org (download the LTS installer), then run this again."
  read -r -p "Press Enter to close"
  exit 1
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  echo "Your Node.js is $(node -v) — this app needs 22.13 or newer. Get the LTS from https://nodejs.org"
  read -r -p "Press Enter to close"
  exit 1
fi
if [ ! -x node_modules/.bin/tsc ]; then
  echo "First run: installing (one-time, about a minute)…"
  npm install --no-audit --no-fund || exit 1
fi
npm run build --silent || exit 1
echo "Starting Outreach Agent — your browser will open. Keep this window open (close it to stop)."
exec node --disable-warning=ExperimentalWarning dist/index.js
