#!/usr/bin/env tsx
/**
 * Live mutation verification — round-trip only.
 *
 * Drives a single-entity, self-reverting mutation through the
 * unifi.local.protect.* sandbox surface against a real UDM-Pro:
 *   GET   /v1/cameras/{id}                   → read original state
 *   PATCH /v1/cameras/{id} { name: <test> }  → rename
 *   GET   /v1/cameras/{id}                   → confirm rename took
 *   PATCH /v1/cameras/{id} { name: <orig> }  → revert
 *   GET   /v1/cameras/{id}                   → confirm revert
 *
 * Hard preconditions to keep this test safe:
 *   - Target camera MUST be DISCONNECTED (i.e. no recording
 *     impact, even theoretical)
 *   - Original name MUST NOT already start with the test prefix
 *     (so we never clobber a stale failed run)
 *   - If revert fails for any reason, exit non-zero and shout loudly
 *     so the user can manually fix the name in the UI
 *
 * NOT included: Network mutation verification. Every Network create
 * endpoint on this controller version requires a polymorphic
 * discriminator (`$.type`, `$.management`, …) that the loaded OpenAPI
 * spec doesn't expose to the synthesizer. Blindly guessing
 * discriminators against live hardware is not safe. Network mutation
 * verification is deferred until either the loader extracts
 * discriminators or we ship known-good fixture bodies. See
 * out/verification/mutation-live-smoke.txt for the disclosure.
 *
 * Usage:
 *   UNIFI_LOCAL_BASE_URL=https://172.27.1.1 \
 *     UNIFI_LOCAL_INSECURE=true \
 *     OP_LOCAL_REF='op://AI Agents/Unifi local api key/password' \
 *     npx tsx scripts/verify-mutations.ts <cameraId>
 *
 * Defaults to the DISCONNECTED "Tuin" camera id from the maintainer's
 * homelab if no cameraId is passed.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadProtectSpec } from '../src/spec/loader.js';
import { ExecuteExecutor } from '../src/sandbox/execute-executor.js';
import { buildContextFromEnv } from '../src/tenant/context.js';

const OP_LOCAL_REF =
  process.env['OP_LOCAL_REF'] ?? 'op://AI Agents/Unifi local api key/password';
const TEST_PREFIX = 'MCP-VERIFY-';

const cameraId = process.argv[2] ?? '60369b7901b43a0387000436';

function getKey(): string {
  const fromEnv = process.env['UNIFI_LOCAL_API_KEY'];
  if (fromEnv) return fromEnv;
  return execSync(`op read ${JSON.stringify(OP_LOCAL_REF)}`, { encoding: 'utf-8' }).trim();
}

interface CameraSnapshot {
  id: string;
  name: string;
  state: string;
}

async function main(): Promise<void> {
  const baseUrl = process.env['UNIFI_LOCAL_BASE_URL'];
  if (!baseUrl) throw new Error('UNIFI_LOCAL_BASE_URL is required');
  const apiKey = getKey();
  const insecure = process.env['UNIFI_LOCAL_INSECURE'] === 'true';

  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error(`[verify-mutations] target ${baseUrl}, camera ${cameraId}`);

  const protectSpec = await loadProtectSpec({
    baseUrl,
    apiKey,
    insecure,
    cacheDir: resolve(process.cwd(), 'src/spec/cache'),
    onWarn: (m) => {
      console.error(`[verify-mutations][warn] ${m}`);
    },
  });
  console.error(
    `[verify-mutations] protect spec ${protectSpec.title} v${protectSpec.version} (${String(protectSpec.operations.length)} ops)`,
  );

  const tenant = buildContextFromEnv({
    UNIFI_LOCAL_BASE_URL: baseUrl,
    UNIFI_LOCAL_API_KEY: apiKey,
    UNIFI_LOCAL_INSECURE: insecure ? 'true' : 'false',
  });

  // Phase 1 — preconditions (read-only)
  const preExec = new ExecuteExecutor({
    tenant,
    protectSpec,
    limits: { maxCallsPerExecute: 5, timeoutMs: 30_000 },
  });
  const preResult = await preExec.execute(`
    var p = unifi.local.protect;
    var cam = p.request({ method: 'GET', path: '/v1/cameras/${cameraId}' });
    ({ id: cam.id, name: cam.name, state: cam.state });
  `);
  if (!preResult.ok) throw new Error(`pre-flight read failed: ${preResult.error ?? 'unknown'}`);
  const original = preResult.data as CameraSnapshot;
  console.error(`[verify-mutations] PRE  : id=${original.id} name="${original.name}" state=${original.state}`);

  if (original.state !== 'DISCONNECTED') {
    throw new Error(
      `aborting: camera is in state ${original.state}, not DISCONNECTED. ` +
      `This script only mutates DISCONNECTED cameras to ensure no recording or live-feed impact.`,
    );
  }
  if (original.name.startsWith(TEST_PREFIX) || original.name.includes('MCP-VERIFY')) {
    throw new Error(
      `aborting: camera name "${original.name}" looks like a leftover from a previous test run. ` +
      `Manually revert it in the Protect UI before running this script again.`,
    );
  }

  const testName = `${original.name}-${TEST_PREFIX}${String(Date.now())}`;

  // Phase 2 — mutate (rename to test value)
  console.error(`[verify-mutations] MUTATE: PATCH /v1/cameras/${cameraId} name -> "${testName}"`);
  const mutExec = new ExecuteExecutor({
    tenant,
    protectSpec,
    limits: { maxCallsPerExecute: 5, timeoutMs: 30_000 },
  });
  const mutResult = await mutExec.execute(`
    var p = unifi.local.protect;
    var patched = p.request({
      method: 'PATCH',
      path: '/v1/cameras/${cameraId}',
      body: { name: ${JSON.stringify(testName)} },
    });
    var verify = p.request({ method: 'GET', path: '/v1/cameras/${cameraId}' });
    ({ patched: { id: patched.id, name: patched.name }, verified: { id: verify.id, name: verify.name, state: verify.state } });
  `);
  if (!mutResult.ok) {
    console.error(`[verify-mutations] FATAL: mutate phase failed — name should still be "${original.name}". Verify in UI.`);
    console.error(`[verify-mutations] error: ${mutResult.error ?? 'unknown'}`);
    process.exit(1);
  }
  const mutData = mutResult.data as { patched: CameraSnapshot; verified: CameraSnapshot };
  console.error(`[verify-mutations] MID  : name="${mutData.verified.name}" (PATCH echo: "${mutData.patched.name}")`);

  if (mutData.verified.name !== testName) {
    console.error(`[verify-mutations] WARN : verify GET returned "${mutData.verified.name}" but expected "${testName}". Continuing to revert.`);
  }

  // Phase 3 — revert (regardless of whether mutate fully succeeded)
  console.error(`[verify-mutations] REVERT: PATCH /v1/cameras/${cameraId} name -> "${original.name}" (original)`);
  const revExec = new ExecuteExecutor({
    tenant,
    protectSpec,
    limits: { maxCallsPerExecute: 5, timeoutMs: 30_000 },
  });
  const revResult = await revExec.execute(`
    var p = unifi.local.protect;
    var patched = p.request({
      method: 'PATCH',
      path: '/v1/cameras/${cameraId}',
      body: { name: ${JSON.stringify(original.name)} },
    });
    var verify = p.request({ method: 'GET', path: '/v1/cameras/${cameraId}' });
    ({ patched: { id: patched.id, name: patched.name }, verified: { id: verify.id, name: verify.name, state: verify.state } });
  `);
  if (!revResult.ok) {
    console.error(`[verify-mutations] FATAL: REVERT FAILED. Camera name is currently "${testName}". MANUALLY REVERT IN THE PROTECT UI to "${original.name}".`);
    console.error(`[verify-mutations] error: ${revResult.error ?? 'unknown'}`);
    process.exit(2);
  }
  const revData = revResult.data as { patched: CameraSnapshot; verified: CameraSnapshot };
  console.error(`[verify-mutations] POST : name="${revData.verified.name}" (PATCH echo: "${revData.patched.name}")`);

  if (revData.verified.name !== original.name) {
    console.error(`[verify-mutations] FATAL: revert GET returned "${revData.verified.name}" but expected "${original.name}". MANUAL REVERT REQUIRED.`);
    process.exit(3);
  }

  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('[verify-mutations] ✓ SUCCESS — round-trip complete, camera restored to original name');
}

main().catch((err: unknown) => {
  console.error('[verify-mutations] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
