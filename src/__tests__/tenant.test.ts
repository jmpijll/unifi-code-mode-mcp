import { describe, expect, it } from 'vitest';
import {
  buildContextFromEnv,
  buildContextFromHeaders,
  HEADER_CLOUD_API_KEY,
  HEADER_LOCAL_API_KEY,
  HEADER_LOCAL_BASE_URL,
  HEADER_LOCAL_CA_CERT,
  HEADER_LOCAL_INSECURE,
  MissingCredentialsError,
} from '../tenant/context.js';

describe('TenantContext', () => {
  describe('buildContextFromEnv', () => {
    it('returns empty context when no env creds set', () => {
      const ctx = buildContextFromEnv({});
      expect(ctx.local).toBeUndefined();
      expect(ctx.cloud).toBeUndefined();
      expect(ctx.fromHeaders).toBe(false);
    });

    it('builds local creds from env', () => {
      const ctx = buildContextFromEnv({
        UNIFI_LOCAL_BASE_URL: 'https://192.168.1.1/',
        UNIFI_LOCAL_API_KEY: 'k',
      });
      expect(ctx.local).toEqual({
        baseUrl: 'https://192.168.1.1',
        apiKey: 'k',
        caCert: undefined,
        insecure: undefined,
      });
    });

    it('parses UNIFI_LOCAL_INSECURE booleans', () => {
      expect(
        buildContextFromEnv({
          UNIFI_LOCAL_BASE_URL: 'https://x',
          UNIFI_LOCAL_API_KEY: 'k',
          UNIFI_LOCAL_INSECURE: 'true',
        }).local?.insecure,
      ).toBe(true);
      expect(
        buildContextFromEnv({
          UNIFI_LOCAL_BASE_URL: 'https://x',
          UNIFI_LOCAL_API_KEY: 'k',
          UNIFI_LOCAL_INSECURE: 'no',
        }).local?.insecure,
      ).toBe(false);
    });

    it('builds cloud creds with default base URL', () => {
      const ctx = buildContextFromEnv({ UNIFI_CLOUD_API_KEY: 'k' });
      expect(ctx.cloud).toEqual({
        baseUrl: 'https://api.ui.com',
        apiKey: 'k',
      });
    });
  });

  describe('buildContextFromHeaders', () => {
    it('reads local creds from headers', () => {
      const ctx = buildContextFromHeaders(
        {
          [HEADER_LOCAL_API_KEY]: 'tk',
          [HEADER_LOCAL_BASE_URL]: 'https://controller/',
          [HEADER_LOCAL_INSECURE]: 'true',
          [HEADER_LOCAL_CA_CERT]: '-----BEGIN CERTIFICATE-----',
        },
        {},
      );
      expect(ctx.fromHeaders).toBe(true);
      expect(ctx.local).toEqual({
        baseUrl: 'https://controller',
        apiKey: 'tk',
        caCert: '-----BEGIN CERTIFICATE-----',
        insecure: true,
      });
    });

    it('throws when only one of api-key/base-url is supplied', () => {
      expect(() =>
        buildContextFromHeaders({ [HEADER_LOCAL_API_KEY]: 'tk' }, {}),
      ).toThrow(MissingCredentialsError);
    });

    it('falls back to env when headers absent', () => {
      const ctx = buildContextFromHeaders(
        { [HEADER_CLOUD_API_KEY]: 'cloudk' },
        { UNIFI_LOCAL_API_KEY: 'envlk', UNIFI_LOCAL_BASE_URL: 'https://x' },
      );
      expect(ctx.local?.apiKey).toBe('envlk');
      expect(ctx.cloud?.apiKey).toBe('cloudk');
    });

    it('treats array header values like the first value', () => {
      const ctx = buildContextFromHeaders(
        {
          [HEADER_LOCAL_API_KEY]: ['k1', 'k2'],
          [HEADER_LOCAL_BASE_URL]: 'https://x',
        },
        {},
      );
      expect(ctx.local?.apiKey).toBe('k1');
    });
  });

  describe('MissingCredentialsError', () => {
    it('produces actionable message for local', () => {
      const err = new MissingCredentialsError('local');
      expect(err.message).toContain('UNIFI_LOCAL_API_KEY');
      expect(err.message).toContain('X-Unifi-Local-Api-Key');
    });
    it('produces actionable message for cloud', () => {
      const err = new MissingCredentialsError('cloud');
      expect(err.message).toContain('UNIFI_CLOUD_API_KEY');
    });
  });
});
