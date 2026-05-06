import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecuteExecutor } from '../sandbox/execute-executor.js';
import { SearchExecutor } from '../sandbox/search-executor.js';
import { buildOperationIndex } from '../spec/index-builder.js';
import { buildContextFromEnv } from '../tenant/context.js';
import type { OpenApiDocument, ProcessedSpec } from '../types/spec.js';
import type { HttpClient } from '../client/http.js';

const SPEC_DOC: OpenApiDocument = {
  openapi: '3.0.0',
  info: { title: 'Mock UniFi', version: '1.0' },
  paths: {
    '/v1/sites': {
      get: {
        operationId: 'listSites',
        tags: ['Sites'],
        summary: 'List sites',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
      },
    },
    '/v1/sites/{siteId}/devices': {
      get: {
        operationId: 'listDevices',
        tags: ['Devices'],
        summary: 'List devices',
        parameters: [
          { name: 'siteId', in: 'path', required: true, schema: { type: 'string' } },
        ],
      },
    },
  },
};

const SPEC: ProcessedSpec = {
  sourceUrl: 'mock://spec',
  version: '1.0',
  title: 'Mock UniFi',
  serverPrefix: '',
  operations: buildOperationIndex(SPEC_DOC),
  document: SPEC_DOC,
};

function makeMockClient(): HttpClient & { request: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(async (params: unknown) => {
    void params;
    return {
      status: 200,
      headers: {},
      data: {
        data: [
          { id: 's1', name: 'Site 1' },
          { id: 's2', name: 'Site 2' },
        ],
      },
    };
  });
  return { request: fn } as unknown as HttpClient & { request: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SearchExecutor', () => {
  it('returns spec data via simple JS', async () => {
    const exec = new SearchExecutor({ local: SPEC });
    const result = await exec.execute('spec.local.title');
    expect(result.ok).toBe(true);
    expect(result.data).toBe('Mock UniFi');
  });

  it('exposes searchOperations', async () => {
    const exec = new SearchExecutor({ local: SPEC });
    const result = await exec.execute('searchOperations("local", "site").length');
    expect(result.ok).toBe(true);
    expect(typeof result.data).toBe('number');
    expect(result.data as number).toBeGreaterThan(0);
  });

  it('returns null when namespace has no spec', async () => {
    const exec = new SearchExecutor({ local: SPEC });
    const result = await exec.execute('spec.cloud');
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });

  it('captures console.log', async () => {
    const exec = new SearchExecutor({ local: SPEC });
    const result = await exec.execute('console.log("hello"); 42');
    expect(result.logs.some((l) => l.message.includes('hello'))).toBe(true);
  });
});

describe('ExecuteExecutor', () => {
  it('dispatches a typed operation call', async () => {
    const client = makeMockClient();
    const tenant = buildContextFromEnv({
      UNIFI_LOCAL_API_KEY: 'k',
      UNIFI_LOCAL_BASE_URL: 'https://x',
    });
    const exec = new ExecuteExecutor({
      tenant,
      localSpec: SPEC,
      buildLocalClient: () => client,
    });

    const code = `
      (async function() {
        var r = await unifi.local.sites.listSites({ limit: 200 });
        return r;
      })()
    `;
    const result = await exec.execute(code);
    expect(result.ok).toBe(true);
    expect(client.request).toHaveBeenCalledWith({
      method: 'GET',
      path: '/v1/sites',
      pathParams: undefined,
      query: { limit: 200 },
      body: undefined,
    });
  });

  it('enforces the per-execute call budget', async () => {
    const client = makeMockClient();
    const tenant = buildContextFromEnv({
      UNIFI_LOCAL_API_KEY: 'k',
      UNIFI_LOCAL_BASE_URL: 'https://x',
    });
    const exec = new ExecuteExecutor({
      tenant,
      localSpec: SPEC,
      buildLocalClient: () => client,
      limits: { maxCallsPerExecute: 2 },
    });
    const code = `
      (async function() {
        var calls = [];
        for (var i = 0; i < 5; i++) {
          calls.push(unifi.local.sites.listSites({ limit: 10 }));
        }
        return await Promise.all(calls);
      })()
    `;
    const result = await exec.execute(code);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/call limit exceeded/i);
  });

  it('rejects calls when credentials are missing', async () => {
    const tenant = buildContextFromEnv({});
    const exec = new ExecuteExecutor({
      tenant,
      localSpec: SPEC,
    });
    const code = `
      (async function() {
        return await unifi.local.sites.listSites({});
      })()
    `;
    const result = await exec.execute(code);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing-credentials|MissingCredentialsError/i);
  });

  it('rejects calls when local spec is not loaded', async () => {
    const tenant = buildContextFromEnv({
      UNIFI_LOCAL_API_KEY: 'k',
      UNIFI_LOCAL_BASE_URL: 'https://x',
    });
    const exec = new ExecuteExecutor({ tenant });
    const code = `
      (async function() {
        try {
          return await unifi.local.request({ method: 'GET', path: '/v1/info' });
        } catch (err) {
          return 'error: ' + err.message;
        }
      })()
    `;
    const result = await exec.execute(code);
    expect(result.ok).toBe(true);
    expect(String(result.data)).toMatch(/no spec loaded/i);
  });

  it('honors raw request escape hatch', async () => {
    const client = makeMockClient();
    const tenant = buildContextFromEnv({
      UNIFI_LOCAL_API_KEY: 'k',
      UNIFI_LOCAL_BASE_URL: 'https://x',
    });
    const exec = new ExecuteExecutor({
      tenant,
      localSpec: SPEC,
      buildLocalClient: () => client,
    });
    const code = `
      (async function() {
        return await unifi.local.request({ method: 'GET', path: '/v1/anything', query: { a: 1 } });
      })()
    `;
    const result = await exec.execute(code);
    expect(result.ok).toBe(true);
    expect(client.request).toHaveBeenCalledWith({
      method: 'GET',
      path: '/v1/anything',
      query: { a: 1 },
    });
  });
});
