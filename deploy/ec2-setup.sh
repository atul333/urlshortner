#!/usr/bin/env bash
# Single-EC2 Ubuntu 24.04 Setup Script for SocialAdLinker
# Installs Node.js 22, PostgreSQL, Nginx, Certbot, PM2, and configures daily DB backups.
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/socialadlinker}"
DB_NAME="socialadlinker"
DB_USER="socialadlinker"

echo "==> Installing system packages (PostgreSQL, Nginx, Certbot, Git)..."
sudo apt-get update
sudo apt-get install -y curl git nginx certbot python3-certbot-nginx postgresql postgresql-contrib ufw

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d 'v')" -lt 22 ]]; then
  echo "==> Installing Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "==> Installing PM2..."
  sudo npm install -g pm2
fi

echo "==> Configuring UFW Firewall (SSH 22, HTTP 80, HTTPS 443)..."
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable

echo "==> Ensuring PostgreSQL is running..."
sudo systemctl enable postgresql
sudo systemctl start postgresql

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
  DB_PASS="$(openssl rand -hex 20)"
  sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';"
  sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
  echo "----------------------------------------------------------------"
  echo "Created PostgreSQL database '${DB_NAME}' and user '${DB_USER}'."
  echo "SAVE THIS DATABASE URL FOR YOUR .env FILE:"
  echo "DATABASE_URL=postgres://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}"
  echo "DATABASE_SSL=false"
  echo "----------------------------------------------------------------"
else
  echo "PostgreSQL user '${DB_USER}' already exists."
fi

echo "==> Setting up daily PostgreSQL backup cron in /var/backups/socialadlinker..."
sudo mkdir -p /var/backups/socialadlinker
sudo chown postgres:postgres /var/backups/socialadlinker
cat << 'CRON' | sudo tee /etc/cron.d/socialadlinker-backup >/dev/null
0 3 * * * postgres pg_dump socialadlinker | gzip > /var/backups/socialadlinker/socialadlinker_$(date +\%F).sql.gz && find /var/backups/socialadlinker -type f -mtime +14 -delete
CRON

echo "==> Preparing app directory ${APP_DIR}..."
sudo mkdir -p "${APP_DIR}"
sudo chown -R "$USER":"$USER" "${APP_DIR}"

echo "EC2 system setup complete!"

