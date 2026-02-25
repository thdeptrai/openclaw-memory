#!/bin/sh
# ============================================================
#  Memolo Reset Script — Wipe ALL data and rebuild from scratch
#
#  Usage: ./reset.sh
#
#  This will:
#   1. Stop all containers
#   2. Remove Docker volumes (PostgreSQL + Qdrant data)
#   3. Rebuild the Docker image (fresh dashboard + server build)
#   4. Start everything clean
# ============================================================

set -e

echo ""
echo "🗑️  MEMOLO FULL RESET"
echo "====================="
echo "This will DELETE all data (PostgreSQL, Qdrant) and rebuild."
echo ""

# Step 1: Stop containers and remove volumes
echo "📦 Stopping containers and removing volumes..."
docker compose down -v --remove-orphans 2>/dev/null || true

# Step 2: Remove old images to force fresh build
echo "🧹 Removing old memolo image..."
docker rmi memolo-memolo 2>/dev/null || true

# Step 3: Rebuild and start
echo "🔨 Rebuilding (dashboard + server)..."
docker compose build --no-cache

echo "🚀 Starting fresh..."
docker compose up -d

# Step 4: Wait for health
echo ""
echo "⏳ Waiting for services to be ready..."
sleep 8

# Check health
echo ""
echo "🏥 Health check:"
curl -s http://localhost:7437/api/health 2>/dev/null | head -c 500 || echo "  (server still starting...)"
echo ""
echo ""
echo "✅ Reset complete!"
echo "   Server:    http://localhost:7437"
echo "   Dashboard: http://localhost:3001"
echo ""
