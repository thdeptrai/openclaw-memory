#!/bin/bash
# ============================================================
# Memolo Plugin Installer for OpenClaw
# Usage: curl -sL https://raw.githubusercontent.com/thdeptrai/openclaw-memory/master/scripts/install-plugin.sh | bash
# ============================================================

set -e

REPO="thdeptrai/openclaw-memory"
BRANCH="master"
PLUGIN_DIR="/tmp/memolo-plugin-$$"

echo "🔑 Memolo Plugin Installer"
echo "=========================="

# Download plugin files from GitHub
echo "📥 Downloading plugin from github.com/$REPO..."
mkdir -p "$PLUGIN_DIR"
curl -sL "https://github.com/$REPO/archive/$BRANCH.tar.gz" | tar xz -C "$PLUGIN_DIR" --strip-components=2 "openclaw-memory-$BRANCH/plugin"

if [ ! -f "$PLUGIN_DIR/openclaw.plugin.json" ]; then
    echo "❌ Failed to download plugin files"
    rm -rf "$PLUGIN_DIR"
    exit 1
fi

echo "✅ Downloaded to $PLUGIN_DIR"

# Install dependencies
echo "📦 Installing dependencies..."
cd "$PLUGIN_DIR"
npm install --production --silent
cd - > /dev/null

# Install via OpenClaw CLI
echo "📦 Installing plugin..."
openclaw plugins install -l "$PLUGIN_DIR"

# Cleanup
rm -rf "$PLUGIN_DIR"
echo "🎉 Done! Configure the plugin in OpenClaw settings."
