/**
 * OpenAPI spec loader for UniFi Network (local) and Site Manager (cloud).
 *
 * Network Integration spec: dynamic discovery — call `/v1/info` on the
 * controller to read its `applicationVersion`, then fetch
 *   https://apidoc-cdn.ui.com/network/v<version>/integration.json
 * If the CDN does not host that exact version (Ubiquiti only publishes
 * certain tagged releases), fall back to the latest known-published
 * version. The result is $ref-resolved and cached on disk + in memory.
 *
 * Site Manager spec: try the documented spec URL first, fall back to the
 * curated minimal schema in `cloud-fallback.json` if Ubiquiti hasn't
 * published a machine-readable spec for it yet.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dereference } from '@apidevtools/json-schema-ref-parser';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { buildOperationIndex } from './index-builder.js';
import type { OpenApiDocument, ProcessedSpec } from '../types/spec.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Cache keys ─────────────────────────────────────────────────────

interface SpecCacheKey {
  kind: 'local' | 'cloud' | 'protect';
  version: string;
}

const memoryCache = new Map<string, ProcessedSpec>();

function cacheKeyToString(key: SpecCacheKey): string {
  return `${key.kind}:${key.version}`;
}

function cacheFilePath(cacheDir: string, key: SpecCacheKey): string {
  return resolve(cacheDir, `${key.kind}-v${key.version}.json`);
}

// ─── Public API ─────────────────────────────────────────────────────

export interface LoadLocalSpecOptions {
  /** Base URL of the controller, e.g. https://192.168.1.1 (no path). */
  baseUrl: string;
  /** PEM-encoded CA bundle for TLS verification, or undefined for system CAs. */
  caCert?: string;
  /** Skip TLS verification entirely. Use only when caCert can't be supplied. */
  insecure?: boolean;
  /** API key (X-API-KEY) for the /v1/info call. Optional — older firmware allows anonymous /v1/info. */
  apiKey?: string;
  /** Override the OpenAPI URL — bypasses /v1/info discovery. */
  specUrlOverride?: string;
  /** Where to cache fetched specs on disk. */
  cacheDir: string;
  /** Force re-fetch from network even if cache exists. */
  forceRefresh?: boolean;
  /** Optional callback for non-fatal load warnings (spec fallbacks, etc.). */
  onWarn?: (msg: string) => void;
}

export interface LoadCloudSpecOptions {
  /** Cloud base URL (default https://api.ui.com) */
  baseUrl?: string;
  /** Override the OpenAPI URL. */
  specUrlOverride?: string;
  /** Where to cache fetched specs on disk. */
  cacheDir: string;
  /** Force re-fetch from network even if cache exists. */
  forceRefresh?: boolean;
}

export interface LoadProtectSpecOptions {
  /**
   * Base URL of a controller running Protect, e.g. https://192.168.1.1.
   * Used for /v1/meta/info version discovery if no override is set.
   * Optional — when omitted, version discovery is skipped and we go
   * straight to the candidate-URL ladder + bundled fallback.
   */
  baseUrl?: string;
  /** PEM-encoded CA bundle for the version-discovery call, if any. */
  caCert?: string;
  /** Skip TLS verification on the version-discovery call. */
  insecure?: boolean;
  /** API key for /proxy/protect/integration/v1/meta/info, if used. */
  apiKey?: string;
  /** Force a specific Protect spec URL (highest priority). */
  specUrlOverride?: string;
  /**
   * If true, fall back to the community-maintained beezly/unifi-apis
   * raw URL when neither the override nor an apidoc-cdn.ui.com guess
   * resolves. Off by default — third-party source, no explicit license.
   */
  allowBeezlyFallback?: boolean;
  /** Where to cache fetched specs on disk. */
  cacheDir: string;
  /** Force re-fetch from network even if cache exists. */
  forceRefresh?: boolean;
  /** Optional callback for non-fatal load warnings (spec fallbacks, etc.). */
  onWarn?: (msg: string) => void;
}

