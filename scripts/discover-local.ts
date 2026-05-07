#!/usr/bin/env tsx
/**
 * Comprehensive read-only discovery of a UniFi controller via the
 * **direct local** Integration APIs — both Network and Protect, on the
 * same LAN as this script. Drives the unifi.local.* and
 * unifi.local.protect.* sandbox surfaces end-to-end and writes JSON
 * snapshots to out/ for offline analysis.
 *
 * Probed paths:
 *   1. https://<controller>/proxy/network/integration/v1/info
 *   2. https://<controller>/proxy/protect/integration/v1/meta/info
 *
 * Outputs:
 *   out/local-network-snapshot-<stamp>.json
 *   out/local-protect-snapshot-<stamp>.json
 *
 * Read-only; no mutations.
 *
 * Credentials (priority: env > 1Password):
 *   - UNIFI_LOCAL_BASE_URL   (e.g. https://172.27.1.1)
 *   - UNIFI_LOCAL_API_KEY    (or 1Password ref via OP_LOCAL_REF)
 *   - UNIFI_LOCAL_INSECURE   ("true" to skip TLS verification — UDM ships self-signed)
 *
 * Usage:
 *   UNIFI_LOCAL_BASE_URL=https://172.27.1.1 \
 *     UNIFI_LOCAL_INSECURE=true \
 *     tsx scripts/discover-local.ts
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLocalClient, createLocalProtectClient } from '../src/client/local.js';
import { loadLocalSpec, loadProtectSpec } from '../src/spec/loader.js';
import { ExecuteExecutor } from '../src/sandbox/execute-executor.js';
import { buildContextFromEnv } from '../src/tenant/context.js';

const OP_LOCAL_REF =
  process.env['OP_LOCAL_REF'] ?? 'op://AI Agents/Unifi local api key/password';

interface LocalCreds {
  baseUrl: string;
  apiKey: string;
  insecure: boolean;
}

function getCreds(): LocalCreds {
  const baseUrl = process.env['UNIFI_LOCAL_BASE_URL'];
  if (!baseUrl) {
    throw new Error('UNIFI_LOCAL_BASE_URL is required (e.g. https://172.27.1.1)');
  }
  const fromEnv = process.env['UNIFI_LOCAL_API_KEY'];
  const apiKey =
    fromEnv ?? execSync(`op read ${JSON.stringify(OP_LOCAL_REF)}`, { encoding: 'utf-8' }).trim();
  const insecure = process.env['UNIFI_LOCAL_INSECURE'] === 'true';
  return { baseUrl, apiKey, insecure };
}

async function probeNetwork(creds: LocalCreds): Promise<{
  ok: boolean;
  applicationVersion?: string;
  spec?: { title: string; version: string; ops: number };
  snapshotPath?: string;
  callsMade?: number;
  durationMs?: number;
  error?: string;
}> {
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error(`[local-network] target=${creds.baseUrl} insecure=${String(creds.insecure)}`);

  const client = createLocalClient(
    { baseUrl: creds.baseUrl, apiKey: creds.apiKey, insecure: creds.insecure },
    { onWarn: (m) => { console.error(`[local-network][warn] ${m}`); } },
  );
  const info = await client.request<Record<string, unknown>>({ method: 'GET', path: '/v1/info' });
  const rawVersion = info.data['applicationVersion'];
  const appVersion = typeof rawVersion === 'string' ? rawVersion : '';
  if (!appVersion) {
    return { ok: false, error: 'Could not read applicationVersion' };
  }
  console.error(`[local-network] applicationVersion=${appVersion}`);

  const spec = await loadLocalSpec({
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    insecure: creds.insecure,
    cacheDir: resolve(process.cwd(), 'src/spec/cache'),
    onWarn: (m) => { console.error(`[local-network][warn] ${m}`); },
  });
  console.error(
    `[local-network] spec=${spec.title} v${spec.version} (${String(spec.operations.length)} ops)`,
  );

  const tenant = buildContextFromEnv({
    UNIFI_LOCAL_BASE_URL: creds.baseUrl,
    UNIFI_LOCAL_API_KEY: creds.apiKey,
    UNIFI_LOCAL_INSECURE: creds.insecure ? 'true' : 'false',
  });
  const exec = new ExecuteExecutor({
    tenant,
    localSpec: spec,
    limits: { maxCallsPerExecute: 200, timeoutMs: 120_000 },
  });

  // Same scope as discover-network.ts but routed through unifi.local.* —
  // confirms the sandbox calls the LAN-direct path, not api.ui.com.
  const code = `
    var net = unifi.local;
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
      try { site.firewallZones = net.callOperation('getFirewallZones', { siteId: siteId }) || []; } catch (e) { site.firewallZones_error = String(e); }
      try { site.firewallPolicies = net.callOperation('getFirewallPolicies', { siteId: siteId }) || []; } catch (e) { site.firewallPolicies_error = String(e); }
      try { site.aclRules = (net.callOperation('getAclRulePage', { siteId: siteId, pageSize: 200 }) || {}).data || []; } catch (e) { site.aclRules_error = String(e); }

      site.devices = [];
      try {
        var devPage = net.callOperation('getAdoptedDeviceOverviewPage', { siteId: siteId, pageSize: 200 });
        var devs = (devPage && devPage.data) || [];
        for (var j = 0; j < devs.length; j++) {
          var d = devs[j];
          site.devices.push({ summary: d });
        }
      } catch (e) { site.devices_error = String(e); }

      try {
        var clientsPage = net.callOperation('getConnectedClientOverviewPage', { siteId: siteId, pageSize: 200 });
        site.clientsTotal = clientsPage && (clientsPage.totalCount != null ? clientsPage.totalCount : ((clientsPage.data && clientsPage.data.length) || 0));
        site.clientsSample = ((clientsPage && clientsPage.data) || []).slice(0, 5);
      } catch (e) { site.clients_error = String(e); }

      snapshot.sites.push(site);
    }

    snapshot;
  `;

  console.error('[local-network] running sandbox traversal …');
  const t0 = Date.now();
  const result = await exec.execute(code);
  const elapsed = Date.now() - t0;
  console.error(
    `[local-network] sandbox done in ${String(elapsed)}ms — ok=${String(result.ok)} calls=${String(result.callsMade)}`,
  );

  if (!result.ok) {
    return { ok: false, error: result.error ?? 'unknown', callsMade: result.callsMade, durationMs: elapsed };
  }

  const outDir = resolve(process.cwd(), 'out');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = resolve(outDir, `local-network-snapshot-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(result.data, null, 2));
  console.error(`[local-network] wrote ${outPath}`);

  // Brief stdout summary.
  const data = result.data as { sites: Array<{ name: string; devices: unknown[]; networks: unknown[]; wifi: unknown[]; clientsTotal?: number }> };
  for (const s of data.sites) {
    console.error(
      `[local-network]   site="${s.name}" devices=${String(s.devices.length)} networks=${String(s.networks.length)} wifi=${String(s.wifi.length)} clients=${String(s.clientsTotal ?? 0)}`,
    );
  }

  return {
    ok: true,
    applicationVersion: appVersion,
    spec: { title: spec.title, version: spec.version, ops: spec.operations.length },
    snapshotPath: outPath,
    callsMade: result.callsMade,
    durationMs: elapsed,
  };
}

async function probeProtect(creds: LocalCreds): Promise<{
  ok: boolean;
  applicationVersion?: string;
  spec?: { title: string; version: string; ops: number };
  snapshotPath?: string;
  callsMade?: number;
  durationMs?: number;
  cameraCount?: number;
  error?: string;
  skipped?: boolean;
}> {
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error(`[local-protect] target=${creds.baseUrl} insecure=${String(creds.insecure)}`);

  // Up-front probe — Protect may not be installed.
  const client = createLocalProtectClient(
    { baseUrl: creds.baseUrl, apiKey: creds.apiKey, insecure: creds.insecure },
    { onWarn: (m) => { console.error(`[local-protect][warn] ${m}`); } },
  );
  let appVersion: string;
  try {
    const meta = await client.request<Record<string, unknown>>({
      method: 'GET',
      path: '/v1/meta/info',
    });
    const rawVersion = meta.data['applicationVersion'];
    appVersion = typeof rawVersion === 'string' ? rawVersion : '';
    if (!appVersion) return { ok: false, error: 'No applicationVersion in /v1/meta/info' };
    console.error(`[local-protect] applicationVersion=${appVersion}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[local-protect] not reachable: ${msg}`);
    return { ok: false, skipped: true, error: msg };
  }

  const spec = await loadProtectSpec({
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    insecure: creds.insecure,
    cacheDir: resolve(process.cwd(), 'src/spec/cache'),
    onWarn: (m) => { console.error(`[local-protect][warn] ${m}`); },
  });
  console.error(
    `[local-protect] spec=${spec.title} v${spec.version} (${String(spec.operations.length)} ops)`,
  );

  const tenant = buildContextFromEnv({
    UNIFI_LOCAL_BASE_URL: creds.baseUrl,
    UNIFI_LOCAL_API_KEY: creds.apiKey,
    UNIFI_LOCAL_INSECURE: creds.insecure ? 'true' : 'false',
  });
  const exec = new ExecuteExecutor({
    tenant,
    protectSpec: spec,
    limits: { maxCallsPerExecute: 50, timeoutMs: 60_000 },
  });

  // Path-based — the official Protect spec ships every operationId as null,
  // so we use stable paths for portability across naming-synthesis changes.
  const code = `
    var p = unifi.local.protect;
    var meta = p.request({ method: 'GET', path: '/v1/meta/info' });
    var cameras = [];
    try {
      var camRes = p.request({ method: 'GET', path: '/v1/cameras' });
      cameras = Array.isArray(camRes) ? camRes : (camRes && camRes.data) ? camRes.data : [];
    } catch (e) { cameras = ['ERROR: ' + String(e)]; }

    ({
      meta: meta,
      cameraCount: cameras.length,
      cameraSample: cameras.slice(0, 5).map(function(c) {
        return c && typeof c === 'object'
          ? {
              id: c.id,
              name: c.name,
              modelKey: c.modelKey,
              type: c.type,
              state: c.state,
              firmwareVersion: c.firmwareVersion,
              isMicEnabled: c.isMicEnabled,
              isRecording: c.isRecording,
              hasSpeaker: c.hasSpeaker,
              hasMic: c.hasMic
            }
          : { raw: c };
      })
    });
  `;
  console.error('[local-protect] running sandbox traversal …');
  const t0 = Date.now();
  const result = await exec.execute(code);
  const elapsed = Date.now() - t0;
  console.error(
    `[local-protect] sandbox done in ${String(elapsed)}ms — ok=${String(result.ok)} calls=${String(result.callsMade)}`,
  );

  if (!result.ok) {
    return { ok: false, error: result.error ?? 'unknown', callsMade: result.callsMade, durationMs: elapsed };
  }

  const data = result.data as { meta: unknown; cameraCount: number; cameraSample: unknown[] };
  const outDir = resolve(process.cwd(), 'out');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = resolve(outDir, `local-protect-snapshot-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.error(`[local-protect] wrote ${outPath} (${String(data.cameraCount)} cameras)`);

  return {
    ok: true,
    applicationVersion: appVersion,
    spec: { title: spec.title, version: spec.version, ops: spec.operations.length },
    snapshotPath: outPath,
    callsMade: result.callsMade,
    durationMs: elapsed,
    cameraCount: data.cameraCount,
  };
}

async function main(): Promise<void> {
  const creds = getCreds();

  let netResult: Awaited<ReturnType<typeof probeNetwork>> | undefined;
  let protectResult: Awaited<ReturnType<typeof probeProtect>> | undefined;
  let failures = 0;

  try {
    netResult = await probeNetwork(creds);
    if (!netResult.ok) failures += 1;
  } catch (err: unknown) {
    failures += 1;
    netResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
    console.error(`[local-network] FAILED: ${String(netResult.error)}`);
  }

  try {
    protectResult = await probeProtect(creds);
    if (!protectResult.ok && !protectResult.skipped) failures += 1;
  } catch (err: unknown) {
    failures += 1;
    protectResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
    console.error(`[local-protect] FAILED: ${String(protectResult.error)}`);
  }

  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('[discover-local] summary:');
  const n = netResult;
  const p = protectResult;
  console.error(`  network: ${n.ok ? 'OK' : 'FAIL'}${n.applicationVersion ? ` (Network ${n.applicationVersion})` : ''}`);
  console.error(
    `  protect: ${p.ok ? 'OK' : p.skipped ? 'SKIPPED' : 'FAIL'}${p.applicationVersion ? ` (Protect ${p.applicationVersion})` : ''}${typeof p.cameraCount === 'number' ? `, cameras=${String(p.cameraCount)}` : ''}`,
  );

  if (failures > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('[discover-local] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
