#!/bin/bash

#============================================================
# GERMANY VPS — Xray VLESS Exit Server
#
# This is the EXIT node. Traffic flows:
#   You (Russia) → Russia VPS (Nginx) → THIS SERVER (Xray) → Internet
#
# Run this FIRST, then run setup-russia-proxy.sh on the Russia VPS.
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
    echo "║  GERMANY VPS — Xray VLESS Exit Server                   ║"
    echo "║  Run this FIRST, then setup-russia-proxy.sh on Russia   ║"
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
    print_info "Germany VPS IP: $PUBLIC_IP"
}

# ================== USER INPUT ==================
get_user_input() {
    print_step "Configuration"

    echo -e "${CYAN}Enter the IP address of your RUSSIA VPS (the reverse proxy):${NC}"
    read -r RUSSIA_IP

    if [[ -z "$RUSSIA_IP" ]]; then
        print_error "Russia VPS IP is required."
        exit 1
    fi

    # Validate IP format
    if ! echo "$RUSSIA_IP" | grep -qP '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$'; then
        print_warn "IP format looks unusual: $RUSSIA_IP"
    fi

    print_info "Russia VPS IP: $RUSSIA_IP"
    print_info "Only this IP will be allowed to connect to the Xray port."

    # Xray listening port (the Russia VPS will connect here)
    XRAY_PORT=$(shuf -i 10000-50000 -n 1)

    # WebSocket path (must match on both servers)
    WS_PATH="/$(head -c 6 /dev/urandom | base64 | tr -dc 'a-z0-9' | head -c 8)"

    # ---- Detect existing 3X-UI ----
    EXISTING_3XUI=false
    SKIP_INSTALL=false

    if systemctl is-active --quiet x-ui 2>/dev/null || [[ -f /usr/local/x-ui/x-ui ]]; then
        EXISTING_3XUI=true
        echo ""
        echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
        echo -e "${GREEN}  Existing 3X-UI installation detected!${NC}"
        echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
        echo ""
        echo -e "${CYAN}Use your existing 3X-UI panel? [Y/n]:${NC}"
        read -r USE_EXISTING
        USE_EXISTING="${USE_EXISTING,,}"

        if [[ "$USE_EXISTING" != "n" ]]; then
            SKIP_INSTALL=true
            print_info "Will add VLESS-WS inbound to your existing panel."
            echo ""
            echo -e "${CYAN}Enter your existing panel port:${NC}"
            read -r PANEL_PORT
            [[ -z "$PANEL_PORT" ]] && print_error "Panel port required." && exit 1

            echo -e "${CYAN}Enter your existing panel username:${NC}"
            read -r PANEL_USER
            [[ -z "$PANEL_USER" ]] && print_error "Username required." && exit 1

            echo -e "${CYAN}Enter your existing panel password:${NC}"
            read -rs PANEL_PASS
            echo ""
            [[ -z "$PANEL_PASS" ]] && print_error "Password required." && exit 1

            # Verify login works
            print_info "Verifying panel credentials..."

            # Try HTTP first, then HTTPS (panel may have TLS enabled)
            PANEL_SCHEME="http"
            TEST_RESP=""
            CURL_OK=false

            # Test HTTP
            TEST_RESP=$(curl -s --max-time 10 \
                -H "Content-Type: application/x-www-form-urlencoded" \
                -X POST "http://127.0.0.1:${PANEL_PORT}/login" \
                -d "username=${PANEL_USER}&password=${PANEL_PASS}" 2>/dev/null) || true

            if echo "$TEST_RESP" | jq -e '.success == true' &>/dev/null; then
                CURL_OK=true
                PANEL_SCHEME="http"
            else
                # Try HTTPS
                print_info "HTTP failed, trying HTTPS..."
                TEST_RESP=$(curl -sk --max-time 10 \
                    -H "Content-Type: application/x-www-form-urlencoded" \
                    -X POST "https://127.0.0.1:${PANEL_PORT}/login" \
                    -d "username=${PANEL_USER}&password=${PANEL_PASS}" 2>/dev/null) || true

                if echo "$TEST_RESP" | jq -e '.success == true' &>/dev/null; then
                    CURL_OK=true
                    PANEL_SCHEME="https"
                fi
            fi

            if [[ "$CURL_OK" == "true" ]]; then
                print_info "Login verified via ${PANEL_SCHEME} — credentials are correct."
            else
                print_warn "Could not verify login (response: ${TEST_RESP:-empty})"
                print_warn "This can happen if the panel uses a sub-path or different port."
                echo -e "${YELLOW}Continue anyway? [y/N]:${NC}"
                read -r CONT
                [[ "${CONT,,}" != "y" ]] && exit 1
            fi
        fi
    fi

    # Generate new panel creds only if doing a fresh install
    if [[ "$SKIP_INSTALL" == "false" ]]; then
        PANEL_PORT=$(shuf -i 50001-60000 -n 1)
        while [[ "$PANEL_PORT" == "$XRAY_PORT" ]]; do
            PANEL_PORT=$(shuf -i 50001-60000 -n 1)
        done

        PANEL_USER="admin$(shuf -i 1000-9999 -n 1)"
        PANEL_PASS="$(head -c 15 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)"
        [[ -z "$PANEL_PASS" ]] && PANEL_PASS="Pass$(shuf -i 100000-999999 -n 1)Xr"
    fi

    print_info "Xray WS port: $XRAY_PORT"
    print_info "WS path: $WS_PATH"
    print_info "Panel port: $PANEL_PORT"
}

