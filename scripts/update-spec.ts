#!/usr/bin/env tsx
/**
 * Manual spec refresh — fetches the local + cloud OpenAPI specs, writes them
 * into `src/spec/cache/`, and prints a summary diff against the previous
 * cached version (operation counts, added / removed / changed paths).
 *
 * Usage:
 *   npm run update-spec               # uses env credentials for /v1/info
 *   UNIFI_LOCAL_SPEC_URL=... npm run update-spec
 */

import { resolve } from 'node:path';
import { loadCloudSpec, loadLocalSpec } from '../src/spec/loader.js';
import { specSummary } from '../src/spec/index.js';

async function main(): Promise<void> {
  const cacheDir = resolve(process.cwd(), 'src/spec/cache');

  if (process.env['UNIFI_LOCAL_BASE_URL'] && process.env['UNIFI_LOCAL_API_KEY']) {
    console.error('[update-spec] refreshing local spec');
    const spec = await loadLocalSpec({
      baseUrl: process.env['UNIFI_LOCAL_BASE_URL'],
      apiKey: process.env['UNIFI_LOCAL_API_KEY'],
      ...(process.env['UNIFI_LOCAL_SPEC_URL']
        ? { specUrlOverride: process.env['UNIFI_LOCAL_SPEC_URL'] }
        : {}),
      ...(process.env['UNIFI_LOCAL_INSECURE'] === 'true' ? { insecure: true } : {}),
      cacheDir,
      forceRefresh: true,
    });
    const sum = specSummary(spec);
    console.error(
      `[update-spec] local: ${sum.title} v${sum.version} — ${String(sum.operationCount)} ops`,
    );
  } else {
    console.error(
      '[update-spec] skipping local (set UNIFI_LOCAL_BASE_URL + UNIFI_LOCAL_API_KEY to refresh)',
    );
  }

  console.error('[update-spec] refreshing cloud spec');
  const cloud = await loadCloudSpec({ cacheDir, forceRefresh: true });
  const cloudSum = specSummary(cloud);
  console.error(
    `[update-spec] cloud: ${cloudSum.title} v${cloudSum.version} — ${String(cloudSum.operationCount)} ops`,
  );
}

main().catch((err: unknown) => {
  console.error('[update-spec] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
