import { describe, expect, it } from 'vitest';
import {
  buildOperationIndex,
  normalizeTag,
  synthesizeOperationId,
} from '../spec/index-builder.js';
import { findOperation, searchOperations, summarizeOperation } from '../spec/index.js';
import type { OpenApiDocument, ProcessedSpec } from '../types/spec.js';

const MOCK_SPEC: OpenApiDocument = {
  openapi: '3.0.0',
  info: { title: 'Mock', version: '1.0.0' },
  paths: {
    '/v1/sites': {
      get: {
        operationId: 'listSites',
        tags: ['Sites'],
        summary: 'List sites',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'offset', in: 'query', schema: { type: 'integer' } },
        ],
      },
      post: {
        operationId: 'createSite',
        tags: ['Sites'],
        summary: 'Create a site',
        requestBody: { required: true, content: { 'application/json': {} } },
      },
    },
    '/v1/sites/{siteId}': {
      get: {
        operationId: 'getSite',
        tags: ['Sites'],
        summary: 'Get a site',
        parameters: [{ name: 'siteId', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
    '/v1/devices': {
      get: {
        // operationId omitted on purpose to test synthesis
        tags: ['Devices'],
        summary: 'List devices',
      },
    },
  },
};

const buildProcessed = (): ProcessedSpec => ({
  sourceUrl: 'mock://spec',
  version: '1.0.0',
  title: 'Mock',
  serverPrefix: '',
  operations: buildOperationIndex(MOCK_SPEC),
  document: MOCK_SPEC,
});

describe('buildOperationIndex', () => {
  it('flattens paths into operations', () => {
    const ops = buildOperationIndex(MOCK_SPEC);
    expect(ops).toHaveLength(4);
    const ids = ops.map((o) => o.operationId);
    expect(ids).toContain('listSites');
    expect(ids).toContain('createSite');
    expect(ids).toContain('getSite');
  });

  it('synthesizes operationId when missing', () => {
    const ops = buildOperationIndex(MOCK_SPEC);
    const devicesOp = ops.find((o) => o.path === '/v1/devices');
    expect(devicesOp?.operationId).toBe(synthesizeOperationId('get', '/v1/devices'));
  });

  it('extracts request body flag', () => {
    const ops = buildOperationIndex(MOCK_SPEC);
    expect(ops.find((o) => o.operationId === 'createSite')?.hasRequestBody).toBe(true);
    expect(ops.find((o) => o.operationId === 'listSites')?.hasRequestBody).toBe(false);
  });

  it('flags path parameters as required', () => {
    const ops = buildOperationIndex(MOCK_SPEC);
    const op = ops.find((o) => o.operationId === 'getSite');
    const param = op?.parameters.find((p) => p.name === 'siteId');
    expect(param?.required).toBe(true);
    expect(param?.in).toBe('path');
  });
});

describe('normalizeTag', () => {
  it('camelCases multi-word tags', () => {
    expect(normalizeTag('WiFi Broadcasts')).toBe('wifiBroadcasts');
    expect(normalizeTag('Access Control (ACL Rules)')).toBe('accessControlAclRules');
    expect(normalizeTag('Sites')).toBe('sites');
  });

  it('returns "default" for empty input', () => {
    expect(normalizeTag('')).toBe('default');
    expect(normalizeTag('   ')).toBe('default');
  });
});

describe('findOperation', () => {
  const spec = buildProcessed();

  it('finds by operationId', () => {
    expect(findOperation(spec, 'listSites')?.operationId).toBe('listSites');
  });

  it('finds by "METHOD path"', () => {
    expect(findOperation(spec, 'GET /v1/sites/{siteId}')?.operationId).toBe('getSite');
  });

  it('returns undefined for unknown id', () => {
    expect(findOperation(spec, 'nonExistent')).toBeUndefined();
  });
});

describe('searchOperations', () => {
  const spec = buildProcessed();

  it('ranks operationId hits highest', () => {
    const results = searchOperations(spec, 'listSites');
    expect(results[0]?.operationId).toBe('listSites');
  });

  it('returns matches by tag', () => {
    const results = searchOperations(spec, 'devices');
    expect(results.length).toBeGreaterThan(0);
  });

  it('respects limit', () => {
    const results = searchOperations(spec, 'site', 1);
    expect(results).toHaveLength(1);
  });
});

describe('summarizeOperation', () => {
  const spec = buildProcessed();

  it('produces compact serializable output', () => {
    const op = findOperation(spec, 'listSites');
    expect(op).toBeDefined();
    const summary = summarizeOperation(op!);
    expect(summary['operationId']).toBe('listSites');
    expect(summary['method']).toBe('GET');
    expect(summary['path']).toBe('/v1/sites');
    expect(summary['parameters']).toHaveLength(2);
  });
});