/**
 * Discover the controller's app version, then fetch and cache its OpenAPI spec.
 *
 * Errors here are usually fatal at startup in single-user mode but should be
 * tolerated in multi-tenant mode (the server can still start; per-request
 * loading happens lazily).
 */
export async function loadLocalSpec(opts: LoadLocalSpecOptions): Promise<ProcessedSpec> {
  await mkdir(opts.cacheDir, { recursive: true });

  const dispatcher = buildDispatcher({ caCert: opts.caCert, insecure: opts.insecure });

  const onWarn = opts.onWarn ?? (() => undefined);

  let primaryUrl: string;
  let primaryVersion: string;

  if (opts.specUrlOverride) {
    primaryUrl = opts.specUrlOverride;
    primaryVersion = extractVersionFromUrl(primaryUrl) ?? 'override';
  } else {
    const info = await fetchControllerInfo(opts.baseUrl, opts.apiKey, dispatcher);
    primaryVersion = info.applicationVersion;
    primaryUrl = networkSpecUrlForVersion(primaryVersion);
  }

  // Cache lookup by the *requested* version. Multiple controllers reporting
  // the same version share the cache; controllers reporting versions for
  // which only a fallback is available will resolve to the fallback's cache.
  const requestedKey: SpecCacheKey = { kind: 'local', version: primaryVersion };
  const requestedMemoKey = cacheKeyToString(requestedKey);

  if (!opts.forceRefresh) {
    const cached = memoryCache.get(requestedMemoKey);
    if (cached) return cached;

    const onDisk = await readCacheFile(cacheFilePath(opts.cacheDir, requestedKey));
    if (onDisk) {
      memoryCache.set(requestedMemoKey, onDisk);
      return onDisk;
    }
  }

  const fetched = await fetchSpecWithFallbacks(primaryUrl, primaryVersion, onWarn);
  const processed = await processSpec({
    document: fetched.document,
    sourceUrl: fetched.sourceUrl,
    version: fetched.version,
    title: 'UniFi Network Integration API',
    defaultServerPrefix: '/proxy/network/integration',
  });

  // Cache under both the requested and the resolved version so subsequent
  // calls for either skip the fallback ladder.
  memoryCache.set(requestedMemoKey, processed);
  await writeCacheFile(cacheFilePath(opts.cacheDir, requestedKey), processed);
  if (fetched.version !== primaryVersion) {
    const resolvedKey: SpecCacheKey = { kind: 'local', version: fetched.version };
    memoryCache.set(cacheKeyToString(resolvedKey), processed);
    await writeCacheFile(cacheFilePath(opts.cacheDir, resolvedKey), processed);
  }
  return processed;
}

/**
 * Load (and cache) the Site Manager (cloud) OpenAPI spec.
 *
 * The cloud spec URL is checked at runtime; if Ubiquiti hasn't published a
 * machine-readable spec, we fall back to the curated minimal schema bundled
 * in `cloud-fallback.json`.
 */
export async function loadCloudSpec(opts: LoadCloudSpecOptions): Promise<ProcessedSpec> {
  await mkdir(opts.cacheDir, { recursive: true });

  const candidateUrls = opts.specUrlOverride
    ? [opts.specUrlOverride]
    : [
        // Best-effort guesses; first one that works wins.
        'https://apidoc-cdn.ui.com/site-manager/openapi.json',
        'https://api.ui.com/openapi.json',
      ];

  for (const url of candidateUrls) {
    try {
      const document = await fetchSpec(url);
      const version = document.info.version ?? 'unknown';
      const key: SpecCacheKey = { kind: 'cloud', version };
      const processed = await processSpec({
        document,
        sourceUrl: url,
        version,
        title: 'UniFi Site Manager API',
        defaultServerPrefix: '',
      });
      memoryCache.set(cacheKeyToString(key), processed);
      await writeCacheFile(cacheFilePath(opts.cacheDir, key), processed);
      return processed;
    } catch {
      // Try the next candidate.
    }
  }

  // Fallback: ship a curated schema for documented read-only endpoints.
  const fallback = await readFallbackSpec();
  const version = fallback.info.version ?? 'fallback';
  const processed = await processSpec({
    document: fallback,
    sourceUrl: 'embedded:cloud-fallback.json',
    version,
    title: 'UniFi Site Manager API (fallback)',
    defaultServerPrefix: '',
  });
  memoryCache.set(cacheKeyToString({ kind: 'cloud', version }), processed);
  return processed;
}

