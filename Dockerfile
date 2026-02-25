# =============================================
# Memolo — Unified Docker Image
# Backend (Express :7437) + Dashboard (Next.js :3001)
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
COPY server/start.sh ./server/

# Copy dashboard production build from stage 1
COPY --from=dashboard-build /build/.next ./dashboard/.next
COPY --from=dashboard-build /build/public ./dashboard/public
COPY --from=dashboard-build /build/node_modules ./dashboard/node_modules
COPY dashboard/package.json ./dashboard/
COPY dashboard/next.config.ts ./dashboard/

# Copy entrypoint
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh server/start.sh

EXPOSE 7437 3001

CMD ["sh", "entrypoint.sh"]
