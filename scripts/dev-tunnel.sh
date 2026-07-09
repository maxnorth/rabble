#!/usr/bin/env bash
# Dev launcher: tunnel the server publicly (Slack must reach it for the
# managed setup), export the URL as PUBLIC_URL, run the dev stack. Degrades
# to tunnel-less dev when PUBLIC_URL is set, offline, or cloudflared missing.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3080}"

if [ -n "${PUBLIC_URL:-}" ]; then
  echo "[dev] PUBLIC_URL already set: ${PUBLIC_URL} (skipping tunnel)"
elif command -v cloudflared >/dev/null 2>&1; then
  TUNNEL_LOG="$(mktemp -t rabble-tunnel)"
  cloudflared tunnel --url "http://localhost:${PORT}" --no-autoupdate >"$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  trap 'kill "$TUNNEL_PID" 2>/dev/null || true' EXIT

  # Wait for cloudflared to print its assigned URL.
  URL=""
  for _ in $(seq 1 40); do
    URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
    [ -n "$URL" ] && break
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then break; fi
    sleep 0.5
  done

  if [ -n "$URL" ]; then
    export PUBLIC_URL="$URL"
    echo "[dev] tunnel up: ${PUBLIC_URL} -> http://localhost:${PORT}"
  else
    echo "[dev] tunnel didn't come up (offline?); continuing without PUBLIC_URL" >&2
  fi
else
  echo "[dev] cloudflared not installed (mise install); continuing without PUBLIC_URL" >&2
fi

pnpm dev
