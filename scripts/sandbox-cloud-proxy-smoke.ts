#!/usr/bin/env tsx
/**
 * One-off: drive the Cloud → Network proxy surface end-to-end through the
 * QuickJS sandbox, exactly the way an LLM-written `execute` script would.
 *
 * Pulls the cloud key from 1Password (or env), discovers the consoleId
 * via /v1/hosts, queries /v1/info through the proxy to learn the
 * controller's app version, fetches the matching Network Integration
 * OpenAPI from apidoc-cdn.ui.com, then runs a sandbox script that lists
 * sites and counts devices via unifi.cloud.network(consoleId).*.
 *
 * Read-only; no mutations.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createCloudClient, createCloudNetworkProxyClient } from '../src/client/cloud.js';
import { loadLocalSpec } from '../src/spec/loader.js';
import { ExecuteExecutor } from '../src/sandbox/execute-executor.js';
import { buildContextFromEnv } from '../src/tenant/context.js';

const OP_REF = process.env['OP_CLOUD_REF'] ?? 'op://AI Agents/unifi cloud api/password';

function getApiKey(): string {
  const fromEnv = process.env['UNIFI_CLOUD_API_KEY'];
  if (fromEnv) return fromEnv;
  return execSync(`op read ${JSON.stringify(OP_REF)}`, { encoding: 'utf-8' }).trim();
}

async function main(): Promise<void> {
  const apiKey = getApiKey();

  const cloudClient = createCloudClient({ baseUrl: 'https://api.ui.com', apiKey });

  const consoleId =
    process.env['UNIFI_CLOUD_CONSOLE_ID'] ?? (await discoverConsoleId(cloudClient));
  if (!consoleId) throw new Error('Could not determine consoleId from /v1/hosts');
  console.error(`[smoke] consoleId=${consoleId}`);

  // Discover controller version through the proxy.
  const proxyClient = createCloudNetworkProxyClient(
    { baseUrl: 'https://api.ui.com', apiKey },
    consoleId,
  );
  const infoRes = await proxyClient.request<Record<string, unknown>>({
    method: 'GET',
    path: '/v1/info',
  });
  const rawVersion = infoRes.data['applicationVersion'];
  const appVersion = typeof rawVersion === 'string' ? rawVersion : '';
  if (!appVersion) throw new Error('Could not read applicationVersion from proxied /v1/info');
  console.error(`[smoke] controller applicationVersion=${appVersion}`);

  // Fetch the Network Integration spec for that version (no /v1/info call needed).
  const specUrl = `https://apidoc-cdn.ui.com/network/v${appVersion}/integration.json`;
  console.error(`[smoke] loading Network spec from ${specUrl} …`);
  const localSpec = await loadLocalSpec({
    baseUrl: 'https://api.ui.com',
    apiKey,
    specUrlOverride: specUrl,
    cacheDir: resolve(process.cwd(), 'src/spec/cache'),
  });
  console.error(
    `[smoke] Network spec ${localSpec.title} v${localSpec.version} — ${String(localSpec.operations.length)} ops`,
  );

  const tenant = buildContextFromEnv({ UNIFI_CLOUD_API_KEY: apiKey });
  const exec = new ExecuteExecutor({
    tenant,
    localSpec,
    // cloudSpec is needed for `unifi.cloud` to be a real namespace (not __missing).
    // Use the same Network spec as a placeholder — the smoke only touches
    // unifi.cloud.network(), so the cloud-native dispatcher is never invoked.
    cloudSpec: localSpec,
  });

  // The v10.1.84 spec uses paginated *Page operations: getSiteOverviewPage,
  // getAdoptedDeviceOverviewPage, etc. Standard query params: pageNumber, pageSize.
  const code = `
    var net = unifi.cloud.network(${JSON.stringify(consoleId)});
    var info = net.request({ method: 'GET', path: '/v1/info' });
    var sites = net.callOperation('getSiteOverviewPage', { pageSize: 100 });
    var siteList = (sites && sites.data) || [];
    var first = siteList[0];
    var devices = first ? net.callOperation('getAdoptedDeviceOverviewPage', { siteId: first.id, pageSize: 200 }) : null;
    var deviceList = (devices && devices.data) || [];
    ({
      applicationVersion: info && info.applicationVersion,
      specOps: net.spec.operationCount,
      siteCount: siteList.length,
      totalSitesAvailable: sites && sites.totalCount,
      firstSite: first && { id: first.id, name: first.name, internalReference: first.internalReference },
      firstSiteDeviceCount: deviceList.length,
      firstDevice: deviceList[0] && {
        id: deviceList[0].id,
        name: deviceList[0].name,
        model: deviceList[0].model,
        macAddress: deviceList[0].macAddress,
      },
    });
  `;
  const result = await exec.execute(code);
  console.error('[smoke] sandbox result:');
  console.error(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

async function discoverConsoleId(client: ReturnType<typeof createCloudClient>): Promise<string | undefined> {
  const res = await client.request<{ data?: Array<{ id?: string }> }>({
    method: 'GET',
    path: '/v1/hosts',
  });
  return res.data.data?.[0]?.id;
}

main().catch((err: unknown) => {
  console.error('[smoke] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
