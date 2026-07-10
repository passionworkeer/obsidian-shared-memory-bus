# =============================================================================
# Dockerfile — yt
# =============================================================================
# Multi-stage build: base (Python retrieval) + Node MCP server
# Usage:
#   docker build -t yt-memory-bus .
#   docker run --rm -v ~/.ai-memory:/root/.ai-memory -p 9338:9338 \
#     -e AI_MEMORY_ROOT=/root/.ai-memory yt-memory-bus
# =============================================================================

FROM python:3.12-slim AS python-deps

WORKDIR /app
# S-HIGH-4: 不再吞错。requirements.txt 必须存在,缺则构建失败。
COPY retrieval/requirements.txt retrieval/requirements.txt

# Install Python retrieval dependencies (no GPU needed for hash/BM25 embeddings)
# S-HIGH-4: 移除 || true;若 uv 不可用则 fallback 到 pip
RUN pip install --no-cache-dir uv || pip install --no-cache-dir numpy scikit-learn scipy pandas

FROM python:3.12-slim

WORKDIR /app

# Install Node.js (lts version via package manager)
RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy Python retrieval engine
COPY retrieval/ /app/retrieval/
COPY bus/generate-embeddings.js /app/bus/
COPY bus/bm25.js /app/bus/
COPY bus/lsh-hash.js /app/bus/
COPY ops/ /app/ops/

# Copy Node MCP server
COPY shared-mcp/ /app/shared-mcp/
COPY package.json package.json start.js /app/

WORKDIR /app

# Install Node dependencies
# S-HIGH-4: 不再 || true;npm install 失败应让构建失败
RUN npm install --omit=dev

# Create non-root user and grant ownership of writable paths.
# python:3.12-slim is Debian-based -> useradd (not alpine adduser).
RUN useradd -r -u 10001 -m -d /home/app app \
    && mkdir -p /home/app/.ai-memory \
    && chown -R app:app /app /home/app

# Default env (container paths under the non-root user's writable home)
ENV AI_MEMORY_ROOT=/home/app/.ai-memory
ENV AI_MEMORY_EMBED_BACKEND=hash
ENV AI_MEMORY_STORE=/home/app/.ai-memory

EXPOSE 9338

# Drop root privileges for the runtime process
USER app

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://127.0.0.1:9338/healthz || exit 1

# Run the MCP memory server
CMD ["node", "--experimental-default-type=module", "shared-mcp/omni-memory-server.js"]