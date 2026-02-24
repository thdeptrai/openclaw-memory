FROM node:18-alpine

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY public/ ./public/
COPY start.sh ./

# Make start script executable
RUN chmod +x start.sh

EXPOSE 7437

CMD ["sh", "start.sh"]
