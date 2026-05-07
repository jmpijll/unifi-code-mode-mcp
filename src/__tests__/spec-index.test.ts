import { describe, expect, it } from 'vitest';
import {
  buildOperationIndex,
  compactTagPhrase,
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
    expect(normalizeTag('Sites')).toBe('sites');
  });

  it('returns "default" for empty input', () => {
    expect(normalizeTag('')).toBe('default');
    expect(normalizeTag('   ')).toBe('default');
  });

  it('compacts the verbose Protect boilerplate', () => {
    // The 12 official Protect 7.0.107 tags become readable accessors.
    expect(normalizeTag('Camera information & management')).toBe('camera');
    expect(normalizeTag('Camera PTZ control & management')).toBe('cameraPtz');
    expect(normalizeTag('Chime information & management')).toBe('chime');
    expect(normalizeTag('Light information & management')).toBe('light');
    expect(normalizeTag('NVR information & management')).toBe('nvr');
    expect(normalizeTag('Sensor information & management')).toBe('sensor');
    expect(normalizeTag('Viewer information & management')).toBe('viewer');
    expect(normalizeTag('Live view management')).toBe('liveView');
    expect(normalizeTag('Device asset file management')).toBe('deviceAssetFile');
    expect(normalizeTag('Alarm manager integration')).toBe('alarmManager');
    // "Information about application" maps to "applicationInfo" so it
    // collides intentionally with Network's "Application Info" tag.
    expect(normalizeTag('Information about application')).toBe('applicationInfo');
    expect(normalizeTag('Application Info')).toBe('applicationInfo');
    // "WebSocket updates" carries semantic info we don't strip.
    expect(normalizeTag('WebSocket updates')).toBe('websocketUpdates');
  });

  it('prefers a parenthetical alias when one is supplied', () => {
    expect(normalizeTag('Access Control (ACL Rules)')).toBe('aclRules');
    expect(normalizeTag('Foo Bar (Baz)')).toBe('baz');
  });

  it('leaves Network tags alone (they have no boilerplate)', () => {
    expect(normalizeTag('Sites')).toBe('sites');
    expect(normalizeTag('Networks')).toBe('networks');
    expect(normalizeTag('UniFi Devices')).toBe('unifiDevices');
    expect(normalizeTag('Traffic Matching Lists')).toBe('trafficMatchingLists');
    expect(normalizeTag('Hotspot')).toBe('hotspot');
    expect(normalizeTag('DNS Policies')).toBe('dnsPolicies');
  });
});

describe('compactTagPhrase', () => {
  it('is a no-op for short, boilerplate-free phrases', () => {
    expect(compactTagPhrase('Sites')).toBe('Sites');
    expect(compactTagPhrase('WiFi Broadcasts')).toBe('WiFi Broadcasts');
  });

  it('strips suffixes case-insensitively', () => {
    expect(compactTagPhrase('Camera Information & Management')).toBe('Camera');
    expect(compactTagPhrase('Camera information and management')).toBe('Camera');
  });

  it('strips at most one suffix', () => {
    // We don't want to over-trim. "Light information" alone should
    // become "Light", not get further reduced.
    expect(compactTagPhrase('Light information')).toBe('Light');
    expect(compactTagPhrase('Light')).toBe('Light');
  });

  it('returns "<X> info" for "Information about X"', () => {
    expect(compactTagPhrase('Information about application')).toBe('application info');
    expect(compactTagPhrase('Information about the system')).toBe('the system info');
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
    if (!op) throw new Error('expected listSites to be findable in mock spec');
    const summary = summarizeOperation(op);
    expect(summary['operationId']).toBe('listSites');
    expect(summary['method']).toBe('GET');
    expect(summary['path']).toBe('/v1/sites');
    expect(summary['parameters']).toHaveLength(2);
  });
});
