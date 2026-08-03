#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ -f "$REPO/config.json" ] || {
  cp "$REPO/config.example.json" "$REPO/config.json"
  echo ">> created config.json — edit machine_name and exec_url"
}

mkdir -p "$HOME/.config/systemd/user" "$HOME/.config/autostart"
ln -sf "$REPO/systemd/telemetry.service" "$HOME/.config/systemd/user/telemetry.service"
ln -sf "$REPO/scripts/dashboard.desktop" "$HOME/.config/autostart/dashboard.desktop"

systemctl --user daemon-reload
systemctl --user enable --now telemetry.service

echo ">> installed. status:"
systemctl --user --no-pager status telemetry.service | head -5