# ================== SYSTEM SETUP ==================
setup_system() {
    print_step "Installing dependencies..."
    export DEBIAN_FRONTEND=noninteractive

    if [[ "$OS" == "ubuntu" || "$OS" == "debian" ]]; then
        apt-get update -y -qq
        apt-get install -y -qq curl wget unzip socat cron openssl jq sqlite3 2>/dev/null || \
        apt-get install -y curl wget unzip socat cron openssl jq sqlite3
    elif [[ "$OS" == "centos" || "$OS" == "almalinux" || "$OS" == "rocky" || "$OS" == "fedora" ]]; then
        yum update -y -q
        yum install -y -q curl wget unzip socat cronie openssl jq sqlite
    else
        apt-get update -y && apt-get install -y curl wget unzip socat cron openssl jq sqlite3
    fi
    print_info "Dependencies installed"
}

# ================== FIREWALL ==================
setup_firewall() {
    print_step "Configuring firewall (only Russia VPS can reach Xray port)..."

    # iptables: allow Xray port ONLY from Russia VPS
    if command -v iptables &>/dev/null; then
        # Drop all others to Xray port, allow only Russia VPS
        iptables -I INPUT -p tcp --dport "$XRAY_PORT" -s "$RUSSIA_IP" -j ACCEPT 2>/dev/null || true
        iptables -A INPUT -p tcp --dport "$XRAY_PORT" -j DROP 2>/dev/null || true
        # Panel port — restrict or leave open (you'll access from Russia VPS or SSH tunnel)
        iptables -I INPUT -p tcp --dport "$PANEL_PORT" -j ACCEPT 2>/dev/null || true
        print_info "iptables: port $XRAY_PORT open ONLY for $RUSSIA_IP"
    fi

    if command -v ufw &>/dev/null; then
        ufw allow from "$RUSSIA_IP" to any port "$XRAY_PORT" proto tcp 2>/dev/null || true
        ufw deny "$XRAY_PORT"/tcp 2>/dev/null || true
        ufw allow "$PANEL_PORT"/tcp 2>/dev/null || true
        print_info "UFW rules added"
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

# ================== INSTALL 3X-UI ==================
install_3xui() {
    if [[ "$SKIP_INSTALL" == "true" ]]; then
        print_step "Using existing 3X-UI installation..."

        # Make sure it's running
        if ! systemctl is-active --quiet x-ui 2>/dev/null; then
            print_info "Starting x-ui service..."
            systemctl start x-ui 2>/dev/null || true
            sleep 3
        fi

        PANEL_LIVE=false
        for i in $(seq 1 10); do
            # Try whatever scheme was detected during login verification
            HTTP_CODE=$(curl -s ${PANEL_SCHEME:+-k} -o /dev/null -w '%{http_code}' --max-time 5 \
                "${PANEL_SCHEME:-http}://127.0.0.1:${PANEL_PORT}/" 2>/dev/null) || true
            if [[ "$HTTP_CODE" -gt 0 && "$HTTP_CODE" -lt 500 ]]; then
                PANEL_LIVE=true
                print_info "Existing panel confirmed on ${PANEL_SCHEME:-http}://...:${PANEL_PORT} (HTTP $HTTP_CODE)"
                break
            fi
            # Also try the other scheme
            local ALT_SCHEME="http"
            [[ "${PANEL_SCHEME:-http}" == "http" ]] && ALT_SCHEME="https"
            local ALT_TLS=""
            [[ "$ALT_SCHEME" == "https" ]] && ALT_TLS="-k"
            HTTP_CODE=$(curl -s $ALT_TLS -o /dev/null -w '%{http_code}' --max-time 5 \
                "${ALT_SCHEME}://127.0.0.1:${PANEL_PORT}/" 2>/dev/null) || true
            if [[ "$HTTP_CODE" -gt 0 && "$HTTP_CODE" -lt 500 ]]; then
                PANEL_LIVE=true
                PANEL_SCHEME="$ALT_SCHEME"
                print_info "Existing panel confirmed on ${PANEL_SCHEME}://...:${PANEL_PORT} (HTTP $HTTP_CODE)"
                break
            fi
            sleep 2
        done

        if [[ "$PANEL_LIVE" != "true" ]]; then
            print_warn "Panel not responding on port $PANEL_PORT."
        fi
        return 0
    fi

    print_step "Installing 3X-UI (Xray core)..."

    if systemctl is-active --quiet x-ui 2>/dev/null; then
        systemctl stop x-ui 2>/dev/null || true
    fi

    if [[ -f /etc/x-ui/x-ui.db ]] && command -v sqlite3 &>/dev/null; then
        sqlite3 /etc/x-ui/x-ui.db "UPDATE settings SET value='' WHERE key='webCertFile';" 2>/dev/null || true
        sqlite3 /etc/x-ui/x-ui.db "UPDATE settings SET value='' WHERE key='webKeyFile';" 2>/dev/null || true
    fi

    curl -sSL -o /tmp/3xui_install.sh https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh
    if [[ ! -s /tmp/3xui_install.sh ]]; then
        print_error "Failed to download 3X-UI installer!"
        exit 1
    fi

    yes "" | bash /tmp/3xui_install.sh 2>&1 || print_warn "Installer exited non-zero; checking..."
    rm -f /tmp/3xui_install.sh
    sleep 5

    if [[ ! -f /usr/local/x-ui/x-ui ]]; then
        print_error "3X-UI binary not found!"
        exit 1
    fi

    systemctl stop x-ui 2>/dev/null || true
    sleep 2
    /usr/local/x-ui/x-ui setting -username "$PANEL_USER" -password "$PANEL_PASS" -port "$PANEL_PORT" 2>&1 || {
        /usr/local/x-ui/x-ui setting -username "$PANEL_USER" 2>&1 || true
        /usr/local/x-ui/x-ui setting -password "$PANEL_PASS" 2>&1 || true
        /usr/local/x-ui/x-ui setting -port "$PANEL_PORT" 2>&1 || true
    }

    if command -v sqlite3 &>/dev/null && [[ -f /etc/x-ui/x-ui.db ]]; then
        sqlite3 /etc/x-ui/x-ui.db "DELETE FROM settings WHERE key IN ('webCertFile','webKeyFile');" 2>/dev/null || true
    fi

    systemctl daemon-reload 2>/dev/null || true
    systemctl enable x-ui 2>/dev/null || true
    systemctl restart x-ui
    sleep 5

    PANEL_LIVE=false
    for i in $(seq 1 10); do
        HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PANEL_PORT}/" 2>/dev/null)
        if [[ "$HTTP_CODE" -gt 0 && "$HTTP_CODE" -lt 500 ]]; then
            PANEL_LIVE=true
            print_info "Panel running on port $PANEL_PORT (HTTP $HTTP_CODE)"
            break
        fi
        sleep 3
    done

    if [[ "$PANEL_LIVE" != "true" ]]; then
        print_warn "Panel may not be responding. Check: systemctl status x-ui"
    fi
}

