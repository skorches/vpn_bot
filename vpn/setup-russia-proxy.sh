#!/bin/bash

#============================================================
# RUSSIA VPS — Nginx Reverse Proxy (Entry Point)
#
# Traffic flow:
#   You (Russia) → THIS SERVER (Nginx:443) → Germany VPS (Xray) → Internet
#
# Russian censors see normal HTTPS traffic to your domain.
# The real tunnel goes to Germany where traffic exits freely.
#
# Run setup-germany-vless.sh on Germany VPS FIRST.
# Then run this script with the values it gives you.
#
# Requirements:
#   - A domain name with A record pointing to this Russia VPS
#   - Values from Germany VPS setup (IP, port, WS path, UUID)
#============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

print_banner() {
    echo -e "${CYAN}"
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║  RUSSIA VPS — Nginx Reverse Proxy (Entry Point)         ║"
    echo "║  Forwards encrypted traffic to Germany exit server       ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

print_step()  { echo -e "\n${GREEN}[STEP]${NC} $1"; }
print_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }
print_info()  { echo -e "${CYAN}[INFO]${NC} $1"; }

# ================== PRE-CHECKS ==================
check_root() {
    if [[ $EUID -ne 0 ]]; then
        print_error "Run as root: sudo bash $0"
        exit 1
    fi
}

check_os() {
    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        OS=$ID
        print_info "OS: $PRETTY_NAME"
    else
        print_error "Cannot detect OS."
        exit 1
    fi
}

get_public_ip() {
    PUBLIC_IP=$(curl -4 -s --max-time 10 ifconfig.me 2>/dev/null)
    [[ -z "$PUBLIC_IP" ]] && PUBLIC_IP=$(curl -4 -s --max-time 10 icanhazip.com 2>/dev/null)
    [[ -z "$PUBLIC_IP" ]] && PUBLIC_IP=$(curl -4 -s --max-time 10 ip.sb 2>/dev/null)
    if [[ -z "$PUBLIC_IP" ]]; then
        print_error "Could not detect public IP."
        exit 1
    fi
    print_info "Russia VPS IP: $PUBLIC_IP"
}

# ================== USER INPUT ==================
get_user_input() {
    print_step "Configuration — enter values from Germany VPS setup"
    echo ""

    # Domain
    echo -e "${CYAN}Enter your domain name (A record must point to this Russia VPS: $PUBLIC_IP):${NC}"
    read -r DOMAIN
    if [[ -z "$DOMAIN" ]]; then
        print_error "Domain is required."
        exit 1
    fi

    # Check DNS
    print_info "Checking DNS for $DOMAIN..."
    RESOLVED_IP=$(dig +short "$DOMAIN" A 2>/dev/null | head -1 || true)
    if [[ -z "$RESOLVED_IP" ]]; then
        RESOLVED_IP=$(host "$DOMAIN" 2>/dev/null | awk '/has address/ {print $NF; exit}' || true)
    fi
    if [[ "$RESOLVED_IP" == "$PUBLIC_IP" ]]; then
        print_info "DNS OK: $DOMAIN → $PUBLIC_IP"
    elif [[ -n "$RESOLVED_IP" ]]; then
        print_warn "$DOMAIN resolves to $RESOLVED_IP (expected $PUBLIC_IP)"
        echo -e "${YELLOW}Continue? [y/N]:${NC}"
        read -r CONT
        [[ "${CONT,,}" != "y" ]] && exit 1
    else
        print_warn "Cannot resolve $DOMAIN. Make sure DNS is set up."
        echo -e "${YELLOW}Continue? [y/N]:${NC}"
        read -r CONT
        [[ "${CONT,,}" != "y" ]] && exit 1
    fi

    # Germany VPS values
    echo ""
    echo -e "${CYAN}Enter GERMANY VPS IP address:${NC}"
    read -r GERMANY_IP
    [[ -z "$GERMANY_IP" ]] && print_error "Germany IP required." && exit 1

    echo -e "${CYAN}Enter Xray port (from Germany setup):${NC}"
    read -r GERMANY_XRAY_PORT
    [[ -z "$GERMANY_XRAY_PORT" ]] && print_error "Xray port required." && exit 1

    echo -e "${CYAN}Enter WebSocket path (from Germany setup, starts with /):${NC}"
    read -r WS_PATH
    [[ -z "$WS_PATH" ]] && print_error "WS path required." && exit 1

    echo -e "${CYAN}Enter client UUID (from Germany setup):${NC}"
    read -r CLIENT_UUID
    [[ -z "$CLIENT_UUID" ]] && print_error "UUID required." && exit 1

    # Email for Let's Encrypt
    echo ""
    echo -e "${CYAN}Enter email for Let's Encrypt certificate (or press Enter to skip):${NC}"
    read -r CERT_EMAIL

    # Verify connectivity to Germany
    print_info "Testing connection to Germany VPS ${GERMANY_IP}:${GERMANY_XRAY_PORT}..."
    if timeout 5 bash -c "echo > /dev/tcp/${GERMANY_IP}/${GERMANY_XRAY_PORT}" 2>/dev/null; then
        # shellcheck disable=SC2015
        print_info "Connection to Germany VPS: OK"
    else
        print_warn "Cannot reach ${GERMANY_IP}:${GERMANY_XRAY_PORT}"
        print_warn "Make sure Germany VPS setup is complete and firewall allows this IP."
        echo -e "${YELLOW}Continue anyway? [y/N]:${NC}"
        read -r CONT
        [[ "${CONT,,}" != "y" ]] && exit 1
    fi

    echo ""
    print_info "Domain:      $DOMAIN"
    print_info "Germany VPS: $GERMANY_IP:$GERMANY_XRAY_PORT"
    print_info "WS Path:     $WS_PATH"
    print_info "UUID:        $CLIENT_UUID"
}

