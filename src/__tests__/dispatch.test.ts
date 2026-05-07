import { describe, expect, it, vi } from 'vitest';
import {
  buildUnifiPrelude,
  dispatchOperation,
  dispatchRawRequest,
  sanitizeIdentifier,
  UnknownOperationError,
} from '../sandbox/dispatch.js';
import { buildOperationIndex } from '../spec/index-builder.js';
import type { OpenApiDocument, ProcessedSpec } from '../types/spec.js';
import type { HttpClient } from '../client/http.js';

function makeMockClient(): HttpClient & { request: ReturnType<typeof vi.fn> } {
  const fn = vi.fn((params: unknown) =>
    Promise.resolve({ status: 200, headers: {}, data: { ok: true, params } }),
  );
  return { request: fn } as unknown as HttpClient & { request: ReturnType<typeof vi.fn> };
}

const SPEC_DOC: OpenApiDocument = {
  openapi: '3.0.0',
  info: { title: 'Mock', version: '1.0' },
  paths: {
    '/v1/sites/{siteId}': {
      get: {
        operationId: 'getSite',
        tags: ['Sites'],
        summary: 'Get a site',
        parameters: [
          { name: 'siteId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'expand', in: 'query', schema: { type: 'string' } },
        ],
      },
    },
    '/v1/sites/{siteId}/networks': {
      post: {
        operationId: 'createNetwork',
        tags: ['Networks'],
        summary: 'Create a network',
        parameters: [
          { name: 'siteId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/json': {} } },
      },
    },
  },
};

const SPEC: ProcessedSpec = {
  sourceUrl: 'mock://spec',
  version: '1.0',
  title: 'Mock',
  serverPrefix: '',
  operations: buildOperationIndex(SPEC_DOC),
  document: SPEC_DOC,
};

describe('dispatchOperation', () => {
  it('throws UnknownOperationError for missing op', async () => {
    const client = makeMockClient();
    await expect(dispatchOperation(client, SPEC, 'local', 'noSuch', {})).rejects.toBeInstanceOf(
      UnknownOperationError,
    );
  });

  it('auto-routes path and query args by spec', async () => {
    const client = makeMockClient();
    await dispatchOperation(client, SPEC, 'local', 'getSite', {
      siteId: 'abc',
      expand: 'devices',
    });
    expect(client.request).toHaveBeenCalledWith({
      method: 'GET',
      path: '/v1/sites/{siteId}',
      pathParams: { siteId: 'abc' },
      query: { expand: 'devices' },
      body: undefined,
    });
  });

  it('treats non-spec keys as the body when op accepts a body', async () => {
    const client = makeMockClient();
    await dispatchOperation(client, SPEC, 'local', 'createNetwork', {
      siteId: 'abc',
      name: 'net1',
      vlan: 10,
    });
    expect(client.request).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/sites/{siteId}/networks',
      pathParams: { siteId: 'abc' },
      query: undefined,
      body: { name: 'net1', vlan: 10 },
    });
  });

  it('passes through explicit pathParams/query/body args verbatim', async () => {
    const client = makeMockClient();
    await dispatchOperation(client, SPEC, 'local', 'getSite', {
      pathParams: { siteId: 'overridden' },
      query: { expand: 'all' },
    });
    expect(client.request).toHaveBeenCalledWith({
      method: 'GET',
      path: '/v1/sites/{siteId}',
      pathParams: { siteId: 'overridden' },
      query: { expand: 'all' },
      body: undefined,
    });
  });

  it('merges convenience path params with an explicit body (mixed-style call)', async () => {
    // Regression: the natural shape for an update is
    // `{ siteId, body: { ... } }`. Earlier the dispatcher's "explicit" branch
    // bailed out on auto-routing whenever any of pathParams/query/body/headers
    // was supplied, which left {siteId} unsubstituted in the URL.
    const client = makeMockClient();
    await dispatchOperation(client, SPEC, 'local', 'createNetwork', {
      siteId: 'abc',
      body: { name: 'net1', vlan: 10 },
    });
    expect(client.request).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/sites/{siteId}/networks',
      pathParams: { siteId: 'abc' },
      query: undefined,
      body: { name: 'net1', vlan: 10 },
    });
  });

  it('mixes convenience query params with explicit headers', async () => {
    const client = makeMockClient();
    await dispatchOperation(client, SPEC, 'local', 'getSite', {
      siteId: 'abc',
      expand: 'devices',
      headers: { 'X-Custom': 'value' },
    });
    expect(client.request).toHaveBeenCalledWith({
      method: 'GET',
      path: '/v1/sites/{siteId}',
      pathParams: { siteId: 'abc' },
      query: { expand: 'devices' },
      body: undefined,
      headers: { 'X-Custom': 'value' },
    });
  });
});

describe('dispatchRawRequest', () => {
  it('rejects missing path', async () => {
    const client = makeMockClient();
    await expect(dispatchRawRequest(client, { path: undefined as unknown as string })).rejects.toThrow(
      /string `path`/,
    );
  });

  it('passes args through to client.request', async () => {
    const client = makeMockClient();
    await dispatchRawRequest(client, { method: 'GET', path: '/v1/info' });
    expect(client.request).toHaveBeenCalledWith({ method: 'GET', path: '/v1/info' });
  });
});

