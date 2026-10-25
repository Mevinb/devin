#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Use the existing build and keep the judging session offline. No emulators boot.
export OPENAI_API_KEY=""
export PIXELSENTINEL_DEVICES=approximate
export PORT="${PORT:-3000}"

if [[ ! -f packages/server/dist/index.js || ! -f packages/web/dist/index.html ]]; then
  echo "The app needs a build. Run pnpm build once, then bash judge.sh."
  exit 1
fi
if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "Dashboard already running: http://localhost:$PORT"
  exit 0
fi
echo "PixelSentinel: http://localhost:$PORT"
echo "Offline judging mode. Keep this terminal open; Ctrl+C stops the dashboard."
exec node packages/server/dist/index.js
