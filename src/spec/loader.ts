/**
 * OpenAPI spec loader for UniFi Network (local) and Site Manager (cloud).
 *
 * Network Integration spec: dynamic discovery — call `/v1/info` on the
 * controller to read its `applicationVersion`, then fetch
 *   https://apidoc-cdn.ui.com/network/v<version>/integration.json
 * The result is $ref-resolved and cached on disk + in memory keyed by version.
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
  kind: 'local' | 'cloud';
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

  let specUrl: string;
  let version: string;

  if (opts.specUrlOverride) {
    specUrl = opts.specUrlOverride;
    version = extractVersionFromUrl(specUrl) ?? 'override';
  } else {
    const info = await fetchControllerInfo(opts.baseUrl, opts.apiKey, dispatcher);
    version = info.applicationVersion;
    specUrl = networkSpecUrlForVersion(version);
  }

  const key: SpecCacheKey = { kind: 'local', version };
  const memoKey = cacheKeyToString(key);

  if (!opts.forceRefresh) {
    const cached = memoryCache.get(memoKey);
    if (cached) return cached;

    const onDisk = await readCacheFile(cacheFilePath(opts.cacheDir, key));
    if (onDisk) {
      memoryCache.set(memoKey, onDisk);
      return onDisk;
    }
  }

  const document = await fetchSpec(specUrl);
  const processed = await processSpec({
    document,
    sourceUrl: specUrl,
    version,
    title: 'UniFi Network Integration API',
    defaultServerPrefix: '/proxy/network/integration',
  });

  memoryCache.set(memoKey, processed);
  await writeCacheFile(cacheFilePath(opts.cacheDir, key), processed);
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
    throw new Error(`Failed to fetch OpenAPI from ${url}: HTTP ${String(res.status)}`);
  }
  const body = (await res.json()) as OpenApiDocument;
  if (typeof body !== 'object' || typeof body.paths !== 'object') {
    throw new Error(`Invalid OpenAPI document at ${url} — missing paths`);
  }
  return body;
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
