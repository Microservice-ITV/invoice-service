# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

WORKDIR /var/www/html/invoice-service

# Runtime libraries required by Puppeteer's managed Chrome.
RUN apt-get -o Acquire::Retries=10 \
    -o Acquire::http::Timeout=60 \
    update \
    && apt-get -o Acquire::Retries=10 \
    -o Acquire::http::Timeout=60 \
    install -y --no-install-recommends \
    ca-certificates \
    openssl \
    libglib2.0-0 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxcb1 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests first for Docker layer caching.
COPY package.json package-lock.json ./

# Prisma configuration/schema.
COPY prisma ./prisma
COPY prisma.config.ts ./

# Install exact locked dependencies.
RUN --mount=type=cache,target=/root/.npm \
    npm ci \
    --ignore-scripts \
    --prefer-offline \
    --no-audit \
    --no-fund \
    --fetch-retries=10 \
    --fetch-timeout=600000

# Puppeteer uses its own managed Chrome installation.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_CACHE_DIR=/root/.cache/puppeteer

RUN PUPPETEER_SKIP_DOWNLOAD=false \
    npx puppeteer browsers install chrome \
    && test -d /root/.cache/puppeteer/chrome

# Copy application source after dependencies.
COPY src ./src
COPY src/assets/fonts ./assets/fonts
COPY tsconfig.json ./

# Generate Prisma Client.
RUN npx prisma generate

# Container startup script.
COPY docker/node/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 5005

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

CMD ["npm", "run", "dev"]