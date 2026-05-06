#!/usr/bin/env tsx
/**
 * Comprehensive read-only discovery of a UniFi Network deployment via the
 * Site Manager cloud proxy. Drives the full sandbox surface end-to-end and
 * dumps a JSON snapshot to out/ for offline analysis (HLD/LLD authoring).
 *
 * Output: out/network-snapshot-<ISO timestamp>.json
 *
 * Read-only; no mutations.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  console.error(`[discover] consoleId=${consoleId}`);

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
  if (!appVersion) throw new Error('Could not read applicationVersion');
  console.error(`[discover] applicationVersion=${appVersion}`);

  const spec = await loadLocalSpec({
    baseUrl: 'https://api.ui.com',
    apiKey,
    specUrlOverride: `https://apidoc-cdn.ui.com/network/v${appVersion}/integration.json`,
    cacheDir: resolve(process.cwd(), 'src/spec/cache'),
    onWarn: (m) => {
      console.error(`[discover][warn] ${m}`);
    },
  });
  console.error(
    `[discover] spec=${spec.title} v${spec.version} (${String(spec.operations.length)} ops)`,
  );

  const tenant = buildContextFromEnv({ UNIFI_CLOUD_API_KEY: apiKey });
  const exec = new ExecuteExecutor({
    tenant,
    localSpec: spec,
    cloudSpec: spec,
    limits: { maxCallsPerExecute: 200, timeoutMs: 120_000 },
  });

  // Sync-style traversal — host calls are asyncified and appear synchronous.
  // The script returns a single big object captured below.
  const code = `
    var net = unifi.cloud.network(${JSON.stringify(consoleId)});
    var snapshot = { generatedAt: new Date().toISOString(), info: net.request({ method: 'GET', path: '/v1/info' }) };

    var sitesPage = net.callOperation('getSiteOverviewPage', { pageSize: 100 });
    snapshot.sites = [];

    var siteList = (sitesPage && sitesPage.data) || [];
    for (var i = 0; i < siteList.length; i++) {
      var s = siteList[i];
      var siteId = s.id;
      var site = { id: siteId, name: s.name, internalReference: s.internalReference, raw: s };

      try { site.networks = net.callOperation('getNetworksOverviewPage', { siteId: siteId, pageSize: 100 }).data || []; } catch (e) { site.networks_error = String(e); }
      try { site.wans = net.callOperation('getWansOverviewPage', { siteId: siteId, pageSize: 100 }).data || []; } catch (e) { site.wans_error = String(e); }
      try { site.wifi = net.callOperation('getWifiBroadcastPage', { siteId: siteId, pageSize: 100 }).data || []; } catch (e) { site.wifi_error = String(e); }
      try { site.firewallZones = net.callOperation('getFirewallZones', { siteId: siteId }).data || net.callOperation('getFirewallZones', { siteId: siteId }) || []; } catch (e) { site.firewallZones_error = String(e); }
      try { site.firewallPolicies = net.callOperation('getFirewallPolicies', { siteId: siteId }).data || net.callOperation('getFirewallPolicies', { siteId: siteId }) || []; } catch (e) { site.firewallPolicies_error = String(e); }
      try { site.firewallOrdering = net.callOperation('getFirewallPolicyOrdering', { siteId: siteId }); } catch (e) { site.firewallOrdering_error = String(e); }
      try { site.aclRules = (net.callOperation('getAclRulePage', { siteId: siteId, pageSize: 200 }) || {}).data || []; } catch (e) { site.aclRules_error = String(e); }
      try { site.aclOrdering = net.callOperation('getAclRuleOrdering', { siteId: siteId }); } catch (e) { site.aclOrdering_error = String(e); }
      try { site.dnsPolicies = (net.callOperation('getDnsPolicyPage', { siteId: siteId, pageSize: 100 }) || {}).data || []; } catch (e) { site.dnsPolicies_error = String(e); }
      try { site.radiusProfiles = (net.callOperation('getRadiusProfileOverviewPage', { siteId: siteId, pageSize: 100 }) || {}).data || []; } catch (e) { site.radiusProfiles_error = String(e); }
      try { site.vpnServers = (net.callOperation('getVpnServerPage', { siteId: siteId, pageSize: 100 }) || {}).data || []; } catch (e) { site.vpnServers_error = String(e); }
      try { site.siteToSiteVpns = (net.callOperation('getSiteToSiteVpnTunnelPage', { siteId: siteId, pageSize: 100 }) || {}).data || []; } catch (e) { site.siteToSiteVpns_error = String(e); }
      try { site.deviceTags = (net.callOperation('getDeviceTagPage', { siteId: siteId, pageSize: 100 }) || {}).data || []; } catch (e) { site.deviceTags_error = String(e); }
      try { site.trafficMatchingLists = (net.callOperation('getTrafficMatchingLists', { siteId: siteId }) || {}).data || []; } catch (e) { site.trafficMatchingLists_error = String(e); }

      // Devices: list, then for each, fetch details + statistics.
      site.devices = [];
      try {
        var devPage = net.callOperation('getAdoptedDeviceOverviewPage', { siteId: siteId, pageSize: 200 });
        var devs = (devPage && devPage.data) || [];
        for (var j = 0; j < devs.length; j++) {
          var d = devs[j];
          var entry = { summary: d };
          try { entry.details = net.callOperation('getAdoptedDeviceDetails', { siteId: siteId, deviceId: d.id }); } catch (e) { entry.details_error = String(e); }
          try { entry.stats = net.callOperation('getAdoptedDeviceLatestStatistics', { siteId: siteId, deviceId: d.id }); } catch (e) { entry.stats_error = String(e); }
          site.devices.push(entry);
        }
      } catch (e) { site.devices_error = String(e); }

      // Clients: just summary counts to keep payload manageable.
      try {
        var clientsPage = net.callOperation('getConnectedClientOverviewPage', { siteId: siteId, pageSize: 200 });
        site.clientsSample = (clientsPage && clientsPage.data) || [];
        site.clientsTotal = clientsPage && (clientsPage.totalCount != null ? clientsPage.totalCount : ((clientsPage.data && clientsPage.data.length) || 0));
      } catch (e) { site.clients_error = String(e); }

      snapshot.sites.push(site);
    }

    snapshot;
  `;

  console.error('[discover] running sandbox traversal …');
  const t0 = Date.now();
  const result = await exec.execute(code);
  console.error(`[discover] sandbox done in ${String(Date.now() - t0)}ms — ok=${String(result.ok)} calls=${String(result.callsMade)}`);

  if (!result.ok) {
    console.error('[discover] FAILED:', result.error);
    console.error('[discover] logs:', result.logs);
    process.exit(1);
  }

  const outDir = resolve(process.cwd(), 'out');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = resolve(outDir, `network-snapshot-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(result.data, null, 2));
  console.error(`[discover] wrote ${outPath}`);

  // Brief stdout summary.
  const data = result.data as { sites: Array<{ name: string; devices: unknown[]; networks: unknown[]; wifi: unknown[]; clientsTotal?: number }> };
  for (const s of data.sites) {
    console.error(
      `[discover]   site="${s.name}" devices=${String(s.devices.length)} networks=${String(s.networks.length)} wifi=${String(s.wifi.length)} clients=${String(s.clientsTotal ?? 0)}`,
    );
  }
}

async function discoverConsoleId(client: ReturnType<typeof createCloudClient>): Promise<string | undefined> {
  const res = await client.request<{ data?: Array<{ id?: string }> }>({
    method: 'GET',
    path: '/v1/hosts',
  });
  return res.data.data?.[0]?.id;
}

main().catch((err: unknown) => {
  console.error('[discover] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