# ================== CREATE VLESS-WS INBOUND ==================
configure_vless_ws() {
    print_step "Creating VLESS + WebSocket inbound..."

    XRAY_BIN=""
    for candidate in \
        /usr/local/x-ui/bin/xray-linux-amd64 \
        /usr/local/x-ui/bin/xray-linux-arm64 \
        /usr/local/x-ui/bin/xray; do
        if [[ -f "$candidate" && -x "$candidate" ]]; then
            XRAY_BIN="$candidate"
            break
        fi
    done
    [[ -z "$XRAY_BIN" ]] && XRAY_BIN=$(find /usr/local/x-ui/bin/ -type f -executable 2>/dev/null | head -1)

    CLIENT_UUID=$("$XRAY_BIN" uuid 2>/dev/null || cat /proc/sys/kernel/random/uuid)
    print_info "Client UUID: $CLIENT_UUID"

    INBOUND_CREATED=false

    if [[ "$PANEL_LIVE" != "true" ]]; then
        print_warn "Panel not verified. Create inbound manually."
        return
    fi

    local BASE="${PANEL_SCHEME:-http}://127.0.0.1:${PANEL_PORT}"
    local CURL_TLS=""
    [[ "${PANEL_SCHEME:-http}" == "https" ]] && CURL_TLS="-k"

    # Login
    local LOGGED_IN=false
    for attempt in 1 2 3 4 5; do
        LOGIN_RESP=$(curl -s $CURL_TLS --max-time 10 \
            -c /tmp/xui_cookie_de \
            -H "Content-Type: application/x-www-form-urlencoded" \
            -X POST "${BASE}/login" \
            -d "username=${PANEL_USER}&password=${PANEL_PASS}" 2>/dev/null) || true

        if echo "$LOGIN_RESP" | jq -e '.success == true' &>/dev/null; then
            LOGGED_IN=true
            print_info "Logged into panel via ${PANEL_SCHEME:-http} (attempt $attempt)"
            break
        fi
        sleep 2
    done

    if [[ "$LOGGED_IN" != "true" ]]; then
        print_warn "Cannot login. Create inbound manually."
        return
    fi

    # Xray listens on 0.0.0.0 so Russia VPS can reach it
    # Firewall restricts access to only Russia VPS IP
    python3 -c "
import json

settings = json.dumps({
    'clients': [{
        'id': '${CLIENT_UUID}',
        'flow': '',
        'email': 'user1',
        'limitIp': 0,
        'totalGB': 0,
        'expiryTime': 0,
        'enable': True,
        'tgId': '',
        'subId': '',
        'reset': 0
    }],
    'decryption': 'none',
    'fallbacks': []
})

stream = json.dumps({
    'network': 'ws',
    'security': 'none',
    'wsSettings': {
        'acceptProxyProtocol': False,
        'path': '${WS_PATH}',
        'headers': {}
    }
})

sniffing = json.dumps({
    'enabled': True,
    'destOverride': ['http', 'tls', 'quic', 'fakedns'],
    'metadataOnly': False,
    'routeOnly': False
})

inbound = {
    'up': 0,
    'down': 0,
    'total': 0,
    'remark': 'VLESS-WS-Germany',
    'enable': True,
    'expiryTime': 0,
    'listen': '',
    'port': ${XRAY_PORT},
    'protocol': 'vless',
    'settings': settings,
    'streamSettings': stream,
    'sniffing': sniffing
}

json.dump(inbound, open('/tmp/xui_inbound_de.json', 'w'))
print('JSON written')
" 2>&1 || {
        print_warn "Python3 failed. Using manual JSON..."
        cat > /tmp/xui_inbound_de.json <<'JSONEOF'
{"up":0,"down":0,"total":0,"remark":"VLESS-WS-Germany","enable":true,"expiryTime":0,"listen":"","port":XRAY_PORT_PH,"protocol":"vless","settings":"{\"clients\":[{\"id\":\"UUID_PH\",\"flow\":\"\",\"email\":\"user1\",\"limitIp\":0,\"totalGB\":0,\"expiryTime\":0,\"enable\":true}],\"decryption\":\"none\",\"fallbacks\":[]}","streamSettings":"{\"network\":\"ws\",\"security\":\"none\",\"wsSettings\":{\"acceptProxyProtocol\":false,\"path\":\"WSPATH_PH\",\"headers\":{}}}","sniffing":"{\"enabled\":true,\"destOverride\":[\"http\",\"tls\",\"quic\",\"fakedns\"]}"}
JSONEOF
        sed -i "s/XRAY_PORT_PH/${XRAY_PORT}/g" /tmp/xui_inbound_de.json
        sed -i "s|UUID_PH|${CLIENT_UUID}|g" /tmp/xui_inbound_de.json
        sed -i "s|WSPATH_PH|${WS_PATH}|g" /tmp/xui_inbound_de.json
    }

    CREATE_RESP=$(curl -s $CURL_TLS --max-time 15 \
        -b /tmp/xui_cookie_de \
        -H "Content-Type: application/json" \
        -X POST "${BASE}/panel/api/inbounds/add" \
        -d @/tmp/xui_inbound_de.json 2>/dev/null) || true

    print_info "API response: $CREATE_RESP"

    if echo "$CREATE_RESP" | jq -e '.success == true' &>/dev/null; then
        print_info "VLESS-WS inbound created!"
        INBOUND_CREATED=true
    else
        local ERR_MSG=$(echo "$CREATE_RESP" | jq -r '.msg // "unknown"' 2>/dev/null)
        print_warn "Inbound creation: $ERR_MSG"
    fi

    rm -f /tmp/xui_cookie_de /tmp/xui_inbound_de.json
}

