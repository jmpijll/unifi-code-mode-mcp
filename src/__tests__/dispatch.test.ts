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
  const fn = vi.fn(async (params: unknown) => ({ status: 200, headers: {}, data: { ok: true, params } }));
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
      headers: undefined,
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
    // Smoke-check by parsing as a Function body — throws SyntaxError on parse failure.
    expect(() => new Function(prelude)).not.toThrow();
  });
});

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
