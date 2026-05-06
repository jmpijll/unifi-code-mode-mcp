/**
 * MCP transport layer — stdio (single-user) and Streamable HTTP (multi-user).
 *
 * The HTTP transport extracts `X-Unifi-*` headers from each incoming request,
 * attaches them to an AsyncLocalStorage scope, and delegates to
 * StreamableHTTPServerTransport. Tool handlers (via tenantResolver) read the
 * scope to build a per-request TenantContext.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requestStore } from './request-context.js';

interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export interface HttpTransportConfig {
  port: number;
  /** Allowed origins (comma-separated). "*" disables the check. */
  allowedOrigins: string[];
  /** Per-IP requests-per-minute limit. */
  rateLimitPerMinute?: number;
}

// ─── Stdio ──────────────────────────────────────────────────────────

export async function startStdioTransport(server: McpServer, logger: Logger): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP server listening on stdio');

  const shutdown = (): void => {
    logger.info('Shutting down stdio transport...');
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// ─── HTTP ───────────────────────────────────────────────────────────

class RateLimiter {
  private readonly windows: Map<string, number[]> = new Map();
  constructor(private readonly windowMs: number, private readonly maxRequests: number) {}

  allow(ip: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.windows.get(ip);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(ip, timestamps);
    }
    while (timestamps.length > 0 && timestamps[0]! < cutoff) timestamps.shift();
    if (timestamps.length >= this.maxRequests) return false;
    timestamps.push(now);
    return true;
  }

  cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [ip, ts] of this.windows) {
      while (ts.length > 0 && ts[0]! < cutoff) ts.shift();
      if (ts.length === 0) this.windows.delete(ip);
    }
  }
}

interface HttpStats {
  totalRequests: number;
  mcpRequests: number;
  healthRequests: number;
  rateLimited: number;
  errors: number;
  startedAt: string;
}

export async function startHttpTransport(
  server: McpServer,
  config: HttpTransportConfig,
  logger: Logger,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const stats: HttpStats = {
    totalRequests: 0,
    mcpRequests: 0,
    healthRequests: 0,
    rateLimited: 0,
    errors: 0,
    startedAt: new Date().toISOString(),
  };

  const rateLimiter = new RateLimiter(60_000, config.rateLimitPerMinute ?? 60);
  const cleanupInterval = setInterval(() => rateLimiter.cleanup(), 300_000);
  cleanupInterval.unref();

  await server.connect(transport);

  const httpServer = createServer((req, res) => {
    void handleRequest(req, res, transport, stats, rateLimiter, config, logger);
  });

  httpServer.listen(config.port, () => {
    logger.info(`MCP HTTP server listening on port ${String(config.port)}`);
    logger.info(`  Health:  http://localhost:${String(config.port)}/health`);
    logger.info(`  MCP:     http://localhost:${String(config.port)}/mcp`);
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down HTTP server...');
    clearInterval(cleanupInterval);
    httpServer.close();
    void transport.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transport: StreamableHTTPServerTransport,
  stats: HttpStats,
  rateLimiter: RateLimiter,
  config: HttpTransportConfig,
  logger: Logger,
): Promise<void> {
  const startTime = Date.now();
  const clientIp = getClientIp(req);
  stats.totalRequests++;

  try {
    const url = req.url ?? '/';

    if (url === '/health' && req.method === 'GET') {
      stats.healthRequests++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          uptimeSec: Math.floor((Date.now() - new Date(stats.startedAt).getTime()) / 1000),
          stats: {
            totalRequests: stats.totalRequests,
            mcpRequests: stats.mcpRequests,
            rateLimited: stats.rateLimited,
            errors: stats.errors,
          },
        }),
      );
      return;
    }

    if (url !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (!isOriginAllowed(req, config.allowedOrigins)) {
      stats.errors++;
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden origin' }));
      return;
    }

    if (!rateLimiter.allow(clientIp)) {
      stats.rateLimited++;
      logger.info(`Rate limited: ${clientIp} ${req.method ?? 'UNKNOWN'} ${url}`);
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'Too many requests. Limit: 60/min.' }));
      return;
    }

    stats.mcpRequests++;
    logger.info(`MCP ${req.method ?? 'UNKNOWN'} from ${clientIp}`);

    await requestStore.run(
      { headers: req.headers, clientIp },
      async () => transport.handleRequest(req, res),
    );
    logger.info(`MCP ${req.method ?? 'UNKNOWN'} completed in ${String(Date.now() - startTime)}ms`);
  } catch (err) {
    stats.errors++;
    logger.error('HTTP handler error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() ?? 'unknown';
  if (Array.isArray(forwarded)) return forwarded[0]?.split(',')[0]?.trim() ?? 'unknown';
  return req.socket.remoteAddress ?? 'unknown';
}

function isOriginAllowed(req: IncomingMessage, allowedOrigins: string[]): boolean {
  if (allowedOrigins.includes('*')) return true;
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser clients (curl, MCP CLI) typically omit Origin.
  if (typeof origin !== 'string') return false;
  return allowedOrigins.some((allowed) => origin.startsWith(allowed));
}
