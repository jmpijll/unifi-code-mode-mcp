/**
 * Cloud UniFi Site Manager API client.
 *
 * Always strict TLS — `api.ui.com` uses a publicly trusted certificate.
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
