# EasyTunnel - HTTP Tunneling Service

Node.js SSH reverse-tunnel service (similar to Pinggy) that exposes local services to the internet by assigning a random subdomain and proxying HTTP traffic through an SSH connection.

## Features

- SSH server (default: `2222`; configurable) and HTTP proxy (default: `8081`; configurable)
- Random hostname generation per tunnel
- Nginx vhost installer with stream proxy for SSH over port 443
- Works with wildcard domain (e.g., `*.example.com`) and HTTPS
- Automatic cleanup when SSH connection closes

## Install

1) Install dependencies
```bash
npm install
```

2) Run the installer (as root) to configure Nginx and environment
```bash
sudo bash install.sh
```
- Prompts for:
  - Base domain (e.g., `example.com`) used for `*.example.com`
  - Public SSH host to show in the client command (defaults to the base domain)
  - SSH port (default `2222`) and HTTP proxy port (default `8081`)
- Creates `/etc/nginx/sites-available/htunnel.conf` and enables it (`sites-enabled/htunnel.conf`)
- Adds a stream config `/etc/nginx/streams-enabled/htunnel_stream.conf` to proxy TCP 443 → `127.0.0.1:<SSH_PORT>`
- Writes `/root/htunnel/.env` with your selections

Optional: Install as a systemd service during install to run on boot and manage with systemctl.

3) DNS and SSL
- Add DNS A records pointing to your server IP:
  - `example.com`
  - `*.example.com`
- For wildcard HTTPS, obtain certificates using DNS-01 (as guided by `install.sh`):
```bash
sudo certbot certonly --manual --preferred-challenges dns -d "*.example.com" -d "example.com"
```
Nginx will use the certs from `/etc/letsencrypt/live/<your-domain>/`.

## Usage

### Start the server
```bash
cd /root/htunnel
source .env   # or export the variables manually
npm start
```

The server starts:
- SSH server on `SSH_PORT` (default: `2222`)
- HTTP proxy on `HTTP_PORT` (default: `8081`)

### Run as a systemd service (optional)
- During install you can choose to install the service.
- Manage it with:
```bash
sudo systemctl status htunnel
sudo systemctl restart htunnel
sudo journalctl -u htunnel -f
```

### Create a tunnel from your client
```bash
ssh -N -p $SSH_PORT -R0:localhost:3000 user@$PUBLIC_SSH_HOST
# Example:
ssh -N -p 2222 -R0:localhost:3000 user@example.com
```

This will:
1. Create an SSH connection to the tunnel server
2. Reverse-forward your local port 3000 through the tunnel
3. Generate a random hostname (e.g., `quick-fox-123`)
4. Display a public URL: `https://quick-fox-123.example.com`

You can test from the server with:
```bash
curl -H "Host: quick-fox-123.example.com" http://127.0.0.1:$HTTP_PORT/
```

## Environment Variables

- `SSH_PORT`: SSH server port (default: `2222`)
- `HTTP_PORT`: HTTP proxy server port (default: `8081`)
- `HTUNNEL_DOMAIN`: Base domain used for generated URLs (default: `blablabla.me`)
- `PUBLIC_SSH_HOST`: Hostname shown in SSH usage (defaults to `HTUNNEL_DOMAIN`)
- `HTUNNEL_VERBOSE` (or `VERBOSE`): Set to `1`/`true`/`yes` for verbose logs; default is quiet

These are written to `/root/htunnel/.env` by `install.sh` and read at runtime by the server.

## How it works

1. Client connects via SSH with reverse port forwarding (`-R0:localhost:<local_port>`)
2. Server accepts the SSH connection and records the reverse-forward request
3. Server assigns a random hostname and starts a local TCP listener for that tunnel
4. Nginx proxies `http(s)://<random>.<domain>` to the Node HTTP proxy
5. The Node proxy accepts HTTP requests and opens `forwardOut` channels over SSH to the client’s service

## Nginx layout (installed by install.sh)

- `sites-available/htunnel.conf` and `sites-enabled/htunnel.conf`: HTTP/HTTPS vhosts for `*.<domain>`
- `streams-enabled/htunnel_stream.conf`: SSH stream proxy (`443` → `127.0.0.1:<SSH_PORT>`) for easy client connectivity
- Larger proxy buffers are configured to handle apps with large headers (e.g., many cookies)

## Troubleshooting

- 502 Bad Gateway (too big header): Increase Nginx buffers in `htunnel.conf`:
  - `proxy_buffer_size 128k; proxy_buffers 32 256k; proxy_busy_buffers_size 512k;`
- 502 Bad Gateway (connection errors):
  - Confirm the server log shows the tunnel and the Node proxy listening on the expected `HTTP_PORT`
  - Test locally: `curl -H "Host: <host>.<domain>" http://127.0.0.1:$HTTP_PORT/`
  - Ensure your local app is actually running on the port you pass via `-R0:localhost:<port>`
- Verbose logs: set `HTUNNEL_VERBOSE=1` to enable detailed request/SSH logs

## Security Note

EasyTunnel is a development tool. For production, add authentication, rate limiting, and other security hardening.
