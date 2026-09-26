# Dockerfile for Git at Any Scale (Single-Host EC2 Deployment)
FROM oven/bun:1.2-alpine

# Install native Git (required for git http-backend and packfile operations)
RUN apk add --no-cache git bash

WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Copy application source code
COPY . .

# Set persistent repository cache directory
ENV GIT_DATA_DIR=/var/git-data/repos
ENV PORT=3000
RUN mkdir -p /var/git-data/repos

EXPOSE 3000

# Start Git Smart HTTP server daemon
CMD ["bun", "run", "src/server/git-http-server.ts"]
