import { describe, expect, it } from 'vitest';
import { buildQueryString, substitutePathParams } from '../client/http.js';

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
