#!/bin/bash
set -e

echo "📥 Pulling latest changes from Git..."
git pull origin master

echo ""
echo "🔨 Rebuilding Memolo image..."
docker compose up -d --build memolo

echo ""
echo "🧹 Cleaning up old images..."
docker image prune -f

echo ""
echo "✅ Memolo updated successfully!"
echo "   API:       http://localhost:${PORT:-7437}"
echo "   Dashboard: http://localhost:${DASHBOARD_PORT:-3001}"
echo ""
echo "📋 Logs: docker compose logs -f memolo"
