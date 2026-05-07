#!/usr/bin/env tsx
/**
 * Read-only Protect probe — inspects per-camera feature flags and
 * rtsps-stream state to determine which mutations are safely testable
 * on the maintainer's homelab without hitting CONNECTED hardware.
 *
 * Used as a precondition gate for verify-mutations.ts extensions.
 * No mutations.
 */
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadProtectSpec } from '../src/spec/loader.js';
import { ExecuteExecutor } from '../src/sandbox/execute-executor.js';
import { buildContextFromEnv } from '../src/tenant/context.js';

const OP_REF = process.env['OP_LOCAL_REF'] ?? 'op://AI Agents/Unifi local api key/password';

function getKey(): string {
  return process.env['UNIFI_LOCAL_API_KEY']
    ?? execSync(`op read ${JSON.stringify(OP_REF)}`, { encoding: 'utf-8' }).trim();
}

async function main(): Promise<void> {
  const baseUrl = process.env['UNIFI_LOCAL_BASE_URL'];
  if (!baseUrl) throw new Error('UNIFI_LOCAL_BASE_URL is required');
  const apiKey = getKey();
  const insecure = process.env['UNIFI_LOCAL_INSECURE'] === 'true';

  const protectSpec = await loadProtectSpec({
    baseUrl,
    apiKey,
    insecure,
    cacheDir: resolve(process.cwd(), 'src/spec/cache'),
    onWarn: () => undefined,
  });
  const tenant = buildContextFromEnv({
    UNIFI_LOCAL_BASE_URL: baseUrl,
    UNIFI_LOCAL_API_KEY: apiKey,
    UNIFI_LOCAL_INSECURE: insecure ? 'true' : 'false',
  });
  const exec = new ExecuteExecutor({
    tenant,
    protectSpec,
    limits: { maxCallsPerExecute: 20, timeoutMs: 30_000 },
  });
  const r = await exec.execute(`
    var p = unifi.local.protect;
    var cams = p.callOperation('listCameras');
    cams.map(function (c) {
      var ff = c.featureFlags || {};
      var rt = null;
      try { rt = p.request({ method: 'GET', path: '/v1/cameras/' + c.id + '/rtsps-stream' }); }
      catch (e) { rt = { _error: String(e.message || e) }; }
      return {
        id: c.id,
        name: c.name,
        state: c.state,
        modelKey: c.modelKey,
        featurePtz: !!ff.canPtz,
        featureFlagsKeys: Object.keys(ff),
        rtspsStream: rt,
      };
    });
  `);
  if (!r.ok) {
    console.error('probe failed:', r.error);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(r.data, null, 2));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
