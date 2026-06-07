#!/usr/bin/env bash
# Sync this repo to the live locations and restart the server.
# Run as root (writes to /var/www and /opt). For a first-time install see README.md.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo ">> static client -> /var/www/prison-escape"
install -d /var/www/prison-escape
cp -a "$REPO"/index.html "$REPO"/css "$REPO"/js /var/www/prison-escape/
chown -R www-data:www-data /var/www/prison-escape

echo ">> server -> /opt/prison-escape-server (runs as prison-mp)"
install -d -o prison-mp -g prison-mp /opt/prison-escape-server/logs
cp -a "$REPO"/server/index.js "$REPO"/server/package.json "$REPO"/server/package-lock.json \
      /opt/prison-escape-server/
( cd /opt/prison-escape-server && npm ci --omit=dev )
chown -R prison-mp:prison-mp /opt/prison-escape-server
systemctl restart prison-escape-mp

echo ">> done. Bump ?v=N in index.html when assets change to bust the 7d cache."