# ================== SYSTEM SETUP ==================
setup_system() {
    print_step "Installing Nginx + Certbot..."
    export DEBIAN_FRONTEND=noninteractive

    if [[ "$OS" == "ubuntu" || "$OS" == "debian" ]]; then
        apt-get update -y -qq
        apt-get install -y -qq nginx certbot python3-certbot-nginx \
            curl wget openssl dnsutils 2>/dev/null || \
        apt-get install -y nginx certbot python3-certbot-nginx \
            curl wget openssl dnsutils
    elif [[ "$OS" == "centos" || "$OS" == "almalinux" || "$OS" == "rocky" || "$OS" == "fedora" ]]; then
        yum update -y -q
        yum install -y -q nginx certbot python3-certbot-nginx curl wget openssl bind-utils
    else
        apt-get update -y && apt-get install -y nginx certbot python3-certbot-nginx curl wget openssl dnsutils
    fi
    print_info "Dependencies installed"
}

# ================== HIGH CONCURRENCY (kernel + nginx) ==================
# Russia VPS is a dumb TLS/WebSocket proxy; throughput is mostly connection count × FDs.
apply_sysctl_high_concurrency() {
    print_step "Tuning kernel limits for high connection concurrency..."
    local MARK_BEGIN="# --- vpn-russia-proxy: high concurrency ---"
    local MARK_END="# --- end vpn-russia-proxy: high concurrency ---"

    if ! grep -qF "$MARK_BEGIN" /etc/sysctl.conf 2>/dev/null; then
        cat >> /etc/sysctl.conf <<SYSCTL_HC

$MARK_BEGIN
fs.file-max=2097152
fs.nr_open=2097152
net.core.somaxconn=65535
net.core.netdev_max_backlog=16384
net.ipv4.tcp_max_syn_backlog=65535
net.ipv4.ip_local_port_range=10000 65535
$MARK_END
SYSCTL_HC
    fi
    sysctl -p 2>/dev/null || true
    print_info "Kernel: file-max / somaxconn / ephemeral ports tuned"
}

apply_nginx_systemd_limits() {
    print_step "Raising Nginx open-file limits (systemd)..."
    mkdir -p /etc/systemd/system/nginx.service.d
    cat > /etc/systemd/system/nginx.service.d/99-high-concurrency.conf <<'UNIT'
[Service]
LimitNOFILE=1048576
LimitNPROC=524288
UNIT
    systemctl daemon-reload 2>/dev/null || true
    print_info "systemd: LimitNOFILE=1048576 for nginx"
}

