#!/usr/bin/env tsx
/**
 * Recon-only smoke test for the UniFi Protect surface, driven through the
 * Site Manager cloud connector. Lists every console reachable with the
 * configured cloud API key and reports, per console, whether Protect
 * Integration API is responding at:
 *
 *   GET /v1/connector/consoles/{id}/proxy/protect/integration/v1/meta/info
 *
 * Then, if at least one console has Protect installed, drives a small
 * sandbox script through ExecuteExecutor against the cloud-Protect proxy
 * to prove unifi.cloud.protect(consoleId).* works end-to-end.
 *
 * Read-only; no mutations.
 *
 * Usage:
 *   tsx scripts/discover-protect.ts                      # use 1Password
 *   UNIFI_CLOUD_API_KEY=... tsx scripts/discover-protect.ts
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createCloudClient,
  createCloudProtectProxyClient,
} from '../src/client/cloud.js';
import { loadProtectSpec } from '../src/spec/loader.js';
import { ExecuteExecutor } from '../src/sandbox/execute-executor.js';
import { buildContextFromEnv } from '../src/tenant/context.js';

const OP_REF = process.env['OP_CLOUD_REF'] ?? 'op://AI Agents/unifi cloud api/password';
const PROTECT_BASE = '/v1/meta/info';

interface HostSummary {
  id: string;
  hostname?: string;
  type?: string;
  reportedState?: Record<string, unknown>;
}

function getApiKey(): string {
  const fromEnv = process.env['UNIFI_CLOUD_API_KEY'];
  if (fromEnv) return fromEnv;
  return execSync(`op read ${JSON.stringify(OP_REF)}`, { encoding: 'utf-8' }).trim();
}

async function listHosts(
  cloud: ReturnType<typeof createCloudClient>,
): Promise<HostSummary[]> {
  const res = await cloud.request<{ data?: Array<Record<string, unknown>> }>({
    method: 'GET',
    path: '/v1/hosts',
  });
  const arr = res.data.data ?? [];
  return arr.map((h): HostSummary => {
    const rawId = h['id'];
    const id = typeof rawId === 'string' ? rawId : '';
    const reportedState = (h['reportedState'] as Record<string, unknown> | undefined) ?? {};
    const hostname = reportedState['hostname'];
    const type = h['type'];
    return {
      id,
      ...(typeof hostname === 'string' ? { hostname } : {}),
      ...(typeof type === 'string' ? { type } : {}),
      reportedState,
    };
  });
}

async function probeProtect(
  apiKey: string,
  consoleId: string,
): Promise<{
  consoleId: string;
  reachable: boolean;
  status?: number;
  applicationVersion?: string;
  body?: unknown;
  error?: string;
}> {
  const client = createCloudProtectProxyClient(
    { baseUrl: 'https://api.ui.com', apiKey },
    consoleId,
  );
  try {
    const res = await client.request<Record<string, unknown>>({
      method: 'GET',
      path: PROTECT_BASE,
    });
    const status = res.status;
    const body = res.data;
    const rawVersion = body['applicationVersion'];
    return {
      consoleId,
      reachable: status >= 200 && status < 300,
      status,
      ...(typeof rawVersion === 'string' ? { applicationVersion: rawVersion } : {}),
      body,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const m = message.match(/^\s*\[unifi\.cloud\.protect.*?\]\s+(\d{3})\b/);
    const status = m ? Number(m[1]) : undefined;
    return { consoleId, reachable: false, ...(status !== undefined ? { status } : {}), error: message };
  }
}

async function runSandboxSmoke(
  apiKey: string,
  consoleId: string,
): Promise<{
  ok: boolean;
  meta?: unknown;
  cameraSummary?: { count: number; sample: Array<{ id?: string; name?: string; state?: string }> };
  logs: string[];
  error?: string;
}> {
  const protectSpec = await loadProtectSpec({
    baseUrl: 'https://api.ui.com',
    apiKey,
    cacheDir: resolve(process.cwd(), 'src/spec/cache'),
    onWarn: (m) => {
      console.error(`[discover-protect][warn] ${m}`);
    },
  });
  console.error(
    `[discover-protect] protect spec=${protectSpec.title} v${protectSpec.version} (${String(protectSpec.operations.length)} ops)`,
  );

  const tenant = buildContextFromEnv({ UNIFI_CLOUD_API_KEY: apiKey });
  const exec = new ExecuteExecutor({
    tenant,
    protectSpec,
    limits: { maxCallsPerExecute: 50, timeoutMs: 60_000 },
  });

  // Use path-based request() instead of named callOperation() — the official
  // CDN spec ships every operation with operationId: null, so the synthesizer
  // (or in some cases the bundled fallback) decides the names. Path-based is
  // robust to either naming scheme.
  const code = `
    var p = unifi.cloud.protect(${JSON.stringify(consoleId)});
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
          ? { id: c.id, name: c.name, state: c.state, type: c.type }
          : { raw: c };
      })
    });
  `;
  const result = await exec.execute(code);
  if (!result.ok) {
    return { ok: false, logs: result.logs, error: result.error ?? 'unknown' };
  }
  const data = result.data as { meta?: unknown; cameraCount?: number; cameraSample?: Array<{ id?: string; name?: string; state?: string }> };
  return {
    ok: true,
    meta: data.meta,
    ...(typeof data.cameraCount === 'number'
      ? {
          cameraSummary: {
            count: data.cameraCount,
            sample: Array.isArray(data.cameraSample) ? data.cameraSample : [],
          },
        }
      : {}),
    logs: result.logs,
  };
}

async function main(): Promise<void> {
  const apiKey = getApiKey();
  const cloud = createCloudClient({ baseUrl: 'https://api.ui.com', apiKey });

  console.error('[discover-protect] listing hosts …');
  const hosts = await listHosts(cloud);
  console.error(`[discover-protect] found ${String(hosts.length)} hosts`);
  for (const h of hosts) {
    console.error(`  - id=${h.id} hostname=${h.hostname ?? '?'} type=${h.type ?? '?'}`);
  }

  const probes = await Promise.all(hosts.map((h) => probeProtect(apiKey, h.id)));
  const reachable: typeof probes = [];
  for (const p of probes) {
    if (p.reachable) {
      console.error(`  ✓ ${p.consoleId} → Protect ${p.applicationVersion ?? '(unknown version)'}`);
      reachable.push(p);
    } else {
      console.error(
        `  ✗ ${p.consoleId} → ${p.status ? String(p.status) : 'no-response'} ${p.error ?? ''}`,
      );
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    apiVersion: 'site-manager-v1',
    hosts: hosts.map((h) => ({ id: h.id, hostname: h.hostname, type: h.type })),
    probes: probes.map((p) => ({
      consoleId: p.consoleId,
      reachable: p.reachable,
      status: p.status,
      applicationVersion: p.applicationVersion,
      error: p.error,
    })),
    sandboxSmoke: undefined as
      | undefined
      | {
          consoleId: string;
          ok: boolean;
          meta?: unknown;
          cameraCount?: number;
          cameraSample?: Array<{ id?: string; name?: string; state?: string }>;
          error?: string;
        },
  };

  const target = reachable[0];
  if (target) {
    console.error(`[discover-protect] running sandbox smoke against consoleId=${target.consoleId} …`);
    const smoke = await runSandboxSmoke(apiKey, target.consoleId);
    summary.sandboxSmoke = {
      consoleId: target.consoleId,
      ok: smoke.ok,
      meta: smoke.meta,
      ...(smoke.cameraSummary
        ? { cameraCount: smoke.cameraSummary.count, cameraSample: smoke.cameraSummary.sample }
        : {}),
      ...(smoke.error ? { error: smoke.error } : {}),
    };
    console.error(
      `[discover-protect] sandbox ok=${String(smoke.ok)}${smoke.cameraSummary ? ` cameras=${String(smoke.cameraSummary.count)}` : ''}${smoke.error ? ` error=${smoke.error}` : ''}`,
    );
  } else {
    console.error('[discover-protect] No Protect-enabled consoles reachable. Skipping sandbox smoke.');
  }

  const outDir = resolve(process.cwd(), 'out');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = resolve(outDir, `protect-recon-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.error(`[discover-protect] wrote ${outPath}`);
}

main().catch((err: unknown) => {
  console.error('[discover-protect] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
