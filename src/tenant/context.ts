/**
 * TenantContext — per-request credentials for the local + cloud UniFi APIs.
 *
 * The same code paths handle:
 *   - Single-user mode: context built from environment variables once at startup.
 *   - Multi-user mode: context built from HTTP request headers on each request.
 *
 * Credentials NEVER enter the QuickJS sandbox. The host-side request() handler
 * receives the TenantContext and uses it to authorize outbound HTTPS calls.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────

export interface LocalTenantCreds {
  /** Base URL of the controller, e.g. https://192.168.1.1 (no path). */
  baseUrl: string;
  /** API key (X-API-KEY) minted in UniFi Network → Integrations. */
  apiKey: string;
  /** PEM-encoded CA bundle used to validate the controller's TLS cert. */
  caCert?: string;
  /** Skip TLS verification entirely. Logged loudly when used. */
  insecure?: boolean;
}

export interface CloudTenantCreds {
  /** Cloud base URL — defaults to https://api.ui.com. */
  baseUrl: string;
  /** API key for https://api.ui.com. */
  apiKey: string;
}

export interface TenantContext {
  local?: LocalTenantCreds;
  cloud?: CloudTenantCreds;
  /** A short id used in logs; not security-sensitive. */
  requestId: string;
  /** Whether this context was assembled from HTTP headers (true) or env vars (false). */
  fromHeaders: boolean;
}

// ─── Errors ─────────────────────────────────────────────────────────

export class MissingCredentialsError extends Error {
  override readonly name = 'MissingCredentialsError';
  constructor(public readonly namespace: 'local' | 'cloud', detail?: string) {
    super(
      `No credentials for "${namespace}" namespace. ` +
        (namespace === 'local'
          ? 'Provide UNIFI_LOCAL_API_KEY + UNIFI_LOCAL_BASE_URL via env (single-user) ' +
            'or X-Unifi-Local-Api-Key + X-Unifi-Local-Base-Url headers (multi-user).'
          : 'Provide UNIFI_CLOUD_API_KEY via env (single-user) ' +
            'or X-Unifi-Cloud-Api-Key header (multi-user).') +
        (detail ? ` (${detail})` : ''),
    );
  }
}

// ─── Header constants ───────────────────────────────────────────────

export const HEADER_LOCAL_API_KEY = 'x-unifi-local-api-key';
export const HEADER_LOCAL_BASE_URL = 'x-unifi-local-base-url';
export const HEADER_LOCAL_CA_CERT = 'x-unifi-local-ca-cert';
export const HEADER_LOCAL_INSECURE = 'x-unifi-local-insecure';
export const HEADER_CLOUD_API_KEY = 'x-unifi-cloud-api-key';
export const HEADER_CLOUD_BASE_URL = 'x-unifi-cloud-base-url';

// ─── Builders ───────────────────────────────────────────────────────

export interface EnvCreds {
  UNIFI_LOCAL_API_KEY?: string;
  UNIFI_LOCAL_BASE_URL?: string;
  UNIFI_LOCAL_CA_CERT_PATH?: string;
  UNIFI_LOCAL_CA_CERT?: string;
  UNIFI_LOCAL_INSECURE?: string;
  UNIFI_CLOUD_API_KEY?: string;
  UNIFI_CLOUD_BASE_URL?: string;
}

const DEFAULT_CLOUD_BASE_URL = 'https://api.ui.com';

/** Build a TenantContext from process.env. */
export function buildContextFromEnv(env: EnvCreds = process.env as EnvCreds): TenantContext {
  const ctx: TenantContext = {
    requestId: randomId(),
    fromHeaders: false,
  };

  const local = readLocalFromEnv(env);
  if (local) ctx.local = local;

  const cloud = readCloudFromEnv(env);
  if (cloud) ctx.cloud = cloud;

  return ctx;
}

/**
 * Build a TenantContext from a Node IncomingMessage's headers, falling back
 * to env vars per-namespace. The header set fully overrides the env set for
 * a namespace if any of its required headers are present.
 */
export function buildContextFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  fallbackEnv: EnvCreds = process.env as EnvCreds,
): TenantContext {
  const get = (name: string): string | undefined => {
    const raw = headers[name.toLowerCase()];
    if (raw === undefined) return undefined;
    if (Array.isArray(raw)) return raw[0];
    return raw;
  };

  const ctx: TenantContext = {
    requestId: randomId(),
    fromHeaders: true,
  };

  const localApiKey = get(HEADER_LOCAL_API_KEY);
  const localBaseUrl = get(HEADER_LOCAL_BASE_URL);
  if (localApiKey || localBaseUrl) {
    if (!localApiKey || !localBaseUrl) {
      throw new MissingCredentialsError(
        'local',
        `Header pair incomplete: provide both ${HEADER_LOCAL_API_KEY} and ${HEADER_LOCAL_BASE_URL}.`,
      );
    }
    ctx.local = {
      baseUrl: normalizeBaseUrl(localBaseUrl),
      apiKey: localApiKey,
      caCert: get(HEADER_LOCAL_CA_CERT),
      insecure: parseBool(get(HEADER_LOCAL_INSECURE)),
    };
  } else {
    const fromEnv = readLocalFromEnv(fallbackEnv);
    if (fromEnv) ctx.local = fromEnv;
  }

  const cloudApiKey = get(HEADER_CLOUD_API_KEY);
  const cloudBaseUrl = get(HEADER_CLOUD_BASE_URL);
  if (cloudApiKey) {
    ctx.cloud = {
      apiKey: cloudApiKey,
      baseUrl: normalizeBaseUrl(cloudBaseUrl ?? DEFAULT_CLOUD_BASE_URL),
    };
  } else {
    const fromEnv = readCloudFromEnv(fallbackEnv);
    if (fromEnv) ctx.cloud = fromEnv;
  }

  return ctx;
}

// ─── Helpers ────────────────────────────────────────────────────────

function readLocalFromEnv(env: EnvCreds): LocalTenantCreds | undefined {
  const apiKey = env.UNIFI_LOCAL_API_KEY;
  const baseUrl = env.UNIFI_LOCAL_BASE_URL;
  if (!apiKey || !baseUrl) return undefined;

  let caCert: string | undefined = env.UNIFI_LOCAL_CA_CERT;
  if (!caCert && env.UNIFI_LOCAL_CA_CERT_PATH) {
    try {
      caCert = readFileSync(resolve(env.UNIFI_LOCAL_CA_CERT_PATH), 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read UNIFI_LOCAL_CA_CERT_PATH=${env.UNIFI_LOCAL_CA_CERT_PATH}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(baseUrl),
    caCert,
    insecure: parseBool(env.UNIFI_LOCAL_INSECURE),
  };
}

function readCloudFromEnv(env: EnvCreds): CloudTenantCreds | undefined {
  const apiKey = env.UNIFI_CLOUD_API_KEY;
  if (!apiKey) return undefined;
  return {
    apiKey,
    baseUrl: normalizeBaseUrl(env.UNIFI_CLOUD_BASE_URL ?? DEFAULT_CLOUD_BASE_URL),
  };
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === '') return false;
  return undefined;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
