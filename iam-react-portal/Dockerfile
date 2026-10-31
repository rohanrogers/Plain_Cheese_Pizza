# ─────────────────────────────────────────────────────────────────────────────
# Brightloop IAM React Portal — Docker Image
# Stage 1 (builder): Ubuntu 22.04 + Node 20 → TypeCheck + Vite build
# Stage 2 (serve):   Ubuntu 22.04 + nginx   → Serve static dist/
# ─────────────────────────────────────────────────────────────────────────────

# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM ubuntu:22.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# Copy source (tsconfig lives here)
COPY tsconfig.json ./
COPY src/ ./src/
COPY index.html ./

# TypeScript type check — fail the build if types are wrong
RUN npm run typecheck

# Production Vite build
RUN npm run build

# ─── Stage 2: Serve ───────────────────────────────────────────────────────────
FROM ubuntu:22.04 AS serve

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        nginx \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy built assets from builder
COPY --from=builder /app/dist /var/www/html

# nginx config: SPA routing — all paths serve index.html
RUN printf 'server {\n\
    listen 80;\n\
    root /var/www/html;\n\
    index index.html;\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
}\n' > /etc/nginx/sites-available/default

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]