patch_nginx_main_for_concurrency() {
    print_step "Tuning Nginx workers (main nginx.conf)..."
    if ! command -v python3 &>/dev/null; then
        print_warn "python3 missing — skipping nginx.conf worker tuning (install python3)"
        return 0
    fi
    python3 - <<'PY'
import re
import shutil
from pathlib import Path

path = Path("/etc/nginx/nginx.conf")
if not path.is_file():
    raise SystemExit(0)
text = path.read_text()
bak = path.with_name("nginx.conf.bak-concurrency")
if not bak.is_file():
    shutil.copy2(path, bak)

# worker_rlimit_nofile (match systemd LimitNOFILE order of magnitude)
if "worker_rlimit_nofile" not in text:
    text = re.sub(
        r"(worker_processes\s+[^;]+;)",
        r"\1\nworker_rlimit_nofile 1048576;",
        text,
        count=1,
        flags=re.MULTILINE | re.DOTALL,
    )

text = re.sub(r"worker_connections\s+\d+\s*;", "worker_connections 65535;", text)

if "multi_accept" not in text:
    text = re.sub(r"events\s*\{", "events {\n    multi_accept on;\n    use epoll;\n    ", text, count=1)

path.write_text(text)
PY
    print_info "nginx.conf: worker_connections 65535, epoll, multi_accept, worker_rlimit_nofile"
}

tune_high_concurrency() {
    apply_sysctl_high_concurrency
    apply_nginx_systemd_limits
    patch_nginx_main_for_concurrency
}

