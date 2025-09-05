#!/usr/bin/env bash
set -euo pipefail

# HTunnel installer: configures nginx for the tunnel domain and writes an env file
# - Adds/updates stream (SSH over 443) and HTTP/HTTPS proxy blocks
# - Creates/updates /root/htunnel/.env with HTUNNEL_DOMAIN, SSH_PORT, HTTP_PORT, PUBLIC_SSH_HOST
# - Prints guidance for wildcard DNS and SSL

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

NGINX_DEFAULT="/etc/nginx/sites-enabled/default"
NGINX_SITES_AVAILABLE="/etc/nginx/sites-available"
NGINX_SITES_ENABLED="/etc/nginx/sites-enabled"
HTUNNEL_SITE_AVAIL="$NGINX_SITES_AVAILABLE/htunnel.conf"
HTUNNEL_SITE_LINK="$NGINX_SITES_ENABLED/htunnel.conf"
ENV_FILE="/root/htunnel/.env"

read -rp "Base domain for tunnels (e.g. example.com) [blablabla.me]: " BASE_DOMAIN
BASE_DOMAIN=${BASE_DOMAIN:-blablabla.me}

read -rp "Public SSH host shown to users (default: ${BASE_DOMAIN}): " PUBLIC_SSH_HOST
PUBLIC_SSH_HOST=${PUBLIC_SSH_HOST:-$BASE_DOMAIN}

read -rp "SSH port (server listens) [2222]: " SSH_PORT
SSH_PORT=${SSH_PORT:-2222}

read -rp "HTTP proxy port (server listens) [8081]: " HTTP_PORT
HTTP_PORT=${HTTP_PORT:-8081}

echo "\nConfig summary:" 
echo "- Domain:            *.${BASE_DOMAIN}"
echo "- Public SSH host:   ${PUBLIC_SSH_HOST}"
echo "- SSH port:          ${SSH_PORT}"
echo "- HTTP proxy port:   ${HTTP_PORT}"
echo

[[ -s "$NGINX_DEFAULT" ]] || { echo "ERROR: $NGINX_DEFAULT not found or empty" >&2; exit 1; }

# Backup nginx default and remove any existing wildcard blocks to avoid conflicts
ts=$(date +%s)
cp -v "$NGINX_DEFAULT" "/etc/nginx/backup/default.install.$ts"

