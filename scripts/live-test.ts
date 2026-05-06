#!/usr/bin/env tsx
/**
 * Live smoke test against a real UniFi controller.
 *
 * READ-ONLY. Calls a small set of safe endpoints (`/v1/info`, `/v1/sites`,
 * `/v1/sites/{siteId}/devices`) and prints the results. No mutations.
 *
 * Credentials:
 *   - Default: pulls API key from 1Password via the `op` CLI. Configure the
 *     reference at the top of this file or via OP_REF env var.
 *   - Override via env: UNIFI_LOCAL_BASE_URL, UNIFI_LOCAL_API_KEY,
 *     UNIFI_LOCAL_INSECURE, UNIFI_LOCAL_CA_CERT_PATH.
 *
 * Run:
 *   npm run live-test
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLocalClient } from '../src/client/local.js';
import { loadLocalSpec } from '../src/spec/loader.js';
import { specSummary } from '../src/spec/index.js';
import { ExecuteExecutor } from '../src/sandbox/execute-executor.js';
import { buildContextFromEnv } from '../src/tenant/context.js';

// 1Password reference — adjust to match your vault entry layout.
//   op://<vault>/<item>/<field>
const DEFAULT_OP_REF = process.env['OP_REF'] ?? 'op://Personal/UniFi MCP/credential';

interface LiveCreds {
  baseUrl: string;
  apiKey: string;
  insecure?: boolean;
  caCert?: string;
}

function readEnvCreds(): LiveCreds | undefined {
  const baseUrl = process.env['UNIFI_LOCAL_BASE_URL'];
  const apiKey = process.env['UNIFI_LOCAL_API_KEY'];
  if (!baseUrl || !apiKey) return undefined;
  let caCert: string | undefined;
  if (process.env['UNIFI_LOCAL_CA_CERT_PATH']) {
    caCert = readFileSync(resolve(process.env['UNIFI_LOCAL_CA_CERT_PATH']), 'utf-8');
  }
  return {
    baseUrl,
    apiKey,
    insecure: process.env['UNIFI_LOCAL_INSECURE'] === 'true',
    caCert,
  };
}

function readOnePasswordCreds(opRef: string): LiveCreds {
  const apiKey = execSync(`op read ${JSON.stringify(opRef)}`, { encoding: 'utf-8' }).trim();
  const baseUrl =
    process.env['UNIFI_LOCAL_BASE_URL'] ??
    safeOpRead(`${parentRef(opRef)}/baseUrl`) ??
    safeOpRead(`${parentRef(opRef)}/website`);
  if (!baseUrl) {
    throw new Error(
      `No UniFi base URL configured. Set UNIFI_LOCAL_BASE_URL env or add a "baseUrl" field next to the credential at ${parentRef(opRef)}.`,
    );
  }
  return {
    baseUrl,
    apiKey,
    insecure: process.env['UNIFI_LOCAL_INSECURE'] === 'true',
  };
}

function parentRef(ref: string): string {
  const idx = ref.lastIndexOf('/');
  return idx >= 0 ? ref.slice(0, idx) : ref;
}

function safeOpRead(ref: string): string | undefined {
  try {
    return execSync(`op read ${JSON.stringify(ref)}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const creds = readEnvCreds() ?? readOnePasswordCreds(DEFAULT_OP_REF);
  console.error(
    `[live] target=${creds.baseUrl} insecure=${String(Boolean(creds.insecure))} caCert=${creds.caCert ? 'present' : 'none'}`,
  );

  const client = createLocalClient(
    {
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
      caCert: creds.caCert,
      insecure: creds.insecure,
    },
    {
      onWarn: (msg) => console.error(`[live][warn] ${msg}`),
    },
  );

  // 1. /v1/info
  console.error('[live] GET /v1/info ...');
  const info = await client.request<Record<string, unknown>>({ method: 'GET', path: '/v1/info' });
  console.error(`[live]   applicationVersion=${String(info.data['applicationVersion'])}`);

  // 2. Load OpenAPI spec for this version
  const spec = await loadLocalSpec({
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    caCert: creds.caCert,
    insecure: creds.insecure,
    cacheDir: resolve(process.cwd(), 'src/spec/cache'),
  });
  const sum = specSummary(spec);
  console.error(`[live] spec ${sum.title} v${sum.version} — ${sum.operationCount} ops`);

  // 3. Run a sandbox script that lists sites and counts devices.
  const tenant = buildContextFromEnv({
    UNIFI_LOCAL_BASE_URL: creds.baseUrl,
    UNIFI_LOCAL_API_KEY: creds.apiKey,
    UNIFI_LOCAL_INSECURE: creds.insecure ? 'true' : 'false',
  });
  const exec = new ExecuteExecutor({ tenant, localSpec: spec });
  const result = await exec.execute(`
    (async function() {
      var sites = await unifi.local.callOperation('listSites', { limit: 50 });
      return {
        siteCount: (sites && sites.data && sites.data.length) || 0,
        firstSite: sites && sites.data && sites.data[0],
      };
    })()
  `);
  console.error('[live] sandbox result:');
  console.error(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('[live] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
