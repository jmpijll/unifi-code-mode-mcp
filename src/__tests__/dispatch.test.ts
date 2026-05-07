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

const PROTECT_SPEC_DOC: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Mock Protect', version: 'fallback-1' },
  paths: {
    '/v1/meta/info': {
      get: { operationId: 'getProtectMetaInfo', tags: ['meta'], summary: 'Meta' },
    },
    '/v1/cameras': {
      get: { operationId: 'listCameras', tags: ['cameras'], summary: 'List cameras' },
    },
    '/v1/cameras/{id}': {
      get: {
        operationId: 'getCamera',
        tags: ['cameras'],
        summary: 'Get a camera',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
    '/v1/nvrs': {
      get: { operationId: 'listNvrs', tags: ['nvrs'], summary: 'List NVRs' },
    },
  },
};

const PROTECT_SPEC: ProcessedSpec = {
  sourceUrl: 'mock://protect-spec',
  version: 'fallback-1',
  title: 'Mock Protect',
  serverPrefix: '/proxy/protect/integration',
  operations: buildOperationIndex(PROTECT_SPEC_DOC),
  document: PROTECT_SPEC_DOC,
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

  it('does not emit Protect surfaces unless a Protect spec is given', () => {
    const prelude = buildUnifiPrelude(SPEC, SPEC, {
      exposeCloudNetworkProxy: true,
      exposeLocalProtect: true,
      exposeCloudProtectProxy: true,
    });
    expect(prelude).not.toContain('unifi.local.protect');
    expect(prelude).not.toContain('unifi.cloud.protect = function');
    expect(prelude).not.toContain('__unifiCallLocalProtect');
    expect(prelude).not.toContain('__unifiCallCloudProtect');
  });

  it('emits unifi.local.protect when a Protect spec + exposeLocalProtect are set', () => {
    const prelude = buildUnifiPrelude(SPEC, SPEC, {
      protectSpec: PROTECT_SPEC,
      exposeLocalProtect: true,
    });
    expect(prelude).toContain('unifi.local.protect = protectNs');
    expect(prelude).toContain('protectNs.cameras = {}');
    expect(prelude).toContain('protectNs.cameras.listCameras');
    expect(prelude).toContain('__unifiCallLocalProtect');
    expect(prelude).toContain('__unifiRawLocalProtect');
    expect(() => new Function(prelude)).not.toThrow();
  });

  it('emits unifi.cloud.protect(consoleId) when both Protect spec + cloud spec + exposeCloudProtectProxy are set', () => {
    const prelude = buildUnifiPrelude(SPEC, SPEC, {
      protectSpec: PROTECT_SPEC,
      exposeCloudProtectProxy: true,
    });
    expect(prelude).toContain('unifi.cloud.protect = function');
    expect(prelude).toContain('__unifiCallCloudProtect');
    expect(prelude).toContain('__unifiRawCloudProtect');
    expect(() => new Function(prelude)).not.toThrow();
  });

  it('cloud.protect(consoleId) factory caches per-id and routes to host bindings', () => {
    const prelude = buildUnifiPrelude(SPEC, SPEC, {
      protectSpec: PROTECT_SPEC,
      exposeCloudProtectProxy: true,
    });
    const calls: Array<{ consoleId: string; opId: string; argsJson: string }> = [];
    const stubs = {
      __unifiCallLocal: () => undefined,
      __unifiRawLocal: () => undefined,
      __unifiCallCloud: () => undefined,
      __unifiRawCloud: () => undefined,
      __unifiCallLocalProtect: () => undefined,
      __unifiRawLocalProtect: () => undefined,
      __unifiCallCloudProtect: (consoleId: string, opId: string, argsJson: string) => {
        calls.push({ consoleId, opId, argsJson });
        return { ok: true, consoleId, opId };
      },
      __unifiRawCloudProtect: (consoleId: string, argsJson: string) => {
        calls.push({ consoleId, opId: '<raw>', argsJson });
        return { ok: true, consoleId };
      },
    };

    type SandboxScope = { unifi?: Record<string, unknown> };
    const fn = new Function(
      '__unifiCallLocal',
      '__unifiRawLocal',
      '__unifiCallCloud',
      '__unifiRawCloud',
      '__unifiCallLocalProtect',
      '__unifiRawLocalProtect',
      '__unifiCallCloudProtect',
      '__unifiRawCloudProtect',
      `${prelude}\nreturn unifi;`,
    ) as (...args: unknown[]) => SandboxScope['unifi'];

    const unifi = fn(
      stubs.__unifiCallLocal,
      stubs.__unifiRawLocal,
      stubs.__unifiCallCloud,
      stubs.__unifiRawCloud,
      stubs.__unifiCallLocalProtect,
      stubs.__unifiRawLocalProtect,
      stubs.__unifiCallCloudProtect,
      stubs.__unifiRawCloudProtect,
    );

    const cloud = (unifi as { cloud: { protect: (id: string) => Record<string, unknown> } }).cloud;
    const handleA = cloud.protect('console-A');
    const handleB = cloud.protect('console-A');
    expect(handleA).toBe(handleB);

    const cameras = handleA['cameras'] as Record<string, (args: unknown) => unknown>;
    cameras['listCameras']({});
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ consoleId: 'console-A', opId: 'listCameras' });

    const handleC = cloud.protect('console-B');
    expect(handleC).not.toBe(handleA);
    (handleC as { request: (args: unknown) => unknown }).request({
      method: 'GET',
      path: '/v1/meta/info',
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ consoleId: 'console-B', opId: '<raw>' });
  });

  it('local.protect routes through __unifiCallLocalProtect', () => {
    const prelude = buildUnifiPrelude(SPEC, SPEC, {
      protectSpec: PROTECT_SPEC,
      exposeLocalProtect: true,
    });
    const localProtectCalls: Array<{ opId: string; argsJson: string }> = [];
    type SandboxScope = { unifi?: { local: { protect: Record<string, Record<string, (args: unknown) => unknown>> } } };
    const fn = new Function(
      '__unifiCallLocal',
      '__unifiRawLocal',
      '__unifiCallCloud',
      '__unifiRawCloud',
      '__unifiCallLocalProtect',
      '__unifiRawLocalProtect',
      `${prelude}\nreturn unifi;`,
    ) as (...args: unknown[]) => SandboxScope['unifi'];
    const unifi = fn(
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      (opId: string, argsJson: string) => {
        localProtectCalls.push({ opId, argsJson });
        return { ok: true, opId };
      },
      () => undefined,
    );
    const protect = unifi!.local.protect;
    protect['cameras']!['listCameras']!({});
    protect['nvrs']!['listNvrs']!({});
    expect(localProtectCalls).toEqual([
      { opId: 'listCameras', argsJson: '{}' },
      { opId: 'listNvrs', argsJson: '{}' },
    ]);
  });

  it('attaches cloud.network() factory even when no cloud Site Manager spec is loaded', () => {
    // Cloud-Network proxy is independent of cloudSpec — it reuses Network operation
    // shapes from the local spec. Regression test for the gating bug found during the
    // 2026-05-07 live recon (cloud.network() was missing whenever cloudSpec was absent).
    const prelude = buildUnifiPrelude(SPEC, undefined, { exposeCloudNetworkProxy: true });
    expect(prelude).toContain('unifi.cloud.network = function');
    expect(prelude).toContain('__unifiCallCloudNetwork');
    expect(() => new Function(prelude)).not.toThrow();
  });

  it('cloud.network() works at runtime without a cloud Site Manager spec', () => {
    const prelude = buildUnifiPrelude(SPEC, undefined, { exposeCloudNetworkProxy: true });
    const networkProxyCalls: Array<{ consoleId: string; opId: string }> = [];
    type SandboxScope = { unifi?: { cloud: { network: (id: string) => Record<string, Record<string, (args: unknown) => unknown>> } } };
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
      (consoleId: string, opId: string) => {
        networkProxyCalls.push({ consoleId, opId });
        return { ok: true };
      },
      () => undefined,
    );
    const handle = unifi!.cloud.network('console-A');
    handle['sites']!['getSite']!({ siteId: 'abc' });
    expect(networkProxyCalls).toEqual([{ consoleId: 'console-A', opId: 'getSite' }]);
  });

  it('attaches cloud.protect() factory even when no cloud Site Manager spec is loaded', () => {
    // Cloud-Protect proxy is independent of cloudSpec — it uses the Protect spec.
    // Regression test for the gating bug found during the 2026-05-07 live recon
    // (cloud.protect() was missing whenever cloudSpec was absent, which broke the
    // intended Protect-only deployment shape).
    const prelude = buildUnifiPrelude(SPEC, undefined, {
      protectSpec: PROTECT_SPEC,
      exposeCloudProtectProxy: true,
    });
    expect(prelude).toContain('unifi.cloud.protect = function');
    expect(prelude).toContain('__unifiCallCloudProtect');
    expect(() => new Function(prelude)).not.toThrow();
  });

  it('cloud.protect() works at runtime without a cloud Site Manager spec', () => {
    const prelude = buildUnifiPrelude(undefined, undefined, {
      protectSpec: PROTECT_SPEC,
      exposeCloudProtectProxy: true,
    });
    const protectProxyCalls: Array<{ consoleId: string; opId: string }> = [];
    type SandboxScope = { unifi?: { cloud: { protect: (id: string) => Record<string, Record<string, (args: unknown) => unknown>> } } };
    const fn = new Function(
      '__unifiCallLocal',
      '__unifiRawLocal',
      '__unifiCallCloud',
      '__unifiRawCloud',
      '__unifiCallLocalProtect',
      '__unifiRawLocalProtect',
      '__unifiCallCloudProtect',
      '__unifiRawCloudProtect',
      `${prelude}\nreturn unifi;`,
    ) as (...args: unknown[]) => SandboxScope['unifi'];
    const unifi = fn(
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      (consoleId: string, opId: string) => {
        protectProxyCalls.push({ consoleId, opId });
        return { ok: true };
      },
      () => undefined,
    );
    const handle = unifi!.cloud.protect('console-A');
    handle['cameras']!['listCameras']!({});
    expect(protectProxyCalls).toEqual([{ consoleId: 'console-A', opId: 'listCameras' }]);
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
