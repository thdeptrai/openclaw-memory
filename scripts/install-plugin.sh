#!/bin/bash
# ============================================================
# Memolo Plugin Installer for OpenClaw
# Usage: curl -sL https://raw.githubusercontent.com/thdeptrai/memolo/master/scripts/install-plugin.sh | bash
# ============================================================

set -e

REPO="thdeptrai/memolo"
BRANCH="master"
INSTALL_DIR="extensions/memolo"

echo "🔑 Memolo Plugin Installer"
echo "=========================="

# Clean previous install
if [ -d "$INSTALL_DIR" ]; then
    echo "🔄 Removing previous install..."
    rm -rf "$INSTALL_DIR"
fi

# Download plugin files from GitHub
echo "📥 Downloading plugin from github.com/$REPO..."
mkdir -p "$INSTALL_DIR"
curl -sL "https://github.com/$REPO/archive/$BRANCH.tar.gz" | tar xz -C "$INSTALL_DIR" --strip-components=2 "memolo-$BRANCH/plugin"

if [ ! -f "$INSTALL_DIR/openclaw.plugin.json" ]; then
    echo "❌ Failed to download plugin files"
    rm -rf "$INSTALL_DIR"
    exit 1
fi

# Install dependencies
echo "📦 Installing dependencies..."
cd "$INSTALL_DIR"
npm install --production --silent
cd - > /dev/null

echo "✅ Plugin installed to $INSTALL_DIR"

# Install via OpenClaw CLI
echo "📦 Registering with OpenClaw..."
openclaw plugins install -l "$INSTALL_DIR"

echo ""
echo "🎉 Done! Plugin installed at: $INSTALL_DIR"
echo "💡 To update later, just re-run this script."
