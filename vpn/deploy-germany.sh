#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# Deploy VPN backend to Germany VPS
# Run as root on the Germany VPS:
#   bash deploy-germany.sh
# ──────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="/opt/vpn-service"
BACKEND_DIR="$APP_DIR/backend"
DB_NAME="vpnservice"
DB_USER="vpnservice"

echo "========================================="
echo "  VPN Backend — Germany VPS Deployment"
echo "========================================="

# ── 1. System packages ──
echo ""
echo "[1/8] Installing system packages..."
apt-get update -qq
apt-get install -y curl git postgresql postgresql-contrib

# ── 2. Node.js (via NodeSource) ──
if ! command -v node &>/dev/null; then
  echo "[2/8] Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "[2/8] Node.js already installed: $(node -v)"
fi

# ── 3. pm2 ──
if ! command -v pm2 &>/dev/null; then
  echo "[3/8] Installing pm2..."
  npm install -g pm2
else
  echo "[3/8] pm2 already installed"
fi

# ── 4. PostgreSQL setup ──
echo "[4/8] Setting up PostgreSQL..."
systemctl enable postgresql
systemctl start postgresql

# Create user and DB if they don't exist
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD 'CHANGE_ME_TO_STRONG_PASSWORD';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
  sudo -u postgres createdb "$DB_NAME" -O "$DB_USER"

echo "    Database '$DB_NAME' ready"

# ── 5. Application directory ──
echo "[5/8] Setting up application..."
mkdir -p "$APP_DIR"

if [[ ! -d "$BACKEND_DIR/.git" ]]; then
  echo "    Cloning repository..."
  echo "    ⚠ Copy your project files to $APP_DIR or clone your repo:"
  echo "    git clone <your-repo-url> $APP_DIR"
  echo ""
  echo "    For now, assuming files are already in $BACKEND_DIR"
fi

# ── 6. Install dependencies & build ──
echo "[6/8] Installing dependencies & building..."
cd "$BACKEND_DIR"

if [[ ! -f ".env" ]]; then
  echo ""
  echo "  ⚠ No .env file found!"
  echo "  Copy .env.example and fill in your values:"
  echo "    cp .env.example .env"
  echo "    nano .env"
  echo ""
  echo "  Required values:"
  echo "    DATABASE_URL=postgresql://$DB_USER:YOUR_PASSWORD@localhost:5432/$DB_NAME"
  echo "    XUI_PANEL_ORIGIN=http://localhost:14365"
  echo "    XUI_WEB_BASE_PATH=your-secret-path"
  echo "    XUI_USERNAME=your-xui-admin"
  echo "    XUI_PASSWORD=your-xui-password"
  echo "    XUI_PUBLIC_HOST=vpn.yourdomain.com"
  echo "    TELEGRAM_BOT_TOKEN=your-bot-token"
  echo "    TELEGRAM_BOT_USERNAME=your_bot_username"
  echo ""
  echo "  Then re-run this script."
  exit 1
fi

npm ci --omit=dev
npm run build

# ── 7. Run migrations ──
echo "[7/8] Running database migrations..."
npx prisma migrate deploy
npx prisma generate

# ── 8. Start with pm2 ──
echo "[8/8] Starting backend with pm2..."
pm2 delete vpn-backend 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo ""
echo "========================================="
echo "  ✅ Deployment complete!"
echo "========================================="
echo ""
echo "  Backend running on port $(grep PORT .env | cut -d= -f2 || echo 3000)"
echo ""
echo "  Useful commands:"
echo "    pm2 status              — check process"
echo "    pm2 logs vpn-backend    — view logs"
echo "    pm2 restart vpn-backend — restart"
echo "    pm2 monit               — monitor CPU/memory"
echo ""
echo "  Next: deploy the reverse proxy on your Russian VPS"
echo "    scp proxy/setup-proxy.sh root@PROXY_IP:~/"
echo "    ssh root@PROXY_IP 'bash setup-proxy.sh $(hostname -I | awk \"{print \\$1}\")'"
echo ""
