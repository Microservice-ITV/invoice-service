# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

WORKDIR /var/www/html/invoice-service

# Puppeteer's managed Chrome needs these shared libraries; install runtime dependencies without the full Chromium package.
RUN sed -i 's#http://deb.debian.org/debian-security#http://ftp.de.debian.org/debian-security#; s#http://deb.debian.org/debian#http://ftp.de.debian.org/debian#' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=10 -o Acquire::http::Pipeline-Depth=0 -o Acquire::http::Timeout=60 update \
    && apt-get -o Acquire::Retries=10 -o Acquire::http::Pipeline-Depth=0 -o Acquire::http::Timeout=60 install -y --no-install-recommends \
    openssl \
    ca-certificates \
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
    && rm -rf /var/lib/apt/lists/* \
    && test -f /usr/lib/x86_64-linux-gnu/libglib-2.0.so.0

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_CACHE_DIR=/root/.cache/puppeteer

RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --prefer-offline --no-audit --no-fund --fetch-retries=10 --fetch-timeout=600000

RUN PUPPETEER_SKIP_DOWNLOAD=false npx puppeteer browsers install chrome \
    && test -d /root/.cache/puppeteer/chrome

COPY src ./src
COPY tsconfig.json ./

RUN npx prisma generate

RUN npm install -g nodemon ts-node

COPY docker/node/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

EXPOSE 5005

CMD ["npm", "run", "dev"]