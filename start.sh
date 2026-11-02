#!/usr/bin/env bash
# Start the Outreach Agent: ./start.sh  (on macOS you can copy it to "Start Outreach Agent.command" and double-click it).
# Installs on first run, then opens the app in your browser.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required: https://nodejs.org (download the LTS installer), then run this again."
  read -r -p "Press Enter to close"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "First run: installing (one-time, about a minute)…"
  npm install --no-audit --no-fund || exit 1
fi
npm run build --silent || exit 1
echo "Starting Outreach Agent — your browser will open. Keep this window open (close it to stop)."
exec node dist/index.js
