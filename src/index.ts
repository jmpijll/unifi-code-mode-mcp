#!/usr/bin/env node
/**
 * UniFi Code-Mode MCP Server — entry point.
 *
 * Lifecycle:
 *   1. Validate env config (Zod).
 *   2. Pre-warm QuickJS WASM module.
 *   3. Try to load local OpenAPI spec (if env creds present) — non-fatal.
 *   4. Try to load cloud OpenAPI spec — non-fatal.
 *   5. Build MCP server with `search` + `execute` tools.
 *   6. Start the chosen transport (stdio or HTTP).
 *
 * In multi-user mode (HTTP without env creds), spec loading per request is
 * lazy and uses the credentials from the request headers.
 */

import { loadConfig, type AppConfig } from './config.js';
import { getQuickJSModule } from './sandbox/executor.js';
import { loadCloudSpec, loadLocalSpec, loadProtectSpec } from './spec/loader.js';
import { specSummary } from './spec/index.js';
import {
  buildContextFromEnv,
  buildContextFromHeaders,
  type TenantContext,
} from './tenant/context.js';
import { createMcpServer } from './server/server.js';
import { startHttpTransport, startStdioTransport } from './server/transport.js';
import { currentRequestScope } from './server/request-context.js';
import type { ProcessedSpec } from './types/spec.js';

const logger = {
  info: (msg: string, ...args: unknown[]): void => {
    console.error(`[INFO] ${msg}`, ...args);
  },
  warn: (msg: string, ...args: unknown[]): void => {
    console.error(`[WARN] ${msg}`, ...args);
  },
  error: (msg: string, ...args: unknown[]): void => {
    console.error(`[ERROR] ${msg}`, ...args);
  },
};

async function tryLoadLocalSpec(config: AppConfig): Promise<ProcessedSpec | undefined> {
  if (!config.unifiLocalBaseUrl || !config.unifiLocalApiKey) {
    if (config.mcpTransport === 'stdio') {
      logger.warn(
        'No local UniFi credentials in env; unifi.local.* will be unavailable in stdio mode.',
      );
    } else {
      logger.info(
        'No local UniFi credentials in env; multi-user mode will load spec lazily per request.',
      );
    }
    return undefined;
  }
  try {
    const spec = await loadLocalSpec({
      baseUrl: config.unifiLocalBaseUrl,
      apiKey: config.unifiLocalApiKey,
      ...(config.unifiLocalSpecUrl ? { specUrlOverride: config.unifiLocalSpecUrl } : {}),
      ...(config.unifiLocalInsecure !== undefined ? { insecure: config.unifiLocalInsecure } : {}),
      cacheDir: config.unifiSpecCacheDir,
    });
    const sum = specSummary(spec);
    logger.info(
      `Loaded local spec: ${sum.title} v${sum.version} (${String(sum.operationCount)} ops, ${String(sum.tagCount)} tags)`,
    );
    return spec;
  } catch (err) {
    logger.warn(
      `Failed to load local spec at startup (will retry per-request): ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

async function tryLoadCloudSpec(config: AppConfig): Promise<ProcessedSpec | undefined> {
  try {
    const spec = await loadCloudSpec({
      baseUrl: config.unifiCloudBaseUrl,
      cacheDir: config.unifiSpecCacheDir,
    });
    const sum = specSummary(spec);
    logger.info(
      `Loaded cloud spec: ${sum.title} v${sum.version} (${String(sum.operationCount)} ops, ${String(sum.tagCount)} tags)`,
    );
    return spec;
  } catch (err) {
    logger.warn(
      `Failed to load cloud spec: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

async function tryLoadProtectSpec(config: AppConfig): Promise<ProcessedSpec | undefined> {
  try {
    const spec = await loadProtectSpec({
      ...(config.unifiLocalBaseUrl ? { baseUrl: config.unifiLocalBaseUrl } : {}),
      ...(config.unifiLocalApiKey ? { apiKey: config.unifiLocalApiKey } : {}),
      ...(config.unifiLocalInsecure !== undefined ? { insecure: config.unifiLocalInsecure } : {}),
      ...(config.unifiProtectSpecUrl ? { specUrlOverride: config.unifiProtectSpecUrl } : {}),
      ...(config.unifiProtectAllowBeezlyFallback !== undefined
        ? { allowBeezlyFallback: config.unifiProtectAllowBeezlyFallback }
        : {}),
      cacheDir: config.unifiSpecCacheDir,
      onWarn: (msg: string) => {
        logger.warn(`[protect-spec] ${msg}`);
      },
    });
    const sum = specSummary(spec);
    logger.info(
      `Loaded Protect spec: ${sum.title} v${sum.version} (${String(sum.operationCount)} ops, ${String(sum.tagCount)} tags)`,
    );
    return spec;
  } catch (err) {
    logger.warn(
      `Failed to load Protect spec (Protect surfaces will be unavailable): ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

async function main(): Promise<void> {
  logger.info('UniFi Code-Mode MCP Server starting...');
  const config = loadConfig();
  logger.info(`Transport: ${config.mcpTransport}`);

  const wasmStart = Date.now();
  await getQuickJSModule();
  logger.info(`QuickJS WASM initialized in ${String(Date.now() - wasmStart)}ms`);

  const [localSpec, cloudSpec, protectSpec] = await Promise.all([
    tryLoadLocalSpec(config),
    tryLoadCloudSpec(config),
    tryLoadProtectSpec(config),
  ]);

  const tenantResolver = (): TenantContext => {
    const scope = currentRequestScope();
    if (scope) return buildContextFromHeaders(scope.headers);
    return buildContextFromEnv();
  };

  const server = createMcpServer({
    ...(localSpec ? { localSpec } : {}),
    ...(cloudSpec ? { cloudSpec } : {}),
    ...(protectSpec ? { protectSpec } : {}),
    tenantResolver,
    limits: { maxCallsPerExecute: config.unifiMaxCallsPerExecute },
    logger,
    name: 'unifi-code-mode-mcp',
    version: '0.1.0',
  });

  if (config.mcpTransport === 'stdio') {
    await startStdioTransport(server, logger);
  } else {
    await startHttpTransport(
      server,
      {
        port: config.mcpHttpPort,
        allowedOrigins: config.mcpHttpAllowedOrigins,
      },
      logger,
    );
  }
}

main().catch((err: unknown) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
