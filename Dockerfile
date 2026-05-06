# ─── Stage 1: Build ──────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ─── Stage 2: Production ────────────────────────────────────────────
FROM node:22-alpine AS production

LABEL org.opencontainers.image.source="https://github.com/jmpijll/unifi-code-mode-mcp"
LABEL org.opencontainers.image.description="UniFi Code-Mode MCP Server — search + execute tools with QuickJS WASM sandbox"
LABEL org.opencontainers.image.licenses="MIT"

RUN addgroup -S mcp && adduser -S mcp -G mcp

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist/ ./dist/

USER mcp

ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8000/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]