echo "Cleaning any existing *.${BASE_DOMAIN} server blocks from $NGINX_DEFAULT (to avoid duplicates)"
tmpfile="/tmp/nginx.default.$ts"
mapfile -t ranges < <(awk -v pat="\\*\.${BASE_DOMAIN//./\\.};" '
  BEGIN{depth=0; in_srv=0; start=0; matchsrv=0}
  {
    line=$0
    if (line ~ /^\s*server\s*\{\s*$/) { if (!in_srv) { in_srv=1; start=NR; matchsrv=0 } }
    t=line; o=gsub(/\{/ ,"{", t); t=line; c=gsub(/\}/ ,"}", t);
    if (in_srv && line ~ ("server_name[[:space:]]+" pat)) matchsrv=1;
    depth += o - c;
    if (in_srv && depth==0) { if (matchsrv) print start "," NR; in_srv=0; start=0; matchsrv=0 }
  }
' "$NGINX_DEFAULT")

if ((${#ranges[@]})); then
  awk -v OFS="\n" -v ranges="${ranges[*]}" '
    BEGIN { n=split(ranges,a," "); for(i=1;i<=n;i++){ split(a[i],p,","); s[p[1]]=p[2]; } }
    { keep=1; for (k in s){ if (NR>=k && NR<=s[k]) { keep=0; break } } if (keep) print $0 }
  ' "$NGINX_DEFAULT" > "$tmpfile"
  cp "$tmpfile" "$NGINX_DEFAULT"
  nginx -t
  systemctl reload nginx
fi

echo "Writing dedicated vhost to $HTUNNEL_SITE_AVAIL and enabling it"
mkdir -p "$NGINX_SITES_AVAILABLE" "$NGINX_SITES_ENABLED"
cat > "$HTUNNEL_SITE_AVAIL" <<CONF
# HTunnel configuration for *.${BASE_DOMAIN} (managed by install.sh)
server {
    listen 80;
    server_name *.${BASE_DOMAIN};
    large_client_header_buffers 8 64k;

    location / {
        proxy_pass http://127.0.0.1:${HTTP_PORT};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_buffer_size 64k;
        proxy_buffers 16 128k;
        proxy_busy_buffers_size 256k;
    }
}

server {
    listen 443 ssl;
    server_name *.${BASE_DOMAIN};
    large_client_header_buffers 8 64k;

    location / {
        proxy_pass http://127.0.0.1:${HTTP_PORT};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_buffer_size 64k;
        proxy_buffers 16 128k;
        proxy_busy_buffers_size 256k;
    }

    ssl_certificate /etc/letsencrypt/live/${BASE_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${BASE_DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}
CONF

ln -sf "$HTUNNEL_SITE_AVAIL" "$HTUNNEL_SITE_LINK"
nginx -t
systemctl reload nginx

echo
echo "Enabled vhost $HTUNNEL_SITE_LINK for *.${BASE_DOMAIN} -> 127.0.0.1:${HTTP_PORT}."

# Ensure stream (SSH over 443) exists. Prefer a separate file to avoid tangling with default http server.
STREAM_FILE="/etc/nginx/streams-enabled/htunnel_stream.conf"
mkdir -p /etc/nginx/streams-enabled
if ! grep -q "include /etc/nginx/streams-enabled/\*.conf;" /etc/nginx/nginx.conf; then
  echo "Adding stream include to /etc/nginx/nginx.conf"
  cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak.$ts
  awk '
    BEGIN{inserted=0}
    /^http\s*\{/ {print; next}
    /^stream\s*\{/ {found=1}
    {print}
    END{
      if (!found) {
        print "\nstream {\n    include /etc/nginx/streams-enabled/*.conf;\n}\n"
      }
    }
  ' /etc/nginx/nginx.conf > /etc/nginx/nginx.conf.new.$ts
  mv /etc/nginx/nginx.conf.new.$ts /etc/nginx/nginx.conf
fi

cat > "$STREAM_FILE" <<CONF
# HTunnel SSH stream (managed by install.sh)
upstream htunnel_ssh_backend { server 127.0.0.1:${SSH_PORT}; }
server {
  listen 443;
  proxy_pass htunnel_ssh_backend;
  proxy_timeout 1s;
  proxy_responses 1;
  error_log /var/log/nginx/ssh_proxy.log;
}
CONF

nginx -t
systemctl reload nginx
echo "Installed stream config at $STREAM_FILE and reloaded nginx."

# Write env file for htunnel server
mkdir -p "$(dirname "$ENV_FILE")"
cat > "$ENV_FILE" <<ENV
HTUNNEL_DOMAIN=${BASE_DOMAIN}
PUBLIC_SSH_HOST=${PUBLIC_SSH_HOST}
SSH_PORT=${SSH_PORT}
HTTP_PORT=${HTTP_PORT}
ENV
chmod 600 "$ENV_FILE"
echo "Wrote env to $ENV_FILE"

echo
echo "Next steps:"
echo "1) Add DNS records:"
echo "   - A record:          ${BASE_DOMAIN} -> <your server IP>"
echo "   - A record (wildcard): *.${BASE_DOMAIN} -> <your server IP>"
echo "2) Obtain SSL certificates (HTTP or DNS challenge). For wildcard, DNS-01 is required:"
echo "   sudo certbot certonly --manual --preferred-challenges dns -d '*.${BASE_DOMAIN}' -d '${BASE_DOMAIN}'"
echo "   Then nginx HTTPS block will use: /etc/letsencrypt/live/${BASE_DOMAIN}/{fullchain.pem,privkey.pem}"
echo "3) Start the tunnel server with env file:"
echo "   cd /root/htunnel && source $ENV_FILE && npm start"
echo
echo "Client command example:"
echo "   ssh -N -p ${SSH_PORT} -R0:localhost:3000 user@${PUBLIC_SSH_HOST}"
echo "   Then open: https://<random>.${BASE_DOMAIN}"

# Optional: install as a systemd service
read -rp $'\nInstall HTunnel as a systemd service now? [y/N]: ' REPLY_SERVICE || true
case "${REPLY_SERVICE:-}" in
  [yY][eE][sS]|[yY])
    SERVICE_USER_DEFAULT="root"
    read -rp "Run service as user [${SERVICE_USER_DEFAULT}]: " SERVICE_USER
    SERVICE_USER=${SERVICE_USER:-$SERVICE_USER_DEFAULT}
    UNIT_PATH="/etc/systemd/system/htunnel.service"
    echo "Writing systemd unit to $UNIT_PATH"
    cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=HTunnel SSH/HTTP Tunneling Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=/root/htunnel
EnvironmentFile=/root/htunnel/.env
ExecStart=/usr/bin/env node index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

    systemctl daemon-reload
    systemctl enable --now htunnel || true
    systemctl restart htunnel || true
    systemctl status --no-pager htunnel || true
    ;;
  *)
    echo "Skipping systemd service installation."
    ;;
esac