# ================== SAVE CONFIG ==================
save_config() {
    print_step "Saving configuration..."

    cat > /root/germany-vless-info.txt <<INFO
═══════════════════════════════════════════════════════
  GERMANY VPS — Xray VLESS Exit Server
  Generated: $(date)
  Germany IP: ${PUBLIC_IP}
  Russia IP:  ${RUSSIA_IP}
  Mode:       $(if [[ "$SKIP_INSTALL" == "true" ]]; then echo "Added to existing 3X-UI"; else echo "Fresh 3X-UI install"; fi)
═══════════════════════════════════════════════════════

ARCHITECTURE:
  You (Russia) → Russia VPS (Nginx:443) → Germany VPS (Xray:${XRAY_PORT}) → Internet

PANEL ACCESS:
  URL:      http://${PUBLIC_IP}:${PANEL_PORT}/
  Username: ${PANEL_USER}
  Password: ${PANEL_PASS}

XRAY INBOUND:
  Port:      ${XRAY_PORT}
  Protocol:  VLESS + WebSocket
  WS Path:   ${WS_PATH}
  UUID:      ${CLIENT_UUID}
  Security:  none (Russia VPS handles TLS)

FIREWALL:
  Port ${XRAY_PORT} is ONLY accessible from ${RUSSIA_IP}

═══════════════════════════════════════════════════════
VALUES NEEDED FOR RUSSIA VPS SETUP:
  (Copy these when running setup-russia-proxy.sh)

  Germany IP:  ${PUBLIC_IP}
  Xray Port:   ${XRAY_PORT}
  WS Path:     ${WS_PATH}
  Client UUID: ${CLIENT_UUID}
═══════════════════════════════════════════════════════
INFO

    chmod 600 /root/germany-vless-info.txt
    print_info "Config saved to /root/germany-vless-info.txt"
}

