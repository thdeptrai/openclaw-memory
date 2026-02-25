#!/usr/bin/env bash
# ============================================================
#  Memolo — One-Command Setup
#  Usage: curl -sL <raw-url>/setup.sh | bash
#     or: ./setup.sh
#
#  This script will:
#    1. Check & install Docker (if missing)
#    2. Check & install Ollama (if missing, optional)
#    3. Pull required Ollama models
#    4. Generate .env with secure defaults
#    5. Build & start all services
#    6. Run migrations
#    7. Open dashboard
# ============================================================
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

log()  { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
err()  { echo -e "${RED}❌ $1${NC}"; }
info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
step() { echo -e "\n${CYAN}${BOLD}━━━ $1 ━━━${NC}\n"; }

# ============ DETECT OS ============
detect_os() {
    case "$(uname -s)" in
        Linux*)   OS="linux";;
        Darwin*)  OS="mac";;
        MINGW*|MSYS*|CYGWIN*) OS="windows";;
        *)        OS="unknown";;
    esac
    echo "$OS"
}

OS=$(detect_os)

echo -e "${BOLD}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║     🧠 Memolo Memory System Setup    ║"
echo "  ║     One-Command Installation         ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"
info "Detected OS: $OS"

# ============ STEP 1: DOCKER ============
step "Step 1/6: Checking Docker"

if command -v docker &> /dev/null; then
    DOCKER_VERSION=$(docker --version 2>/dev/null | head -1)
    log "Docker found: $DOCKER_VERSION"
else
    warn "Docker not found. Installing..."
    
    if [ "$OS" = "linux" ]; then
        # Install Docker on Linux (official script)
        curl -fsSL https://get.docker.com | sh
        sudo systemctl start docker
        sudo systemctl enable docker
        # Add current user to docker group
        sudo usermod -aG docker "$USER"
        log "Docker installed. You may need to log out and back in for group changes."
    elif [ "$OS" = "mac" ]; then
        if command -v brew &> /dev/null; then
            brew install --cask docker
            open /Applications/Docker.app
            echo "Waiting for Docker Desktop to start..."
            while ! docker info &>/dev/null; do sleep 2; done
        else
            err "Please install Docker Desktop from https://docker.com/products/docker-desktop"
            exit 1
        fi
    else
        err "Please install Docker Desktop from https://docker.com/products/docker-desktop"
        err "Then re-run this script."
        exit 1
    fi
fi

# Check Docker Compose
if docker compose version &> /dev/null; then
    log "Docker Compose: $(docker compose version --short 2>/dev/null || echo 'available')"
elif docker-compose --version &> /dev/null; then
    log "Docker Compose (legacy): $(docker-compose --version 2>/dev/null)"
    # Create alias
    docker_compose="docker-compose"
else
    warn "Docker Compose not found. Installing plugin..."
    if [ "$OS" = "linux" ]; then
        sudo apt-get update && sudo apt-get install -y docker-compose-plugin 2>/dev/null || \
        sudo yum install -y docker-compose-plugin 2>/dev/null || \
        (warn "Could not auto-install. Trying standalone..." && \
         sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose && \
         sudo chmod +x /usr/local/bin/docker-compose)
    fi
fi

# Use docker compose (v2) by default
COMPOSE_CMD="docker compose"
if ! $COMPOSE_CMD version &> /dev/null; then
    COMPOSE_CMD="docker-compose"
fi

# ============ STEP 2: LLM PROVIDER CHOICE ============
step "Step 2/6: LLM Provider Configuration"

echo ""
echo "  Choose your LLM provider:"
echo ""
echo "    1) MiniMax (Cloud) — recommended, fast, cheap (\$0.30/M tokens)"
echo "       Requires: API key from https://platform.minimax.io"
echo ""
echo "    2) Ollama (Local) — free, private, needs GPU (8GB+ VRAM)"
echo "       Will auto-install Ollama + download models (~8GB)"
echo ""
echo "    3) Both — MiniMax primary, Ollama as fallback"
echo ""

read -p "  Enter choice [1/2/3] (default: 1): " LLM_CHOICE
LLM_CHOICE=${LLM_CHOICE:-1}

MINIMAX_KEY=""
INSTALL_OLLAMA=false
LLM_PROVIDER="minimax"

case $LLM_CHOICE in
    1)
        LLM_PROVIDER="minimax"
        read -p "  Enter your MiniMax API key: " MINIMAX_KEY
        if [ -z "$MINIMAX_KEY" ]; then
            warn "No API key provided. You can add it later in .env"
            MINIMAX_KEY="your-minimax-api-key-here"
        fi
        ;;
    2)
        LLM_PROVIDER="ollama"
        INSTALL_OLLAMA=true
        ;;
    3)
        LLM_PROVIDER="minimax"
        INSTALL_OLLAMA=true
        read -p "  Enter your MiniMax API key: " MINIMAX_KEY
        if [ -z "$MINIMAX_KEY" ]; then
            MINIMAX_KEY="your-minimax-api-key-here"
        fi
        ;;
esac

