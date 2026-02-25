# =============================================
# Memolo — Optimized Unified Docker Image
# Backend (Express :7437) + Dashboard (Next.js :3001)
#
# Optimizations:
#   - Next.js standalone mode (eliminates 800MB node_modules)
#   - Multi-stage build (build deps don't leak into final image)
#   - Minimal COPY layers
#   - Memory-efficient alpine base
# =============================================

# ---- Stage 1: Build Next.js dashboard ----
FROM node:20-alpine AS dashboard-build
WORKDIR /build
COPY dashboard/package*.json ./
RUN npm ci
COPY dashboard/ .
RUN npm run build

# ---- Stage 2: Production image ----
FROM node:20-alpine
WORKDIR /app

# Install server dependencies
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# Copy server source
COPY server/src/ ./server/src/
COPY server/migrations/ ./server/migrations/
COPY server/eval/ ./server/eval/
COPY server/start.sh ./server/

# Copy ONLY the standalone Next.js output (no full node_modules!)
COPY --from=dashboard-build /build/.next/standalone ./dashboard/
COPY --from=dashboard-build /build/.next/static ./dashboard/.next/static
COPY --from=dashboard-build /build/public ./dashboard/public

# Copy entrypoint
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh server/start.sh

EXPOSE 7437 3001

CMD ["sh", "entrypoint.sh"]
