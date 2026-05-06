/**
 * Cloud UniFi Site Manager API client.
 *
 * Always strict TLS — `api.ui.com` uses a publicly trusted certificate.
 *
 * Two flavors:
 *   - createCloudClient(): native Site Manager endpoints (/v1/hosts, /v1/sites, …)
 *   - createCloudNetworkProxyClient(): Network Integration API tunneled through the
 *     Site Manager connector at /v1/connector/consoles/{consoleId}/proxy/network/integration.
 */

import { HttpClient } from './http.js';
import type { CloudTenantCreds } from '../tenant/context.js';

export interface CloudClientOptions {
  onWarn?: (msg: string) => void;
}

export function createCloudClient(
  creds: CloudTenantCreds,
  opts: CloudClientOptions = {},
): HttpClient {
  return new HttpClient({
    baseUrl: creds.baseUrl,
    pathPrefix: '',
    apiKey: creds.apiKey,
    label: 'unifi.cloud',
    onWarn: opts.onWarn,
  });
}

/**
 * Build a cloud client that proxies Network Integration API calls through
 * the Site Manager connector. The path prefix is rewritten so the same
 * Network OpenAPI operations (e.g. `/v1/sites/{siteId}/devices`) work
 * unchanged — they are appended to:
 *   /v1/connector/consoles/{consoleId}/proxy/network/integration
 *
 * Authentication uses the Site Manager API key (from CloudTenantCreds),
 * not a per-controller local key.
 */
export function createCloudNetworkProxyClient(
  creds: CloudTenantCreds,
  consoleId: string,
  opts: CloudClientOptions = {},
): HttpClient {
  if (!consoleId || typeof consoleId !== 'string') {
    throw new Error(
      'createCloudNetworkProxyClient: consoleId is required (the host id from unifi.ui.com/consoles/<id>).',
    );
  }
  const safeConsoleId = encodeURIComponent(consoleId);
  return new HttpClient({
    baseUrl: creds.baseUrl,
    pathPrefix: `/v1/connector/consoles/${safeConsoleId}/proxy/network/integration`,
    apiKey: creds.apiKey,
    label: `unifi.cloud.network[${consoleId}]`,
    onWarn: opts.onWarn,
  });
}
