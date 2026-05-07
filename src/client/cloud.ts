/**
 * Cloud UniFi Site Manager API client.
 *
 * Always strict TLS — `api.ui.com` uses a publicly trusted certificate.
 *
 * Three flavors:
 *   - createCloudClient(): native Site Manager endpoints (/v1/hosts, /v1/sites, …)
 *   - createCloudNetworkProxyClient(): Network Integration API tunneled through the
 *     Site Manager connector at /v1/connector/consoles/{consoleId}/proxy/network/integration.
 *   - createCloudProtectProxyClient(): Protect Integration API tunneled through the
 *     same connector at /v1/connector/consoles/{consoleId}/proxy/protect/integration.
 *     URL pattern is officially documented by Ubiquiti (see
 *     https://developer.ui.com/protect/v7.0.107/gettingstarted, "Remote" base URL
 *     selector). Mock-verified end-to-end; live-verification awaits a Protect
 *     deployment.
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

/**
 * Build a cloud client that proxies Protect Integration API calls through
 * the Site Manager connector. Structurally identical to
 * createCloudNetworkProxyClient, but the path prefix targets the Protect
 * application:
 *   /v1/connector/consoles/{consoleId}/proxy/protect/integration
 *
 * The path pattern is officially documented by Ubiquiti's developer docs
 * (https://developer.ui.com/protect/v7.0.107/...), which expose a
 * "Remote" / "Local" base-URL selector mapping every operation to:
 *   Remote: https://api.ui.com/v1/connector/consoles/{consoleId}/proxy/protect/integration/<op>
 *   Local : https://<controller>/proxy/protect/integration/<op>
 * Auth uses the Site Manager API key (from CloudTenantCreds), not a
 * per-controller local key.
 */
export function createCloudProtectProxyClient(
  creds: CloudTenantCreds,
  consoleId: string,
  opts: CloudClientOptions = {},
): HttpClient {
  if (!consoleId || typeof consoleId !== 'string') {
    throw new Error(
      'createCloudProtectProxyClient: consoleId is required (the host id from unifi.ui.com/consoles/<id>).',
    );
  }
  const safeConsoleId = encodeURIComponent(consoleId);
  return new HttpClient({
    baseUrl: creds.baseUrl,
    pathPrefix: `/v1/connector/consoles/${safeConsoleId}/proxy/protect/integration`,
    apiKey: creds.apiKey,
    label: `unifi.cloud.protect[${consoleId}]`,
    onWarn: opts.onWarn,
  });
}