/**
 * Load (and cache) the UniFi Protect Integration OpenAPI spec.
 *
 * Loading order (first one that succeeds wins):
 *   1. opts.specUrlOverride (full URL — highest priority)
 *   2. apidoc-cdn.ui.com/protect/v<discovered-or-known>/integration.json
 *      (best-effort — Ubiquiti has not confirmed publishing here)
 *   3. The beezly/unifi-apis raw URL for the highest known version,
 *      ONLY if opts.allowBeezlyFallback is true (third-party, no license).
 *   4. The bundled curated fallback at src/spec/protect-fallback.json.
 */
export async function loadProtectSpec(
  opts: LoadProtectSpecOptions,
): Promise<ProcessedSpec> {
  await mkdir(opts.cacheDir, { recursive: true });

  const onWarn = opts.onWarn ?? (() => undefined);
  const dispatcher = buildDispatcher({ caCert: opts.caCert, insecure: opts.insecure });

  let discoveredVersion: string | undefined;
  if (!opts.specUrlOverride && opts.baseUrl) {
    try {
      discoveredVersion = await fetchProtectAppVersion(
        opts.baseUrl,
        opts.apiKey,
        dispatcher,
      );
    } catch (err) {
      onWarn(
        `Could not discover Protect version from ${opts.baseUrl}: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          'Falling back to known-version ladder.',
      );
    }
  }

  const candidateUrls: string[] = [];
  if (opts.specUrlOverride) {
    candidateUrls.push(opts.specUrlOverride);
  } else {
    if (discoveredVersion) {
      candidateUrls.push(protectSpecUrlForVersion(discoveredVersion));
    }
    for (const v of KNOWN_PROTECT_SPEC_VERSIONS) {
      candidateUrls.push(protectSpecUrlForVersion(v));
    }
    if (opts.allowBeezlyFallback) {
      candidateUrls.push(BEEZLY_PROTECT_SPEC_URL);
    }
  }

  for (const url of candidateUrls) {
    const cacheVersionGuess = extractVersionFromUrl(url) ?? discoveredVersion ?? 'remote';
    const requestedKey: SpecCacheKey = { kind: 'protect', version: cacheVersionGuess };
    const requestedMemoKey = cacheKeyToString(requestedKey);

    if (!opts.forceRefresh) {
      const cached = memoryCache.get(requestedMemoKey);
      if (cached) return cached;

      const onDisk = await readCacheFile(cacheFilePath(opts.cacheDir, requestedKey));
      if (onDisk) {
        memoryCache.set(requestedMemoKey, onDisk);
        return onDisk;
      }
    }

    try {
      const document = await fetchSpec(url);
      const version = document.info.version ?? cacheVersionGuess;
      const processed = await processSpec({
        document,
        sourceUrl: url,
        version,
        title: 'UniFi Protect Integration API',
        defaultServerPrefix: '/proxy/protect/integration',
      });
      const resolvedKey: SpecCacheKey = { kind: 'protect', version };
      memoryCache.set(cacheKeyToString(resolvedKey), processed);
      memoryCache.set(requestedMemoKey, processed);
      await writeCacheFile(cacheFilePath(opts.cacheDir, resolvedKey), processed);
      if (resolvedKey.version !== requestedKey.version) {
        await writeCacheFile(cacheFilePath(opts.cacheDir, requestedKey), processed);
      }
      onWarn(
        `Loaded Protect spec ${version} from ${url}` +
          (discoveredVersion && discoveredVersion !== version
            ? ` (controller reported v${discoveredVersion}; spec is the closest known).`
            : '.'),
      );
      return processed;
    } catch {
      // Try the next candidate.
    }
  }

  // Final fallback: ship the bundled curated fragment.
  const fallback = await readProtectFallbackSpec();
  const version = fallback.info.version ?? 'fallback';
  const processed = await processSpec({
    document: fallback,
    sourceUrl: 'embedded:protect-fallback.json',
    version,
    title: 'UniFi Protect Integration API (fallback)',
    defaultServerPrefix: '/proxy/protect/integration',
  });
  memoryCache.set(cacheKeyToString({ kind: 'protect', version }), processed);
  onWarn(
    'Loaded the curated Protect fallback spec (no online spec was reachable). ' +
      'The full Protect surface is wider than the bundled fragment — set UNIFI_PROTECT_SPEC_URL to a complete spec to broaden it.',
  );
  return processed;
}

/** Drop all cached specs (forces re-fetch on next access). */
export function clearSpecCache(): void {
  memoryCache.clear();
}

// ─── Internals ──────────────────────────────────────────────────────

interface ControllerInfo {
  applicationVersion: string;
}

async function fetchControllerInfo(
  baseUrl: string,
  apiKey: string | undefined,
  dispatcher: Dispatcher | undefined,
): Promise<ControllerInfo> {
  const url = joinUrl(baseUrl, '/proxy/network/integration/v1/info');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;

  const res = await undiciFetch(url, {
    method: 'GET',
    headers,
    dispatcher,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${url}: HTTP ${String(res.status)} ${res.statusText}. ` +
        'Check UNIFI_LOCAL_BASE_URL and (if set) UNIFI_LOCAL_API_KEY.',
    );
  }

  const body = (await res.json()) as Record<string, unknown>;
  const version = body['applicationVersion'];
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`Controller /v1/info returned no applicationVersion: ${JSON.stringify(body)}`);
  }
  return { applicationVersion: version };
}

