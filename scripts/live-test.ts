#!/usr/bin/env tsx
/**
 * Live smoke test against a real UniFi deployment.
 *
 * READ-ONLY. Probes both paths when credentials are available:
 *   1. Direct local path:  controller -> /proxy/network/integration/v1/info
 *   2. Cloud Site Manager: api.ui.com -> /v1/hosts, /v1/sites
 *   3. Cloud-proxied Network: api.ui.com -> /v1/connector/consoles/{id}/proxy/network/integration/v1/info
 *
 * Each path is independent; if a credential set is missing, that path is
 * skipped with a notice. No mutations are issued.
 *
 * Credentials (priority: env > 1Password):
 *   - LOCAL:
 *       UNIFI_LOCAL_BASE_URL        e.g. https://192.168.1.1
 *       UNIFI_LOCAL_API_KEY         (or 1Password ref via OP_LOCAL_REF)
 *       UNIFI_LOCAL_INSECURE        true|false
 *       UNIFI_LOCAL_CA_CERT_PATH    path to PEM
 *   - CLOUD:
 *       UNIFI_CLOUD_API_KEY         (or 1Password ref via OP_CLOUD_REF)
 *       UNIFI_CLOUD_CONSOLE_ID      console id from unifi.ui.com/consoles/<id>
 *
 * 1Password references (defaults):
 *   OP_LOCAL_REF = op://Personal/UniFi MCP/credential
 *   OP_CLOUD_REF = op://Personal/UniFi Site Manager/credential
 *
 * Run:
 *   npm run live-test
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLocalClient } from '../src/client/local.js';
import {
  createCloudClient,
  createCloudNetworkProxyClient,
} from '../src/client/cloud.js';
import { loadLocalSpec, loadCloudSpec } from '../src/spec/loader.js';
import { specSummary } from '../src/spec/index.js';
import { ExecuteExecutor } from '../src/sandbox/execute-executor.js';
import { buildContextFromEnv } from '../src/tenant/context.js';

const OP_LOCAL_REF = process.env['OP_LOCAL_REF'] ?? 'op://Personal/UniFi MCP/credential';
const OP_CLOUD_REF =
  process.env['OP_CLOUD_REF'] ?? 'op://Personal/UniFi Site Manager/credential';

interface LocalCreds {
  baseUrl: string;
  apiKey: string;
  insecure?: boolean;
  caCert?: string;
}

interface CloudCreds {
  apiKey: string;
  consoleId?: string;
}

function readLocalEnvCreds(): LocalCreds | undefined {
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

function readLocalOnePassword(): LocalCreds | undefined {
  const apiKey = safeOpRead(OP_LOCAL_REF);
  if (!apiKey) return undefined;
  const baseUrl =
    process.env['UNIFI_LOCAL_BASE_URL'] ??
    safeOpRead(`${parentRef(OP_LOCAL_REF)}/baseUrl`) ??
    safeOpRead(`${parentRef(OP_LOCAL_REF)}/website`);
  if (!baseUrl) {
    console.error(
      `[live] local: have credential but no base URL — set UNIFI_LOCAL_BASE_URL or add baseUrl/website to ${parentRef(OP_LOCAL_REF)}`,
    );
    return undefined;
  }
  return {
    baseUrl,
    apiKey,
    insecure: process.env['UNIFI_LOCAL_INSECURE'] === 'true',
  };
}

function readCloudEnvCreds(): CloudCreds | undefined {
  const apiKey = process.env['UNIFI_CLOUD_API_KEY'];
  if (!apiKey) return undefined;
  return { apiKey, consoleId: process.env['UNIFI_CLOUD_CONSOLE_ID'] };
}

function readCloudOnePassword(): CloudCreds | undefined {
  const apiKey = safeOpRead(OP_CLOUD_REF);
  if (!apiKey) return undefined;
  const consoleId =
    process.env['UNIFI_CLOUD_CONSOLE_ID'] ??
    safeOpRead(`${parentRef(OP_CLOUD_REF)}/consoleId`);
  return { apiKey, consoleId };
}

function parentRef(ref: string): string {
  const idx = ref.lastIndexOf('/');
  return idx >= 0 ? ref.slice(0, idx) : ref;
}

function safeOpRead(ref: string): string | undefined {
  try {
    const out = execSync(`op read ${JSON.stringify(ref)}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

async function probeLocal(creds: LocalCreds): Promise<void> {
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error(
    `[live] LOCAL  target=${creds.baseUrl} insecure=${String(Boolean(creds.insecure))} caCert=${creds.caCert ? 'present' : 'none'}`,
  );
  const client = createLocalClient(creds, {
    onWarn: (msg) => { console.error(`[live][warn] ${msg}`); },
  });

  console.error('[live] GET /v1/info …');
  const info = await client.request<Record<string, unknown>>({ method: 'GET', path: '/v1/info' });
  console.error(`[live]   applicationVersion=${String(info.data['applicationVersion'])}`);

  const spec = await loadLocalSpec({
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    caCert: creds.caCert,
    insecure: creds.insecure,
    cacheDir: resolve(process.cwd(), 'src/spec/cache'),
  });
  const sum = specSummary(spec);
  console.error(`[live] spec  ${sum.title} v${sum.version} — ${String(sum.operationCount)} ops`);

  const tenant = buildContextFromEnv({
    UNIFI_LOCAL_BASE_URL: creds.baseUrl,
    UNIFI_LOCAL_API_KEY: creds.apiKey,
    UNIFI_LOCAL_INSECURE: creds.insecure ? 'true' : 'false',
  });
  const exec = new ExecuteExecutor({ tenant, localSpec: spec });
  // Sync-style for stability — host calls are asyncified at the QuickJS layer.
  const result = await exec.execute(`
    var sites = unifi.local.callOperation('listSites', { limit: 50 });
    var siteCount = (sites && sites.data && sites.data.length) || 0;
    var firstSite = sites && sites.data && sites.data[0];
    ({ siteCount: siteCount, firstSite: firstSite });
  `);
  console.error('[live] LOCAL sandbox result:');
  console.error(JSON.stringify(result, null, 2));
  if (!result.ok) throw new Error('local probe failed');
}

async function probeCloud(creds: CloudCreds): Promise<void> {
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error(
    `[live] CLOUD  target=https://api.ui.com consoleId=${creds.consoleId ?? '(none)'}`,
  );
  const client = createCloudClient({
    baseUrl: 'https://api.ui.com',
    apiKey: creds.apiKey,
  });

  console.error('[live] GET /v1/hosts …');
  const hosts = await client.request<{ data?: Array<Record<string, unknown>> }>({
    method: 'GET',
    path: '/v1/hosts',
  });
  const hostCount = hosts.data.data?.length ?? 0;
  console.error(`[live]   hosts=${String(hostCount)}`);
  const firstId = hosts.data.data?.[0]?.['id'];
  if (typeof firstId === 'string' && !creds.consoleId) {
    console.error(`[live]   discovered first console id: ${firstId}`);
    creds.consoleId = firstId;
  }

  const cloudSpec = await loadCloudSpec({
    cacheDir: resolve(process.cwd(), 'src/spec/cache'),
  });
  console.error(
    `[live] cloud spec ${cloudSpec.title} v${cloudSpec.version} — ${String(cloudSpec.operations.length)} ops`,
  );

  if (creds.consoleId) {
    console.error(
      `[live] CLOUD-PROXY  GET /v1/connector/consoles/${creds.consoleId}/proxy/network/integration/v1/info …`,
    );
    const proxyClient = createCloudNetworkProxyClient(
      { baseUrl: 'https://api.ui.com', apiKey: creds.apiKey },
      creds.consoleId,
    );
    try {
      const info = await proxyClient.request<Record<string, unknown>>({
        method: 'GET',
        path: '/v1/info',
      });
      console.error(
        `[live]   proxied applicationVersion=${String(info.data['applicationVersion'])}`,
      );
    } catch (err) {
      console.error(
        `[live]   proxied call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    console.error('[live] no consoleId; skipping cloud-proxy probe.');
  }
}

async function main(): Promise<void> {
  const localCreds = readLocalEnvCreds() ?? readLocalOnePassword();
  const cloudCreds = readCloudEnvCreds() ?? readCloudOnePassword();

  if (!localCreds && !cloudCreds) {
    console.error(
      '[live] no credentials available — provide UNIFI_LOCAL_* / UNIFI_CLOUD_* env or 1Password references.',
    );
    process.exit(2);
  }

  let failures = 0;
  if (localCreds) {
    try {
      await probeLocal(localCreds);
    } catch (err) {
      console.error(`[live] LOCAL failed: ${err instanceof Error ? err.message : String(err)}`);
      failures += 1;
    }
  } else {
    console.error('[live] no local creds; skipping local probe.');
  }
  if (cloudCreds) {
    try {
      await probeCloud(cloudCreds);
    } catch (err) {
      console.error(`[live] CLOUD failed: ${err instanceof Error ? err.message : String(err)}`);
      failures += 1;
    }
  } else {
    console.error('[live] no cloud creds; skipping cloud probe.');
  }

  if (failures > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('[live] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
