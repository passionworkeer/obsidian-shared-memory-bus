# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      python3 \
      python3-pip \
      python3-venv \
      python-is-python3 \
      tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies before copying the complete source tree so this
# layer remains cacheable. The root lockfile includes the shared-mcp workspace.
COPY package.json package-lock.json ./
COPY shared-mcp/package.json ./shared-mcp/package.json
RUN npm ci --omit=dev

COPY retrieval/requirements.txt ./retrieval/requirements.txt
RUN python3 -m venv /opt/yt-venv \
    && /opt/yt-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/yt-venv/bin/pip install --no-cache-dir -r retrieval/requirements.txt

COPY . .

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin app \
    && mkdir -p /data \
    && chown -R app:app /app /data

ENV PATH=/opt/yt-venv/bin:$PATH \
    NODE_ENV=production \
    AI_MEMORY_ROOT=/app \
    AI_MEMORY_STORE=/data \
    AI_MEMORY_PYTHON=/opt/yt-venv/bin/python \
    AI_MEMORY_EMBED_BACKEND=hash \
    AI_MEMORY_SERVER_MODE=split \
    AI_MEMORY_BIND_HOST=0.0.0.0

VOLUME ["/data"]

EXPOSE 9332 9333 9338 9339 9340 9341

USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://127.0.0.1:9338/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]