function networkSpecUrlForVersion(version: string): string {
  const v = version.startsWith('v') ? version : `v${version}`;
  return `https://apidoc-cdn.ui.com/network/${v}/integration.json`;
}

function protectSpecUrlForVersion(version: string): string {
  const v = version.startsWith('v') ? version : `v${version}`;
  return `https://apidoc-cdn.ui.com/protect/${v}/integration.json`;
}

/** Community-extracted Protect spec URLs (third-party, no explicit license). */
const BEEZLY_PROTECT_SPEC_URL =
  'https://raw.githubusercontent.com/beezly/unifi-apis/main/unifi-protect/7.1.46.json';

/**
 * Versions of the Network Integration spec we've confirmed are published
 * on apidoc-cdn.ui.com. Used as fallbacks when the controller reports a
 * version the CDN doesn't host (most minor releases don't get re-published).
 *
 * Order: most-recent-known-good first. To extend, simply add a tag here.
 */
export const KNOWN_NETWORK_SPEC_VERSIONS: readonly string[] = ['10.1.84'];

/**
 * Versions of the Protect Integration spec we **guess** Ubiquiti might
 * host on apidoc-cdn.ui.com (analogous to Network's structure). None of
 * these are confirmed; the loader falls through to bundled-fallback if
 * none resolve. Order: most-recent-likely first.
 */
export const KNOWN_PROTECT_SPEC_VERSIONS: readonly string[] = ['7.1.46', '7.0.107'];

