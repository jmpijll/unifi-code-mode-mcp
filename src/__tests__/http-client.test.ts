import { describe, expect, it } from 'vitest';
import { buildQueryString, substitutePathParams } from '../client/http.js';
import {
  createCloudClient,
  createCloudNetworkProxyClient,
  createCloudProtectProxyClient,
  createLocalClient,
  createLocalProtectClient,
} from '../client/index.js';

describe('substitutePathParams', () => {
  it('replaces placeholders', () => {
    expect(substitutePathParams('/v1/sites/{siteId}/devices/{deviceId}', { siteId: 'a', deviceId: 'b' })).toBe(
      '/v1/sites/a/devices/b',
    );
  });

  it('encodes special characters', () => {
    expect(substitutePathParams('/v1/{id}', { id: 'a/b c' })).toBe('/v1/a%2Fb%20c');
  });

  it('throws on missing param', () => {
    expect(() => substitutePathParams('/v1/{x}', {})).toThrow(/Missing path parameter/);
  });

  it('returns input unchanged when no params object', () => {
    expect(substitutePathParams('/v1/sites', undefined)).toBe('/v1/sites');
  });
});

describe('buildQueryString', () => {
  it('skips undefined values', () => {
    expect(buildQueryString({ a: 1, b: undefined, c: 'x' })).toBe('?a=1&c=x');
  });

  it('repeats array values', () => {
    expect(buildQueryString({ tag: ['a', 'b'] })).toBe('?tag=a&tag=b');
  });

  it('returns empty string for empty input', () => {
    expect(buildQueryString({})).toBe('');
    expect(buildQueryString(undefined)).toBe('');
  });
});

describe('client factories', () => {
  it('createLocalClient prefixes /proxy/network/integration', () => {
    const client = createLocalClient({ baseUrl: 'https://192.0.2.1', apiKey: 'k' });
    expect(client.config.pathPrefix).toBe('/proxy/network/integration');
    expect(client.config.baseUrl).toBe('https://192.0.2.1');
  });

  it('createCloudClient has no path prefix', () => {
    const client = createCloudClient({ baseUrl: 'https://api.ui.com', apiKey: 'k' });
    expect(client.config.pathPrefix).toBe('');
  });

  it('createCloudNetworkProxyClient prefixes the connector path with consoleId', () => {
    const client = createCloudNetworkProxyClient(
      { baseUrl: 'https://api.ui.com', apiKey: 'k' },
      'console-abc',
    );
    expect(client.config.baseUrl).toBe('https://api.ui.com');
    expect(client.config.pathPrefix).toBe(
      '/v1/connector/consoles/console-abc/proxy/network/integration',
    );
  });

  it('createCloudNetworkProxyClient URL-encodes the consoleId', () => {
    const client = createCloudNetworkProxyClient(
      { baseUrl: 'https://api.ui.com', apiKey: 'k' },
      'console with spaces/and-slash',
    );
    expect(client.config.pathPrefix).toBe(
      '/v1/connector/consoles/console%20with%20spaces%2Fand-slash/proxy/network/integration',
    );
  });

  it('createCloudNetworkProxyClient rejects empty consoleId', () => {
    expect(() =>
      createCloudNetworkProxyClient({ baseUrl: 'https://api.ui.com', apiKey: 'k' }, ''),
    ).toThrow(/consoleId/);
  });

  it('createLocalProtectClient prefixes /proxy/protect/integration', () => {
    const client = createLocalProtectClient({ baseUrl: 'https://192.0.2.1', apiKey: 'k' });
    expect(client.config.pathPrefix).toBe('/proxy/protect/integration');
    expect(client.config.baseUrl).toBe('https://192.0.2.1');
    expect(client.config.label).toBe('unifi.local.protect');
  });

  it('createLocalProtectClient honours TLS opt-outs identical to network', () => {
    const client = createLocalProtectClient({
      baseUrl: 'https://192.0.2.1',
      apiKey: 'k',
      insecure: true,
    });
    expect(client.config.insecure).toBe(true);
  });

  it('createCloudProtectProxyClient prefixes the connector path with consoleId', () => {
    const client = createCloudProtectProxyClient(
      { baseUrl: 'https://api.ui.com', apiKey: 'k' },
      'console-abc',
    );
    expect(client.config.baseUrl).toBe('https://api.ui.com');
    expect(client.config.pathPrefix).toBe(
      '/v1/connector/consoles/console-abc/proxy/protect/integration',
    );
    expect(client.config.label).toBe('unifi.cloud.protect[console-abc]');
  });

  it('createCloudProtectProxyClient URL-encodes the consoleId', () => {
    const client = createCloudProtectProxyClient(
      { baseUrl: 'https://api.ui.com', apiKey: 'k' },
      'console with spaces/and-slash',
    );
    expect(client.config.pathPrefix).toBe(
      '/v1/connector/consoles/console%20with%20spaces%2Fand-slash/proxy/protect/integration',
    );
  });

  it('createCloudProtectProxyClient rejects empty consoleId', () => {
    expect(() =>
      createCloudProtectProxyClient({ baseUrl: 'https://api.ui.com', apiKey: 'k' }, ''),
    ).toThrow(/consoleId/);
  });
});
