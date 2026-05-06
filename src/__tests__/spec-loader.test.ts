import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Undici from 'undici';

const fetchMock = vi.fn<(url: string | URL, init?: unknown) => Promise<Response>>();
vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof Undici>('undici');
  return {
    ...actual,
    fetch: (url: string | URL, init?: unknown) => fetchMock(url, init),
  };
});

const { clearSpecCache, KNOWN_NETWORK_SPEC_VERSIONS, loadLocalSpec } = await import(
  '../spec/loader.js'
);

const MOCK_SPEC = {
  openapi: '3.0.0',
  info: { title: 'Mock UniFi', version: '10.1.84' },
  paths: {
    '/v1/sites': {
      get: {
        operationId: 'getSiteOverviewPage',
        tags: ['Sites'],
        summary: 'List sites',
        parameters: [],
      },
    },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'unifi-spec-cache-'));
  fetchMock.mockReset();
  clearSpecCache();
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('loadLocalSpec', () => {
  it('exposes a non-empty list of known fallback versions', () => {
    expect(KNOWN_NETWORK_SPEC_VERSIONS.length).toBeGreaterThan(0);
    expect(KNOWN_NETWORK_SPEC_VERSIONS).toContain('10.1.84');
  });

  it('falls back to the next-known version when the requested one returns 403', async () => {
    const seen: string[] = [];
    fetchMock.mockImplementation((url) => {
      const u = String(url);
      seen.push(u);
      if (u.includes('v10.3.58')) return Promise.resolve(new Response('forbidden', { status: 403 }));
      if (u.includes('v10.1.84')) return Promise.resolve(jsonResponse(MOCK_SPEC));
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });

    const warnings: string[] = [];
    const spec = await loadLocalSpec({
      baseUrl: 'https://controller.example',
      apiKey: 'k',
      specUrlOverride: 'https://apidoc-cdn.ui.com/network/v10.3.58/integration.json',
      cacheDir,
      onWarn: (msg) => warnings.push(msg),
    });

    expect(spec.title).toBe('UniFi Network Integration API');
    expect(spec.version).toBe('10.1.84');
    expect(spec.operations).toHaveLength(1);
    expect(spec.operations[0]?.operationId).toBe('getSiteOverviewPage');
    expect(seen.some((u) => u.includes('v10.3.58'))).toBe(true);
    expect(seen.some((u) => u.includes('v10.1.84'))).toBe(true);
    expect(warnings.some((w) => /not published/i.test(w))).toBe(true);
    expect(warnings.some((w) => /fallback/i.test(w))).toBe(true);
  });

  it('does not fall back on non-403/404 errors', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('internal', { status: 500 })));
    await expect(
      loadLocalSpec({
        baseUrl: 'https://controller.example',
        apiKey: 'k',
        specUrlOverride: 'https://apidoc-cdn.ui.com/network/v10.3.58/integration.json',
        cacheDir,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('caches the resolved spec under both requested and resolved versions', async () => {
    fetchMock.mockImplementation((url) => {
      const u = String(url);
      if (u.includes('v10.3.58'))
        return Promise.resolve(new Response('forbidden', { status: 403 }));
      return Promise.resolve(jsonResponse(MOCK_SPEC));
    });

    await loadLocalSpec({
      baseUrl: 'https://controller.example',
      apiKey: 'k',
      specUrlOverride: 'https://apidoc-cdn.ui.com/network/v10.3.58/integration.json',
      cacheDir,
    });
    const callsAfterFirst = fetchMock.mock.calls.length;

    // Second call for v10.3.58 → memory cache hit.
    await loadLocalSpec({
      baseUrl: 'https://controller.example',
      apiKey: 'k',
      specUrlOverride: 'https://apidoc-cdn.ui.com/network/v10.3.58/integration.json',
      cacheDir,
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);

    // Call for v10.1.84 directly → also memory cache hit (same processed spec).
    await loadLocalSpec({
      baseUrl: 'https://controller.example',
      apiKey: 'k',
      specUrlOverride: 'https://apidoc-cdn.ui.com/network/v10.1.84/integration.json',
      cacheDir,
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });
});
