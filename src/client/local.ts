/**
 * Local UniFi controller clients.
 *
 * Always pointed at a per-tenant controller. The path prefix selects the
 * application:
 *   - createLocalClient()         -> /proxy/network/integration  (Network)
 *   - createLocalProtectClient()  -> /proxy/protect/integration  (Protect)
 *
 * Both share the same X-API-Key auth and TLS handling (strict by default,
 * per-tenant CA cert, opt-in insecure).
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

/**
 * Local Protect Integration client. Same auth and TLS as
 * createLocalClient, but routes to /proxy/protect/integration on the
 * controller. Only useful if the Protect application is installed on
 * the target UniFi OS device.
 */
export function createLocalProtectClient(
  creds: LocalTenantCreds,
  opts: LocalClientOptions = {},
): HttpClient {
  return new HttpClient({
    baseUrl: creds.baseUrl,
    pathPrefix: '/proxy/protect/integration',
    apiKey: creds.apiKey,
    caCert: creds.caCert,
    insecure: creds.insecure,
    label: 'unifi.local.protect',
    onWarn: opts.onWarn,
  });
}
