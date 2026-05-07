#!/usr/bin/env tsx
/**
 * Live mutation verification — RTSPS stream toggle round-trip.
 *
 * Drives a self-reverting mutation through the unifi.local.protect.*
 * sandbox surface against a real UDM-Pro:
 *
 *   GET    /v1/cameras/{id}/rtsps-stream  → snapshot original state
 *   DELETE /v1/cameras/{id}/rtsps-stream?qualities=high
 *                                         → tear down 'high' stream
 *   GET    /v1/cameras/{id}/rtsps-stream  → confirm 'high' is null
 *   POST   /v1/cameras/{id}/rtsps-stream  body { qualities: ['high'] }
 *                                         → re-create 'high' stream
 *   GET    /v1/cameras/{id}/rtsps-stream  → confirm 'high' is back
 *                                            (token will differ — expected)
 *
 * Hard preconditions to keep this safe:
 *   - Target camera MUST be DISCONNECTED (no live stream consumers
 *     can possibly be impacted)
 *   - Original state MUST be exactly "high enabled, medium/low/package
 *     null" — that's the canonical homelab Tuin state. Anything else
 *     means the camera is being managed by a human and we should not
 *     touch it.
 *   - If revert (POST) fails, exit non-zero and shout loudly so the
 *     operator can manually re-enable in the Protect UI.
 *
 * NOTE: re-creating an RTSPS stream issues a NEW token. The old URL
 * in the prior GET response is cosmetically replaced. Any external
 * consumer (Home Assistant, NVR backup, etc.) caching the old URL
 * will need to refresh. Tuin is DISCONNECTED so this is a no-op for
 * any live consumer.
 *
 * Usage:
 *   UNIFI_LOCAL_BASE_URL=https://172.27.1.1 \
 *     UNIFI_LOCAL_INSECURE=true \
 *     OP_LOCAL_REF='op://AI Agents/Unifi local api key/password' \
 *     npx tsx scripts/verify-mutations-rtsps.ts <cameraId>
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

const cameraId = process.argv[2] ?? '<camera-id>';

interface RtspsState {
  high: string | null;
  medium: string | null;
  low: string | null;
  package: string | null;
}

interface CameraSnapshot {
  id: string;
  name: string;
  state: string;
}

function getKey(): string {
  const fromEnv = process.env['UNIFI_LOCAL_API_KEY'];
  if (fromEnv) return fromEnv;
  return execSync(`op read ${JSON.stringify(OP_LOCAL_REF)}`, { encoding: 'utf-8' }).trim();
}

function isOnlyHighEnabled(s: RtspsState): boolean {
  return typeof s.high === 'string' && s.high.length > 0
    && s.medium === null && s.low === null && s.package === null;
}

function describe(s: RtspsState): string {
  const enabled = (Object.keys(s) as Array<keyof RtspsState>)
    .filter((k) => {
      const v = s[k];
      return typeof v === 'string' && v.length > 0;
    });
  return enabled.length === 0 ? '<all null>' : enabled.join(',');
}

async function main(): Promise<void> {
  const baseUrl = process.env['UNIFI_LOCAL_BASE_URL'];
  if (!baseUrl) throw new Error('UNIFI_LOCAL_BASE_URL is required');
  const apiKey = getKey();
  const insecure = process.env['UNIFI_LOCAL_INSECURE'] === 'true';

  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error(`[verify-mutations-rtsps] target ${baseUrl}, camera ${cameraId}`);

  const protectSpec = await loadProtectSpec({
    baseUrl,
    apiKey,
    insecure,
    cacheDir: resolve(process.cwd(), 'src/spec/cache'),
    onWarn: (m) => { console.error(`[verify-mutations-rtsps][warn] ${m}`); },
  });
  console.error(
    `[verify-mutations-rtsps] protect spec ${protectSpec.title} v${protectSpec.version} (${String(protectSpec.operations.length)} ops)`,
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
    var rt = p.request({ method: 'GET', path: '/v1/cameras/${cameraId}/rtsps-stream' });
    ({ camera: { id: cam.id, name: cam.name, state: cam.state }, rtsps: rt });
  `);
  if (!preResult.ok) throw new Error(`pre-flight read failed: ${preResult.error ?? 'unknown'}`);
  const pre = preResult.data as { camera: CameraSnapshot; rtsps: RtspsState };
  console.error(`[verify-mutations-rtsps] PRE  : id=${pre.camera.id} name="${pre.camera.name}" state=${pre.camera.state} rtsps=${describe(pre.rtsps)}`);

  if (pre.camera.state !== 'DISCONNECTED') {
    throw new Error(
      `aborting: camera is in state ${pre.camera.state}, not DISCONNECTED. ` +
      `This script only mutates DISCONNECTED cameras to ensure no live-stream impact.`,
    );
  }
  if (!isOnlyHighEnabled(pre.rtsps)) {
    throw new Error(
      `aborting: rtsps state is "${describe(pre.rtsps)}" but expected "high" only. ` +
      `Refusing to touch a camera that's been manually re-configured. ` +
      `Restore the camera to high-only RTSPS in the Protect UI before re-running.`,
    );
  }
  const originalHighUrl = pre.rtsps.high as string;

  // Phase 2 — mutate (DELETE high)
  console.error(`[verify-mutations-rtsps] MUTATE: DELETE /v1/cameras/${cameraId}/rtsps-stream?qualities=high`);
  const mutExec = new ExecuteExecutor({
    tenant,
    protectSpec,
    limits: { maxCallsPerExecute: 5, timeoutMs: 30_000 },
  });
  const mutResult = await mutExec.execute(`
    var p = unifi.local.protect;
    p.request({
      method: 'DELETE',
      path: '/v1/cameras/${cameraId}/rtsps-stream',
      query: { qualities: ['high'] },
    });
    var verify = p.request({
      method: 'GET',
      path: '/v1/cameras/${cameraId}/rtsps-stream',
    });
    verify;
  `);
  if (!mutResult.ok) {
    console.error(`[verify-mutations-rtsps] FATAL: mutate phase failed — rtsps state should still be "${describe(pre.rtsps)}". Verify in UI.`);
    console.error(`[verify-mutations-rtsps] error: ${mutResult.error ?? 'unknown'}`);
    process.exit(1);
  }
  const midState = mutResult.data as RtspsState;
  console.error(`[verify-mutations-rtsps] MID  : rtsps=${describe(midState)} (high=${midState.high === null ? 'null' : 'STILL SET'})`);

  // Phase 3 — revert (POST recreate)
  console.error(`[verify-mutations-rtsps] REVERT: POST /v1/cameras/${cameraId}/rtsps-stream body={qualities:['high']}`);
  const revExec = new ExecuteExecutor({
    tenant,
    protectSpec,
    limits: { maxCallsPerExecute: 5, timeoutMs: 30_000 },
  });
  const revResult = await revExec.execute(`
    var p = unifi.local.protect;
    var created = p.request({
      method: 'POST',
      path: '/v1/cameras/${cameraId}/rtsps-stream',
      body: { qualities: ['high'] },
    });
    var verify = p.request({
      method: 'GET',
      path: '/v1/cameras/${cameraId}/rtsps-stream',
    });
    ({ created: created, verified: verify });
  `);
  if (!revResult.ok) {
    console.error(`[verify-mutations-rtsps] FATAL: REVERT FAILED. Camera "${pre.camera.name}" currently has rtsps=${describe(midState)}. MANUALLY RE-ENABLE the "high" RTSPS stream in the Protect UI for camera ${cameraId}.`);
    console.error(`[verify-mutations-rtsps] error: ${revResult.error ?? 'unknown'}`);
    process.exit(2);
  }
  const rev = revResult.data as { created: RtspsState; verified: RtspsState };
  console.error(`[verify-mutations-rtsps] POST : rtsps=${describe(rev.verified)} (high token rotated: ${String(rev.verified.high !== originalHighUrl)})`);

  if (!isOnlyHighEnabled(rev.verified)) {
    console.error(`[verify-mutations-rtsps] FATAL: post-revert state is "${describe(rev.verified)}" but expected "high" only. MANUAL FIX REQUIRED in the Protect UI.`);
    process.exit(3);
  }

  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('[verify-mutations-rtsps] ✓ SUCCESS — round-trip complete, "high" RTSPS stream restored (with new token)');
}

main().catch((err: unknown) => {
  console.error('[verify-mutations-rtsps] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
