/**
 * Local UniFi Network Integration API client.
 *
 * Always pointed at a per-tenant controller. Path prefix is
 * `/proxy/network/integration` so the LLM can use spec paths like
 * `/v1/sites/{siteId}/devices` directly.
 */

import { HttpClient } from './http.js';
import type { LocalTenantCreds } from '../tenant/context.js';

export interface LocalClientOptions {
  onWarn?: (msg: string) => void;
}

export function createLocalClient(
  creds: LocalTenantCreds,
  opts: LocalClientOptions = {},
): HttpClient {
  return new HttpClient({
    baseUrl: creds.baseUrl,
    pathPrefix: '/proxy/network/integration',
    apiKey: creds.apiKey,
    caCert: creds.caCert,
    insecure: creds.insecure,
    label: 'unifi.local',
    onWarn: opts.onWarn,
  });
}
