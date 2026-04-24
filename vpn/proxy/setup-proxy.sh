#!/usr/bin/env bash
# ──────────────────────────────────────────────────
# Reverse proxy setup for the Russian VPS
# Run as root: bash setup-proxy.sh <GERMANY_IP>
# ──────────────────────────────────────────────────
set -euo pipefail

GERMANY_IP="${1:-}"
if [[ -z "$GERMANY_IP" ]]; then
  echo "Usage: bash setup-proxy.sh <GERMANY_VPS_IP>"
  echo "Example: bash setup-proxy.sh 185.100.50.25"
  exit 1
fi

echo "==> Installing nginx (with stream module)..."
apt-get update -qq
apt-get install -y nginx libnginx-mod-stream

echo "==> Backing up original nginx.conf..."
cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak.$(date +%s)

echo "==> Writing stream proxy config..."
cat > /etc/nginx/nginx.conf << NGINX_EOF
user www-data;
worker_processes auto;
pid /run/nginx.pid;

events {
    worker_connections 4096;
}

stream {
    log_format proxy '\$remote_addr [\$time_local] '
                     '\$protocol \$status \$bytes_sent \$bytes_received '
                     '\$session_time "\$upstream_addr"';
    access_log /var/log/nginx/stream-access.log proxy;

    # Port 443 — main VLESS inbound
    server {
        listen 443;
        listen [::]:443;
        proxy_pass ${GERMANY_IP}:443;
        proxy_timeout 300s;
        proxy_connect_timeout 10s;
    }

    # Ports 20000-20100 — dynamic inbounds (anti-configs, etc.)
    server {
        listen 20000-20100;
        listen [::]:20000-20100;
        proxy_pass ${GERMANY_IP}:\$server_port;
        proxy_timeout 300s;
        proxy_connect_timeout 10s;
    }
}
NGINX_EOF

echo "==> Testing nginx config..."
nginx -t

echo "==> Opening firewall ports..."
if command -v ufw &>/dev/null; then
  ufw allow 443/tcp
  ufw allow 20000:20100/tcp
  echo "    ufw rules added"
elif command -v firewall-cmd &>/dev/null; then
  firewall-cmd --permanent --add-port=443/tcp
  firewall-cmd --permanent --add-port=20000-20100/tcp
  firewall-cmd --reload
  echo "    firewalld rules added"
else
  echo "    No ufw/firewalld found — make sure ports 443, 20000-20100 are open"
fi

echo "==> Restarting nginx..."
systemctl enable nginx
systemctl restart nginx

echo ""
echo "✅ Proxy is live!"
echo "   Forwarding ports 443, 20000-20100 → ${GERMANY_IP}"
echo ""
echo "Next steps:"
echo "  1. Point your domain A record to this server's IP"
echo "  2. On Germany VPS, set XUI_PUBLIC_HOST=vpn.yourdomain.com in .env"
echo "  3. If 3x-ui creates inbounds outside 20000-20100, add those ports to nginx.conf"
