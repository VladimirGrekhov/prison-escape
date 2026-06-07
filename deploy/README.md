# Deployment

Prison Escape is a static client (`index.html`, `css/`, `js/`) plus a small Node
server (`server/`) that runs the Colyseus multiplayer room **and** a debug log
sink. nginx serves the static files over HTTPS and reverse-proxies the server.

```
browser ──HTTPS──> nginx ──┬─ /            -> /var/www/prison-escape (static)
                           ├─ /mp/  (WS)   -> 127.0.0.1:2567 (Colyseus)
                           └─ /log  (POST) -> 127.0.0.1:2568 (debug log sink)
server (systemd: prison-escape-mp, user prison-mp) -> /opt/prison-escape-server
debug log written to /opt/prison-escape-server/logs/client.log
```

## Layout in this folder
- `systemd/prison-escape-mp.service` — server unit (hardened; `ReadWritePaths` for logs).
- `nginx/prison-escape.conf` — site (HTTP→HTTPS, static caching, `/mp/` and `/log` proxies).
  TLS cert lines are managed by Certbot; adjust the domain.
- `nginx/ws-upgrade-map.conf` — `$connection_upgrade` map for WebSocket upgrades (goes in `conf.d/`).
- `deploy.sh` — sync repo → `/var/www` + `/opt` and restart (for an existing install).

## First-time setup on a fresh server
Assumes Debian/Ubuntu. Replace `prison-escape.duckdns.org` with your domain.

```bash
# 1. packages
sudo apt update && sudo apt install -y nginx nodejs npm certbot python3-certbot-nginx

# 2. unprivileged service user
sudo useradd --system --no-create-home --shell /usr/sbin/nologin prison-mp

# 3. server code -> /opt
sudo install -d -o prison-mp -g prison-mp /opt/prison-escape-server/logs
sudo cp -a server/index.js server/package.json server/package-lock.json /opt/prison-escape-server/
( cd /opt/prison-escape-server && sudo -u prison-mp npm ci --omit=dev )
sudo chown -R prison-mp:prison-mp /opt/prison-escape-server

# 4. systemd unit
sudo cp deploy/systemd/prison-escape-mp.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now prison-escape-mp

# 5. static client -> webroot
sudo install -d /var/www/prison-escape
sudo cp -a index.html css js /var/www/prison-escape/
sudo chown -R www-data:www-data /var/www/prison-escape

# 6. nginx
sudo cp deploy/nginx/ws-upgrade-map.conf /etc/nginx/conf.d/
sudo cp deploy/nginx/prison-escape.conf /etc/nginx/sites-available/prison-escape
sudo ln -sf /etc/nginx/sites-available/prison-escape /etc/nginx/sites-enabled/prison-escape
sudo rm -f /etc/nginx/sites-enabled/default
sudo openssl dhparam -out /etc/nginx/ssl/dhparam.pem 2048   # referenced by the site
sudo nginx -t && sudo systemctl reload nginx

# 7. TLS (Certbot rewrites the cert/redirect lines in the site)
sudo certbot --nginx -d prison-escape.duckdns.org

# 8. firewall (optional)
sudo ufw allow 80,443/tcp
```

DNS: point an A-record at the server IP (e.g. DuckDNS).

## Notes
- Colyseus is pinned to **0.16 / schema 3** to match the bundled client
  `js/colyseus.js` (colyseus.js@0.16.22). Do **not** bump to 0.17 / schema 4.
- The server binds `127.0.0.1` only (2567 WS, 2568 log); nginx is the public edge.
- The unit is hardened (`ProtectSystem=strict`); the only writable path is
  `/opt/prison-escape-server/logs` via `ReadWritePaths`.
- After editing static assets, bump the `?v=N` query in `index.html` to bust the
  7-day asset cache, then run `deploy.sh`.
- Debug: open the site with `?debug=1` to number the cells and stream the move log
  to `/opt/prison-escape-server/logs/client.log`.
