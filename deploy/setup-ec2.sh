#!/usr/bin/env bash
# ==============================================================================
# One-Click Setup Script for AWS EC2 (Single-Host Git at Any Scale)
# Tested on Ubuntu 22.04/24.04 LTS and Amazon Linux 2023
# ==============================================================================

set -euo pipefail

echo "================================================================================"
echo " 🚀 Bootstrapping Git at Any Scale on EC2 Host"
echo "================================================================================"

# 1. Update OS packages and install Git
if [ -f /etc/debian_version ]; then
  echo "--> Detected Debian/Ubuntu. Installing dependencies..."
  sudo apt-get update -y
  sudo apt-get install -y git curl unzip ca-certificates
elif [ -f /etc/amazon-linux-release ] || [ -f /etc/redhat-release ]; then
  echo "--> Detected Amazon Linux / RHEL. Installing dependencies..."
  sudo dnf update -y
  sudo dnf install -y git curl unzip ca-certificates
fi

# 2. Install Bun runtime
if ! command -v bun &> /dev/null; then
  echo "--> Installing Bun runtime..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.bashrc"
fi

# 3. Create persistent repository cache directory
sudo mkdir -p /var/git-data/repos
sudo chown -R "$USER":"$USER" /var/git-data

# 4. Clone or pull latest code
APP_DIR="$HOME/git-at-any-scale"
if [ ! -d "$APP_DIR" ]; then
  echo "--> Cloning git-at-any-scale..."
  git clone https://github.com/MilanGohel/git-at-any-scale.git "$APP_DIR"
else
  echo "--> Updating git-at-any-scale..."
  cd "$APP_DIR" && git pull origin main
fi

cd "$APP_DIR"
$HOME/.bun/bin/bun install

# 5. Create systemd service
SERVICE_PATH="/etc/systemd/system/git-at-any-scale.service"
echo "--> Creating systemd service at $SERVICE_PATH..."

sudo tee "$SERVICE_PATH" > /dev/null <<EOF
[Unit]
Description=Git at Any Scale HTTP Server Daemon
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
EnvironmentFile=-$APP_DIR/.env
Environment=PORT=3000
Environment=GIT_DATA_DIR=/var/git-data/repos
ExecStart=$HOME/.bun/bin/bun run src/server/git-http-server.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable git-at-any-scale
sudo systemctl restart git-at-any-scale

echo ""
echo "================================================================================"
echo " 🎉 SETUP COMPLETE! Service is running on port 3000."
echo " Check status with: sudo systemctl status git-at-any-scale"
echo " View logs with:    sudo journalctl -u git-at-any-scale -f"
echo "================================================================================"