async function fetchProtectAppVersion(
  baseUrl: string,
  apiKey: string | undefined,
  dispatcher: Dispatcher | undefined,
): Promise<string> {
  const url = joinUrl(baseUrl, '/proxy/protect/integration/v1/meta/info');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;

  const res = await undiciFetch(url, {
    method: 'GET',
    headers,
    dispatcher,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${url}: HTTP ${String(res.status)} ${res.statusText}. ` +
        'Is the Protect application installed on this controller?',
    );
  }

  const body = (await res.json()) as Record<string, unknown>;
  const version = body['applicationVersion'] ?? body['version'];
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`Protect /v1/meta/info returned no application version: ${JSON.stringify(body)}`);
  }
  return version;
}

function extractVersionFromUrl(url: string): string | undefined {
  const m = /\/v?(\d+\.\d+\.\d+)\//.exec(url);
  return m?.[1];
}

async function fetchSpec(url: string): Promise<OpenApiDocument> {
  const res = await undiciFetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = new Error(`Failed to fetch OpenAPI from ${url}: HTTP ${String(res.status)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const body = (await res.json()) as OpenApiDocument;
  if (typeof body !== 'object' || typeof body.paths !== 'object') {
    throw new Error(`Invalid OpenAPI document at ${url} — missing paths`);
  }
  return body;
}

/**
 * Fetch a spec, falling back through `KNOWN_NETWORK_SPEC_VERSIONS` if the
 * primary URL returns 403/404. Returns `[document, finalSourceUrl, finalVersion]`.
 */
async function fetchSpecWithFallbacks(
  primaryUrl: string,
  primaryVersion: string,
  onWarn: (msg: string) => void,
): Promise<{ document: OpenApiDocument; sourceUrl: string; version: string }> {
  try {
    const document = await fetchSpec(primaryUrl);
    return { document, sourceUrl: primaryUrl, version: primaryVersion };
  } catch (err) {
    const status = (err as Error & { status?: number }).status;
    if (status !== 403 && status !== 404) throw err;
    onWarn(
      `Network spec for v${primaryVersion} not published on apidoc-cdn.ui.com (HTTP ${String(status)}). ` +
        'Falling back to nearest known-good version.',
    );
  }
  let lastErr: unknown;
  for (const v of KNOWN_NETWORK_SPEC_VERSIONS) {
    if (v === primaryVersion) continue;
    const url = networkSpecUrlForVersion(v);
    try {
      const document = await fetchSpec(url);
      onWarn(
        `Loaded Network spec v${v} as a fallback for controller v${primaryVersion}. ` +
          'API surface is generally backwards-compatible; check operationIds if a call fails unexpectedly.',
      );
      return { document, sourceUrl: url, version: v };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `No Network OpenAPI spec available for controller v${primaryVersion} or any known fallback version. ` +
      `Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

interface ProcessSpecArgs {
  document: OpenApiDocument;
  sourceUrl: string;
  version: string;
  title: string;
  /** Default server prefix to apply if none is in the spec. */
  defaultServerPrefix: string;
}

async function processSpec(args: ProcessSpecArgs): Promise<ProcessedSpec> {
  // Resolve $refs in-place. json-schema-ref-parser handles internal + external refs.
  const resolved = (await dereference(
    args.document as unknown as Parameters<typeof dereference>[0],
  )) as unknown as OpenApiDocument;

  const serverPrefix =
    resolved.servers?.[0]?.url && !isAbsoluteUrl(resolved.servers[0].url)
      ? resolved.servers[0].url
      : args.defaultServerPrefix;

  const operations = buildOperationIndex(resolved);

  return {
    sourceUrl: args.sourceUrl,
    version: args.version,
    title: args.title,
    serverPrefix,
    operations,
    document: resolved,
  };
}

function isAbsoluteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

function buildDispatcher(
  opts: { caCert?: string; insecure?: boolean } = {},
): Dispatcher | undefined {
  if (opts.insecure) {
    return new Agent({ connect: { rejectUnauthorized: false } });
  }
  if (opts.caCert) {
    return new Agent({ connect: { ca: opts.caCert } });
  }
  return undefined;
}

async function readCacheFile(path: string): Promise<ProcessedSpec | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as ProcessedSpec;
  } catch {
    return undefined;
  }
}

async function writeCacheFile(path: string, spec: ProcessedSpec): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(spec), 'utf-8');
}

async function readFallbackSpec(): Promise<OpenApiDocument> {
  const path = resolve(__dirname, 'cloud-fallback.json');
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as OpenApiDocument;
}

async function readProtectFallbackSpec(): Promise<OpenApiDocument> {
  const path = resolve(__dirname, 'protect-fallback.json');
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as OpenApiDocument;
}
