#!/usr/bin/env bash
URL="${DASHBOARD_URL:-http://localhost:8080/dashboard.html}"
BASE="${URL%/dashboard.html}"

for _ in $(seq 1 30); do
  curl -sf "$BASE/api/health" >/dev/null && break
  sleep 1
done

exec google-chrome-stable \
  --new-window "$URL" \
  --ozone-platform=x11 \
  --disable-gpu \
  --log-level=3 \
  --class=TelemetryDash \
  --user-data-dir="$HOME/.dashboard-profile" \
  --start-fullscreen \
  --no-first-run \
  --disable-features=TranslateUI