// Tests below intentionally use `new Function(...)` to evaluate the generated
// sandbox prelude in the host's V8 — that's the cheapest way to verify it parses
// and runs correctly. The real sandbox uses QuickJS WASM, so this is test-only.
/* eslint-disable @typescript-eslint/no-implied-eval, @typescript-eslint/no-non-null-assertion */
describe('buildUnifiPrelude', () => {
  it('builds tag-grouped methods', () => {
    const prelude = buildUnifiPrelude(SPEC, undefined);
    expect(prelude).toContain('unifi.local');
    expect(prelude).toContain('ns.sites');
    expect(prelude).toContain('ns.sites.getSite');
    expect(prelude).toContain('ns.networks.createNetwork');
    expect(prelude).toContain('__unifiCallLocal');
    expect(prelude).toContain('unifi.cloud = { __missing: true');
  });

  it('produces a syntactically valid script', () => {
    const prelude = buildUnifiPrelude(SPEC, SPEC);
    expect(() => new Function(prelude)).not.toThrow();
  });

  it('does not emit cloud.network() unless explicitly enabled', () => {
    const prelude = buildUnifiPrelude(SPEC, SPEC);
    expect(prelude).not.toContain('unifi.cloud.network = function');
    expect(prelude).not.toContain('__unifiCallCloudNetwork');
  });

  it('emits cloud.network() factory when proxy surface is enabled', () => {
    const prelude = buildUnifiPrelude(SPEC, SPEC, { exposeCloudNetworkProxy: true });
    expect(prelude).toContain('unifi.cloud.network = function');
    expect(prelude).toContain('__unifiCallCloudNetwork');
    expect(prelude).toContain('__unifiRawCloudNetwork');
    expect(() => new Function(prelude)).not.toThrow();
  });

  it('skips cloud.network() when local Network spec is missing', () => {
    const prelude = buildUnifiPrelude(undefined, SPEC, { exposeCloudNetworkProxy: true });
    expect(prelude).not.toContain('unifi.cloud.network = function');
  });

  it('cloud.network(consoleId) factory caches per-id and routes to host bindings', () => {
    const prelude = buildUnifiPrelude(SPEC, SPEC, { exposeCloudNetworkProxy: true });
    const calls: Array<{ consoleId: string; opId: string; argsJson: string }> = [];
    const sandbox = {
      __unifiCallLocal: () => undefined,
      __unifiRawLocal: () => undefined,
      __unifiCallCloud: () => undefined,
      __unifiRawCloud: () => undefined,
      __unifiCallCloudNetwork: (consoleId: string, opId: string, argsJson: string) => {
        calls.push({ consoleId, opId, argsJson });
        return { ok: true, consoleId, opId };
      },
      __unifiRawCloudNetwork: (consoleId: string, argsJson: string) => {
        calls.push({ consoleId, opId: '<raw>', argsJson });
        return { ok: true, consoleId };
      },
    };

    type SandboxScope = typeof sandbox & { unifi?: Record<string, unknown> };
    const fn = new Function(
      '__unifiCallLocal',
      '__unifiRawLocal',
      '__unifiCallCloud',
      '__unifiRawCloud',
      '__unifiCallCloudNetwork',
      '__unifiRawCloudNetwork',
      `${prelude}\nreturn unifi;`,
    ) as (...args: unknown[]) => SandboxScope['unifi'];

    const unifi = fn(
      sandbox.__unifiCallLocal,
      sandbox.__unifiRawLocal,
      sandbox.__unifiCallCloud,
      sandbox.__unifiRawCloud,
      sandbox.__unifiCallCloudNetwork,
      sandbox.__unifiRawCloudNetwork,
    );

    expect(unifi).toBeDefined();
    const cloud = (unifi as { cloud: { network: (id: string) => Record<string, unknown> } }).cloud;
    const handleA = cloud.network('console-A');
    const handleB = cloud.network('console-A');
    expect(handleA).toBe(handleB);

    const sites = handleA['sites'] as Record<string, (args: unknown) => unknown>;
    sites['getSite']({ siteId: 'abc' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ consoleId: 'console-A', opId: 'getSite' });

    const handleC = cloud.network('console-B');
    expect(handleC).not.toBe(handleA);
    (handleC as { request: (args: unknown) => unknown }).request({
      method: 'GET',
      path: '/v1/info',
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ consoleId: 'console-B', opId: '<raw>' });
  });

  it('cloud.network() rejects empty consoleId', () => {
    const prelude = buildUnifiPrelude(SPEC, SPEC, { exposeCloudNetworkProxy: true });
    type SandboxScope = { unifi?: { cloud: { network: (id: unknown) => unknown } } };
    const fn = new Function(
      '__unifiCallLocal',
      '__unifiRawLocal',
      '__unifiCallCloud',
      '__unifiRawCloud',
      '__unifiCallCloudNetwork',
      '__unifiRawCloudNetwork',
      `${prelude}\nreturn unifi;`,
    ) as (...args: unknown[]) => SandboxScope['unifi'];
    const unifi = fn(
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
    );
    expect(() => unifi!.cloud.network('')).toThrow(/consoleId/);
    expect(() => unifi!.cloud.network(undefined)).toThrow(/consoleId/);
  });
});
/* eslint-enable @typescript-eslint/no-implied-eval, @typescript-eslint/no-non-null-assertion */

describe('sanitizeIdentifier', () => {
  it('replaces non-identifier chars', () => {
    expect(sanitizeIdentifier('foo-bar.baz')).toBe('foo_bar_baz');
  });
  it('prefixes digits', () => {
    expect(sanitizeIdentifier('1foo')).toBe('_1foo');
  });
  it('escapes reserved words', () => {
    expect(sanitizeIdentifier('class')).toBe('class_');
    expect(sanitizeIdentifier('return')).toBe('return_');
  });
});