# ================== SUMMARY ==================
print_summary() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║         GERMANY VPS SETUP COMPLETE!                     ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    if [[ "$SKIP_INSTALL" == "true" ]]; then
        echo -e "  ${GREEN}Mode:${NC}     Added VLESS-WS inbound to existing 3X-UI"
    else
        echo -e "  ${GREEN}Mode:${NC}     Fresh 3X-UI install"
    fi
    echo -e "  ${GREEN}Panel:${NC}    http://${PUBLIC_IP}:${PANEL_PORT}/"
    echo -e "  ${GREEN}Username:${NC} ${PANEL_USER}"
    echo -e "  ${GREEN}Password:${NC} ${PANEL_PASS}"
    echo ""
    echo -e "  ${GREEN}Xray Port:${NC} ${XRAY_PORT} (only ${RUSSIA_IP} can connect)"
    echo -e "  ${GREEN}WS Path:${NC}   ${WS_PATH}"
    echo -e "  ${GREEN}UUID:${NC}      ${CLIENT_UUID}"
    echo ""

    if [[ "${INBOUND_CREATED:-false}" == "true" ]]; then
        echo -e "  ${GREEN}[OK] Inbound created automatically${NC}"
    else
        echo -e "  ${YELLOW}[!] Create inbound manually in the panel${NC}"
    fi

    echo ""
    echo -e "  ${YELLOW}═══ NEXT STEP ═══${NC}"
    echo -e "  ${YELLOW}Copy these values and run setup-russia-proxy.sh on your Russia VPS:${NC}"
    echo ""
    echo -e "    Germany IP:  ${GREEN}${PUBLIC_IP}${NC}"
    echo -e "    Xray Port:   ${GREEN}${XRAY_PORT}${NC}"
    echo -e "    WS Path:     ${GREEN}${WS_PATH}${NC}"
    echo -e "    Client UUID: ${GREEN}${CLIENT_UUID}${NC}"
    echo ""
    echo -e "  ${CYAN}Config saved:${NC} /root/germany-vless-info.txt"
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
    setup_firewall
    enable_bbr
    install_3xui
    configure_vless_ws
    save_config
    print_summary
}

main "$@"
