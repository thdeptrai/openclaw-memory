#!/bin/sh
set -e

echo "⏳ Waiting for PostgreSQL..."
until node -e "
const { Pool } = require('pg');
const p = new Pool({ host: process.env.PG_HOST || 'postgres', port: parseInt(process.env.PG_PORT || '5432'), user: process.env.PG_USER || 'memolo', password: process.env.PG_PASSWORD || 'memolo_secret', database: process.env.PG_DATABASE || 'memolo' });
p.query('SELECT 1').then(() => { p.end(); process.exit(0); }).catch(() => { p.end(); process.exit(1); });
" 2>/dev/null; do
    echo "  PostgreSQL not ready, retrying in 2s..."
    sleep 2
done
echo "✅ PostgreSQL is ready"

echo "⏳ Waiting for Qdrant..."
QDRANT_HOST="${QDRANT_HOST:-qdrant}"
QDRANT_PORT="${QDRANT_PORT:-6333}"
until node -e "
fetch('http://${QDRANT_HOST}:${QDRANT_PORT}/healthz').then(r => { if(r.ok) process.exit(0); else process.exit(1); }).catch(() => process.exit(1));
" 2>/dev/null; do
    echo "  Qdrant not ready, retrying in 2s..."
    sleep 2
done
echo "✅ Qdrant is ready"

echo "🔄 Running migrations..."
node src/migrate.js

echo "🚀 Starting Memolo server..."
exec node src/index.js
