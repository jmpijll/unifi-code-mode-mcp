/**
 * Top-level config loader. All env vars validated through Zod.
 */

import { resolve } from 'node:path';
import { z } from 'zod';

const configSchema = z.object({
  // Transport
  mcpTransport: z.enum(['stdio', 'http']).default('stdio'),
  mcpHttpPort: z.coerce.number().int().min(1).max(65535).default(8000),
  mcpHttpAllowedOrigins: z
    .string()
    .default('http://localhost,http://127.0.0.1')
    .transform((s) =>
      s
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0),
    ),

  // Local UniFi
  unifiLocalBaseUrl: z.string().optional(),
  unifiLocalApiKey: z.string().optional(),
  unifiLocalCaCertPath: z.string().optional(),
  unifiLocalInsecure: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : ['true', '1', 'yes'].includes(v.toLowerCase()))),

  // Cloud UniFi
  unifiCloudBaseUrl: z.string().default('https://api.ui.com'),
  unifiCloudApiKey: z.string().optional(),

  // Spec loading
  unifiLocalSpecUrl: z.string().optional(),
  unifiSpecCacheDir: z
    .string()
    .default('./src/spec/cache')
    .transform((p) => resolve(p)),

  // Sandbox
  unifiMaxCallsPerExecute: z.coerce.number().int().min(1).max(1000).default(50),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse({
    mcpTransport: env['MCP_TRANSPORT'],
    mcpHttpPort: env['MCP_HTTP_PORT'],
    mcpHttpAllowedOrigins: env['MCP_HTTP_ALLOWED_ORIGINS'],

    unifiLocalBaseUrl: env['UNIFI_LOCAL_BASE_URL'],
    unifiLocalApiKey: env['UNIFI_LOCAL_API_KEY'],
    unifiLocalCaCertPath: env['UNIFI_LOCAL_CA_CERT_PATH'],
    unifiLocalInsecure: env['UNIFI_LOCAL_INSECURE'],

    unifiCloudBaseUrl: env['UNIFI_CLOUD_BASE_URL'],
    unifiCloudApiKey: env['UNIFI_CLOUD_API_KEY'],

    unifiLocalSpecUrl: env['UNIFI_LOCAL_SPEC_URL'],
    unifiSpecCacheDir: env['UNIFI_SPEC_CACHE_DIR'],

    unifiMaxCallsPerExecute: env['UNIFI_MAX_CALLS_PER_EXECUTE'],
  });

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${issues}`);
  }
  return result.data;
}
