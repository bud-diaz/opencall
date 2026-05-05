#!/bin/bash
# ============================================================
# Pearl Crew — Ubuntu Install Script
# Run once on your mini PC to set everything up from scratch
# Usage: bash install.sh
# ============================================================

set -e  # exit on any error

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
RESET="\033[0m"

info()    { echo -e "${GREEN}[✓]${RESET} $1"; }
warn()    { echo -e "${YELLOW}[!]${RESET} $1"; }
error()   { echo -e "${RED}[✗]${RESET} $1"; exit 1; }
section() { echo -e "\n${BOLD}━━━ $1 ━━━${RESET}"; }

# ── 0. Confirm we're on Ubuntu ────────────────────────────────────────────────
section "System Check"
if ! command -v apt &>/dev/null; then
    error "This script is for Ubuntu/Debian systems only."
fi
info "Ubuntu detected"

# ── 1. System dependencies ────────────────────────────────────────────────────
section "System Dependencies"
sudo apt update -qq
sudo apt install -y python3 python3-pip python3-venv curl git
info "System packages installed"

# ── 2. Ollama ────────────────────────────────────────────────────────────────
section "Ollama"
if command -v ollama &>/dev/null; then
    info "Ollama already installed ($(ollama --version))"
else
    warn "Installing Ollama..."
    curl -fsSL https://ollama.com/install.sh | sh
    info "Ollama installed"
fi

# Start Ollama service if not running
if ! systemctl is-active --quiet ollama 2>/dev/null; then
    warn "Starting Ollama service..."
    sudo systemctl enable ollama
    sudo systemctl start ollama
    sleep 2
fi
info "Ollama service running"

# ── 3. Pull models ────────────────────────────────────────────────────────────
section "Pulling Ollama Models"

pull_model() {
    local model=$1
    if ollama list | grep -q "^${model}"; then
        info "Model '${model}' already present"
    else
        warn "Pulling ${model} (this may take a while)..."
        ollama pull "$model"
        info "Model '${model}' ready"
    fi
}

pull_model "dolphin3"
pull_model "dolphin-mistral"

# ── 4. Python virtual environment ────────────────────────────────────────────
section "Python Environment"
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$INSTALL_DIR/.venv" ]; then
    python3 -m venv "$INSTALL_DIR/.venv"
    info "Virtual environment created"
else
    info "Virtual environment already exists"
fi

source "$INSTALL_DIR/.venv/bin/activate"
pip install --upgrade pip -q
pip install -r "$INSTALL_DIR/requirements.txt" -q
info "Python dependencies installed"

# ── 5. Workspace and data directories ────────────────────────────────────────
section "Directory Setup"
mkdir -p "$INSTALL_DIR/workspace"
mkdir -p "$INSTALL_DIR/data/history"
info "workspace/ and data/history/ created"

# ── 6. Environment file ───────────────────────────────────────────────────────
section "Environment Config"
if [ -f "$INSTALL_DIR/.env" ]; then
    info ".env already exists — skipping"
else
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
    warn ".env created from template"
    warn "ACTION REQUIRED: Open .env and paste your Discord bot token:"
    warn "  nano $INSTALL_DIR/.env"
fi

# ── 7. Systemd service ────────────────────────────────────────────────────────
section "Systemd Service"
SERVICE_FILE="/etc/systemd/system/pearl-crew.service"
CURRENT_USER=$(whoami)
VENV_PYTHON="$INSTALL_DIR/.venv/bin/python3"

sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Pearl Crew Discord Multi-Agent Bot
After=network.target ollama.service
Wants=ollama.service

[Service]
Type=simple
User=${CURRENT_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=${VENV_PYTHON} ${INSTALL_DIR}/bot.py
Restart=on-failure
RestartSec=5
EnvironmentFile=${INSTALL_DIR}/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
info "Systemd service installed at $SERVICE_FILE"

# ── 8. Summary ────────────────────────────────────────────────────────────────
section "Setup Complete"

echo ""
echo -e "${BOLD}Pearl Crew is ready. Here's what to do next:${RESET}"
echo ""
echo -e "  1. ${YELLOW}Add your Discord token:${RESET}"
echo -e "     nano $INSTALL_DIR/.env"
echo ""
echo -e "  2. ${YELLOW}Create these channels in your Discord server:${RESET}"
echo -e "     #pearl  #corey  #midas  #rain  #levy  #hub"
echo ""
echo -e "  3. ${YELLOW}Start the bot:${RESET}"
echo -e "     sudo systemctl start pearl-crew"
echo ""
echo -e "  4. ${YELLOW}Check it's running:${RESET}"
echo -e "     sudo systemctl status pearl-crew"
echo ""
echo -e "  5. ${YELLOW}Watch live logs:${RESET}"
echo -e "     journalctl -u pearl-crew -f"
echo ""
echo -e "  6. ${YELLOW}Enable auto-start on reboot:${RESET}"
echo -e "     sudo systemctl enable pearl-crew"
echo ""
echo -e "  ${YELLOW}Models assigned:${RESET}"
echo -e "     Pearl, Corey, Midas, Levy → dolphin3"
echo -e "     Rain                      → dolphin-mistral"
echo ""
echo -e "  ${YELLOW}Hot-swap a model anytime in Discord:${RESET}"
echo -e "     !crew model rain dolphin3"
echo ""
