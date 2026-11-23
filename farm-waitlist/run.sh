#!/usr/bin/env bash
set -euo pipefail

export TZ="${TZ:-America/New_York}"
mkdir -p /data/backups

exec node /app/dist/server.mjs