# ============ STEP 3: OLLAMA (if needed) ============
if [ "$INSTALL_OLLAMA" = true ]; then
    step "Step 3/6: Setting up Ollama"
    
    if command -v ollama &> /dev/null; then
        log "Ollama found: $(ollama --version 2>/dev/null || echo 'installed')"
    else
        warn "Ollama not found. Installing..."
        
        if [ "$OS" = "linux" ]; then
            curl -fsSL https://ollama.ai/install.sh | sh
        elif [ "$OS" = "mac" ]; then
            if command -v brew &> /dev/null; then
                brew install ollama
            else
                curl -fsSL https://ollama.ai/install.sh | sh
            fi
        else
            err "Please install Ollama from https://ollama.com/download"
            err "Then re-run this script."
            exit 1
        fi
        log "Ollama installed"
    fi
    
    # Start Ollama service
    if ! curl -s http://localhost:11434/api/tags &>/dev/null; then
        info "Starting Ollama service..."
        ollama serve &>/dev/null &
        sleep 3
    fi
    
    # Pull required models
    info "Pulling embedding model (qwen3-embedding:8b)... this may take a while"
    ollama pull qwen3-embedding:8b
    log "Embedding model ready"
    
    info "Pulling chat model (qwen2.5:7b)..."
    ollama pull qwen2.5:7b
    log "Chat model ready"
else
    step "Step 3/6: Ollama (skipped — using MiniMax cloud)"
fi

# ============ STEP 4: GENERATE .ENV ============
step "Step 4/6: Generating configuration"

MASTER_KEY=$(openssl rand -hex 32 2>/dev/null || \
             python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null || \
             head -c 32 /dev/urandom | xxd -p 2>/dev/null || \
             echo "mk-memolo-$(date +%s)-$(shuf -i 1000-9999 -n 1 2>/dev/null || echo 'secure')")

if [ -f .env ]; then
    warn ".env already exists — backing up to .env.backup"
    cp .env .env.backup
fi

cat > .env << EOF
# ============================================================
#  Memolo Memory Server — Auto-generated Configuration
#  Generated: $(date)
# ============================================================

# === LLM Provider ===
LLM_PROVIDER=${LLM_PROVIDER}

# === MiniMax (Cloud LLM) ===
MINIMAX_API_KEY=${MINIMAX_KEY}
MINIMAX_MODEL=MiniMax-M2.5
MINIMAX_BASE_URL=https://api.minimax.io/anthropic/v1/messages

# === Ollama (Local LLM) ===
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_EMBED_MODEL=qwen3-embedding:8b
OLLAMA_CHAT_MODEL=qwen2.5:7b
OLLAMA_TIMEOUT=180000

# === Security ===
MEMOLO_MASTER_KEY=${MASTER_KEY}

# === Server ===
PORT=7437

# === Database (auto-managed by Docker) ===
PG_USER=memolo
PG_PASSWORD=$(openssl rand -hex 16 2>/dev/null || echo "memolo_secret")
PG_DATABASE=memolo

# === Memory Settings ===
SUMMARIZE_AFTER_EXCHANGES=5
EMBEDDING_DIMENSIONS=4096
EOF

log ".env created with secure random keys"

# ============ STEP 5: BUILD & START ============
step "Step 5/6: Building and starting services"

info "This will download Docker images and build the server (first time may take 2-5 minutes)..."

$COMPOSE_CMD up -d --build

# Wait for services to be healthy
info "Waiting for services to start..."
sleep 5

# Check health
MAX_RETRIES=30
RETRY=0
while [ $RETRY -lt $MAX_RETRIES ]; do
    if curl -s http://localhost:7437/api/health &>/dev/null; then
        break
    fi
    RETRY=$((RETRY + 1))
    sleep 2
done

if [ $RETRY -ge $MAX_RETRIES ]; then
    warn "Server taking longer than expected. Check: $COMPOSE_CMD logs memolo"
else
    log "All services running!"
fi

# ============ STEP 6: VERIFY ============
step "Step 6/6: Verification"

# Check each service
echo ""
if curl -s http://localhost:7437/api/health | grep -q "ok" 2>/dev/null; then
    log "Memolo API      → http://localhost:7437 ✓"
else
    warn "Memolo API      → not responding yet (may still be starting)"
fi

if docker exec memolo-postgres pg_isready -U memolo &>/dev/null; then
    log "PostgreSQL      → running ✓"
else
    warn "PostgreSQL      → checking..."
fi

if curl -s http://localhost:6333/collections &>/dev/null; then
    log "Qdrant Vector   → running ✓"
else
    # Qdrant port might not be exposed, check via docker
    if docker exec memolo-qdrant wget -qO- http://localhost:6333/collections &>/dev/null; then
        log "Qdrant Vector   → running (internal) ✓"
    else
        warn "Qdrant Vector   → checking..."
    fi
fi

if [ "$INSTALL_OLLAMA" = true ]; then
    if curl -s http://localhost:11434/api/tags &>/dev/null; then
        log "Ollama          → running ✓"
    else
        warn "Ollama          → not running (start with: ollama serve)"
    fi
fi

# ============ DONE ============
echo ""
echo -e "${BOLD}${GREEN}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║     🎉 Memolo Setup Complete!        ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"
echo ""
echo -e "  ${BOLD}Dashboard:${NC}    http://localhost:7437"
echo -e "  ${BOLD}API:${NC}          http://localhost:7437/api/health"
echo -e "  ${BOLD}Master Key:${NC}   ${MASTER_KEY:0:16}... (saved in .env)"
echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo "    $COMPOSE_CMD logs -f memolo    # View server logs"
echo "    $COMPOSE_CMD restart memolo    # Restart server"
echo "    $COMPOSE_CMD down              # Stop all services"
echo "    $COMPOSE_CMD up -d             # Start all services"
echo ""

if [ "$LLM_PROVIDER" = "minimax" ] && [ "$MINIMAX_KEY" = "your-minimax-api-key-here" ]; then
    echo -e "  ${YELLOW}⚠️  Don't forget to add your MiniMax API key in .env!${NC}"
    echo ""
fi

# Try to open browser
if [ "$OS" = "mac" ]; then
    open http://localhost:7437 2>/dev/null || true
elif [ "$OS" = "linux" ]; then
    xdg-open http://localhost:7437 2>/dev/null || true
fi
