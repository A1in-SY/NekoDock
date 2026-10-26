FROM ghcr.io/astral-sh/uv:0.13.5 AS uv

FROM node:24.16.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24.16.0-bookworm-slim
ARG PLAYWRIGHT_VERSION=1.64.1
ARG EDGE_TTS_VERSION=7.3.1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
COPY --from=uv /uv /uvx /usr/local/bin/
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates git ripgrep \
        python3 python3-venv python-is-python3 python3-pip python3-pil \
        curl jq file zip unzip xz-utils zstd sqlite3 procps \
        fonts-noto-cjk fontconfig iproute2 dnsutils netcat-openbsd \
    && python3 -m venv /opt/edge-tts \
    && /opt/edge-tts/bin/pip install --no-cache-dir "edge-tts==${EDGE_TTS_VERSION}" \
    && ln -s /opt/edge-tts/bin/edge-tts /usr/local/bin/edge-tts \
    && edge-tts --version \
    && npm install --global playwright@${PLAYWRIGHT_VERSION} \
    && playwright install --with-deps chromium \
    && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}" \
    # Resolve both ESM imports and CommonJS requires from persistent workspaces.
    && mkdir -p /node_modules \
    && ln -s /usr/local/lib/node_modules/playwright /node_modules/playwright \
    && rm -rf /var/lib/apt/lists/* \
    && npm cache clean --force \
    && mkdir -p /data/pi /data/workspace \
    && chown -R node:node /data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY prompts ./prompts
ENV NODE_ENV=production DATA_DIR=/data AGENT_HOME=/data/pi AGENT_WORKSPACE=/data/workspace
USER node
VOLUME ["/data"]
CMD ["node", "dist/src/main.js"]
