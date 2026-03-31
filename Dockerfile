# Stage 1: Build Dashboard Frontend
FROM node:20-alpine AS dashboard-builder
WORKDIR /app/dashboard
COPY dashboard/package*.json ./
RUN npm install --legacy-peer-deps
COPY dashboard/ ./
RUN npm run build

# Stage 2: Build Backend & Final Image
FROM node:20-alpine
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --legacy-peer-deps

# Copy source and other files
COPY . .

# Copy built dashboard from stage 1
COPY --from=dashboard-builder /app/dashboard/dist ./dashboard/dist

# Build the TypeScript code
RUN npm run build

# Default environment variables
ENV PORT=3000
ENV REDIS_URL=redis://redis:6379
ENV NODE_ENV=production

# Expose the API port
EXPOSE 3000

# Entrypoint will be decided by docker-compose commands
CMD ["node", "dist/server.js"]
