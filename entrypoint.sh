#!/bin/sh
set -e

echo "============================================="
echo "  Memolo — Starting all services"
echo "============================================="

# 1. Wait for dependencies + run migrations + start backend server
echo ""
echo "🔧 Starting backend server..."
cd /app/server
sh start.sh &
SERVER_PID=$!

# 2. Wait for server to be ready before starting dashboard
echo ""
echo "⏳ Waiting for backend to be ready..."
until node -e "fetch('http://localhost:${PORT:-7437}/api/health').then(r => { if(r.ok) process.exit(0); else process.exit(1); }).catch(() => process.exit(1));" 2>/dev/null; do
    sleep 1
done
echo "✅ Backend is ready"

# 3. Start Next.js dashboard
echo ""
echo "🖥️  Starting dashboard..."
cd /app/dashboard
NODE_ENV=production npx next start -p ${DASHBOARD_PORT:-3001} &
DASHBOARD_PID=$!

echo ""
echo "============================================="
echo "  ✅ Memolo is running!"
echo "  API:       http://localhost:${PORT:-7437}"
echo "  Dashboard: http://localhost:${DASHBOARD_PORT:-3001}"
echo "============================================="

# 4. Wait for either process to exit
wait -n $SERVER_PID $DASHBOARD_PID
EXIT_CODE=$?

# If one died, kill the other
kill $SERVER_PID $DASHBOARD_PID 2>/dev/null || true
exit $EXIT_CODE