# Drop extra conf.d / sites-enabled snippets so only this proxy vhost is active (avoids duplicate http{} directives)
nginx_isolate_clean_slate() {
    print_step "Isolating Nginx: backing up and removing other site + conf.d configs..."
    local BAK="/root/russia-proxy-nginx-backup"
    mkdir -p "$BAK"
    local TS
    TS=$(date +%s)
    if [[ -d /etc/nginx/conf.d ]]; then
        tar czf "${BAK}/conf.d-${TS}.tar.gz" -C /etc/nginx conf.d 2>/dev/null || true
        # Remove all conf.d snippets (often re-declare types_hash_max_size etc. vs main nginx.conf)
        find /etc/nginx/conf.d -maxdepth 1 -type f -name '*.conf' -exec rm -f {} \;
    fi
    if [[ -d /etc/nginx/sites-enabled ]]; then
        tar czf "${BAK}/sites-enabled-${TS}.tar.gz" -C /etc/nginx sites-enabled 2>/dev/null || true
        rm -f /etc/nginx/sites-enabled/*
    fi
    print_info "Previous configs archived under ${BAK}/ ; only this script's server block will be enabled next"
    print_warn "If this host served other sites, restore files from the tarball and merge by hand."
}

# ================== FIREWALL ==================
setup_firewall() {
    print_step "Configuring firewall..."

    if command -v ufw &>/dev/null; then
        ufw allow 80/tcp  2>/dev/null || true
        ufw allow 443/tcp 2>/dev/null || true
        print_info "UFW: ports 80, 443 open"
    fi

    if command -v iptables &>/dev/null; then
        iptables -I INPUT -p tcp --dport 80  -j ACCEPT 2>/dev/null || true
        iptables -I INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || true
    fi
}

# ================== BBR ==================
enable_bbr() {
    print_step "Enabling BBR..."
    if ! grep -q "tcp_congestion_control=bbr" /etc/sysctl.conf 2>/dev/null; then
        cat >> /etc/sysctl.conf <<'SYSCTL'

net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
net.core.rmem_max=16777216
net.core.wmem_max=16777216
net.ipv4.tcp_rmem=4096 87380 16777216
net.ipv4.tcp_wmem=4096 65536 16777216
net.ipv4.tcp_fastopen=3
net.ipv4.tcp_slow_start_after_idle=0
SYSCTL
    fi
    sysctl -p 2>/dev/null || true
    print_info "BBR enabled"
}

# ================== DECOY WEBSITE ==================
setup_decoy_site() {
    print_step "Setting up decoy website..."

    WEBROOT="/var/www/${DOMAIN}"
    mkdir -p "$WEBROOT"

    cat > "${WEBROOT}/index.html" <<'HTML'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 800px;
            margin: 80px auto;
            padding: 0 20px;
            color: #333;
            line-height: 1.6;
        }
        h1 { color: #2c3e50; }
        p { color: #555; }
        .footer { margin-top: 40px; font-size: 0.85em; color: #999; }
    </style>
</head>
<body>
    <h1>Welcome</h1>
    <p>This is a default web page. If you are the site administrator, you can customize this page.</p>
    <p>For more information, visit the documentation.</p>
    <div class="footer"><p>Server powered by Nginx</p></div>
</body>
</html>
HTML

    cat > "${WEBROOT}/robots.txt" <<'ROBOTS'
User-agent: *
Disallow:
ROBOTS

    chown -R www-data:www-data "$WEBROOT" 2>/dev/null || true
    print_info "Decoy site at $WEBROOT"
}

# ================== NGINX HTTP CONFIG ==================
configure_nginx_http() {
    print_step "Configuring Nginx (HTTP for cert validation)..."

    nginx_isolate_clean_slate

    cat > "/etc/nginx/sites-available/${DOMAIN}" <<NGINX_CONF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    root ${WEBROOT};
    index index.html;

    location /.well-known/acme-challenge/ {
        root ${WEBROOT};
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
NGINX_CONF

    ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"

    nginx -t 2>&1 || { print_error "Nginx config test failed!"; exit 1; }
    systemctl enable nginx
    systemctl restart nginx
    print_info "Nginx running (HTTP)"
}

# ================== TLS CERTIFICATE ==================
obtain_tls_cert() {
    print_step "Obtaining TLS certificate from Let's Encrypt..."

    local EMAIL_FLAG=""
    if [[ -n "${CERT_EMAIL:-}" ]]; then
        EMAIL_FLAG="-m $CERT_EMAIL"
    else
        EMAIL_FLAG="--register-unsafely-without-email"
    fi

    certbot certonly --webroot \
        -w "$WEBROOT" \
        -d "$DOMAIN" \
        $EMAIL_FLAG \
        --agree-tos \
        --non-interactive \
        --force-renewal 2>&1 || {
            print_error "Certbot failed! Check:"
            print_error "  1. $DOMAIN A record points to $PUBLIC_IP"
            print_error "  2. Port 80 is open and reachable from the internet"
            exit 1
        }

    SSL_CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
    SSL_KEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
    print_info "TLS certificate obtained"

    # Auto-renewal
    CRON_EXISTS=$(crontab -l 2>/dev/null | grep -c certbot || true)
    if [[ "$CRON_EXISTS" -eq 0 ]]; then
        EXISTING_CRON=$(crontab -l 2>/dev/null || true)
        echo "${EXISTING_CRON}
0 3 * * * certbot renew --quiet --post-hook 'systemctl reload nginx'" | crontab -
        print_info "Auto-renewal cron added"
    fi
}

# ================== NGINX TLS + REVERSE PROXY ==================
configure_nginx_tls() {
    print_step "Configuring Nginx TLS + reverse proxy to Germany..."

    cat > "/etc/nginx/sites-available/${DOMAIN}" <<NGINX_TLS
# HTTP → HTTPS redirect
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    root ${WEBROOT};

    location /.well-known/acme-challenge/ {
        root ${WEBROOT};
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

# HTTPS — decoy site + WebSocket reverse proxy to Germany
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate     ${SSL_CERT};
    ssl_certificate_key ${SSL_KEY};

    # Modern TLS
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # Security headers
    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options DENY;
    add_header Strict-Transport-Security "max-age=63072000" always;

    root ${WEBROOT};
    index index.html;

    # Normal visitors see the decoy site
    location / {
        try_files \$uri \$uri/ =404;
    }

    # Secret WebSocket path → forward to Germany VPS (Xray)
    location ${WS_PATH} {
        proxy_redirect off;
        proxy_pass http://${GERMANY_IP}:${GERMANY_XRAY_PORT};
        proxy_http_version 1.1;
        # Long-lived streams: avoid buffering stalls under load
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # Keep WebSocket alive
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_connect_timeout 60s;
    }
}
NGINX_TLS

    nginx -t 2>&1 || {
        print_error "Nginx TLS config test failed!"
        exit 1
    }

    systemctl reload nginx
    print_info "Nginx configured: HTTPS + reverse proxy to ${GERMANY_IP}:${GERMANY_XRAY_PORT}"
}

# ================== SAVE CONFIG ==================
save_config() {
    print_step "Saving configuration..."

    # Build VLESS link
    # Client connects to RUSSIA VPS domain:443, Nginx forwards to Germany
    ENCODED_PATH=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${WS_PATH}'))" 2>/dev/null || echo "${WS_PATH}")

    VLESS_LINK="vless://${CLIENT_UUID}@${DOMAIN}:443?type=ws&security=tls&host=${DOMAIN}&path=${ENCODED_PATH}&sni=${DOMAIN}&fp=chrome&alpn=h2%2Chttp%2F1.1#VLESS-WS-Proxy"

    cat > /root/russia-proxy-info.txt <<INFO
═══════════════════════════════════════════════════════
  RUSSIA VPS — Nginx Reverse Proxy
  Generated: $(date)
═══════════════════════════════════════════════════════

ARCHITECTURE:
  You → ${DOMAIN}:443 (this server, HTTPS) → ${GERMANY_IP}:${GERMANY_XRAY_PORT} (Xray) → Internet

  Russian censors see: normal HTTPS traffic to ${DOMAIN}
  Your traffic exits from: Germany (${GERMANY_IP})
  Decoy website: visitors see a normal webpage

SERVERS:
  Russia VPS:  ${PUBLIC_IP} (${DOMAIN})
  Germany VPS: ${GERMANY_IP}

NGINX REVERSE PROXY:
  Domain:    ${DOMAIN}
  Port:      443 (HTTPS)
  WS Path:   ${WS_PATH} (secret)
  Proxies to: ${GERMANY_IP}:${GERMANY_XRAY_PORT}
  TLS Cert:  Let's Encrypt (auto-renews)
  Concurrency: kernel + systemd + nginx workers tuned; other conf.d/sites-enabled configs archived under /root/russia-proxy-nginx-backup/

CONNECTION LINK (share with clients):
  ${VLESS_LINK}

═══════════════════════════════════════════════════════
HOW IT WORKS:

  1. Your V2ray client connects to ${DOMAIN}:443 via HTTPS
  2. It looks like normal website traffic to censors (DPI sees TLS + HTTP)
  3. Nginx on this Russia VPS receives the WebSocket on path ${WS_PATH}
  4. Nginx forwards that WebSocket to Germany VPS (${GERMANY_IP}:${GERMANY_XRAY_PORT})
  5. Xray on Germany decodes the VLESS protocol and sends traffic to the internet
  6. Responses flow back: Internet → Germany → Russia VPS → You

  This means:
  - Russian ISP only sees you connecting to ${DOMAIN} (your own server in Russia) — normal
  - The Russia→Germany link is a WebSocket connection between your servers
  - All internet traffic exits from Germany, bypassing Russian blocks

═══════════════════════════════════════════════════════
INFO

    chmod 600 /root/russia-proxy-info.txt
    print_info "Config saved to /root/russia-proxy-info.txt"
}

# ================== SUMMARY ==================
print_summary() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║          RUSSIA PROXY SETUP COMPLETE!                       ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${GREEN}Traffic flow:${NC}"
    echo -e "    You → ${DOMAIN}:443 (Russia) → ${GERMANY_IP} (Germany) → Internet"
    echo ""
    echo -e "  ${GREEN}Domain:${NC}    ${DOMAIN}"
    echo -e "  ${GREEN}WS Path:${NC}   ${WS_PATH}"
    echo -e "  ${GREEN}Germany:${NC}   ${GERMANY_IP}:${GERMANY_XRAY_PORT}"
    echo ""
    echo -e "  ${YELLOW}Connection link (import in V2rayNG / Hiddify / Streisand):${NC}"
    echo ""
    echo "  ${VLESS_LINK}"
    echo ""
    echo -e "  ${CYAN}Config saved:${NC} /root/russia-proxy-info.txt"
    echo ""
    echo -e "  ${CYAN}Useful commands:${NC}"
    echo "    systemctl status nginx"
    echo "    nginx -t && systemctl reload nginx"
    echo "    tail -f /var/log/nginx/access.log"
    echo "    tail -f /var/log/nginx/error.log"
    echo "    cat /root/russia-proxy-info.txt"
    echo ""
}

# ================== MAIN ==================
main() {
    print_banner
    check_root
    check_os
    get_public_ip
    get_user_input
    setup_system
    tune_high_concurrency
    setup_firewall
    enable_bbr
    setup_decoy_site
    configure_nginx_http
    obtain_tls_cert
    configure_nginx_tls
    save_config
    print_summary
}

main "$@"
