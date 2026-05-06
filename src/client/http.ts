/**
 * Shared HTTP request implementation for both local and cloud clients.
 *
 * Handles:
 *   - Path-parameter substitution
 *   - Query string serialization
 *   - JSON encoding
 *   - 429 Retry-After honoring (single retry)
 *   - Error normalization to UnifiHttpError / UnifiTransportError
 *   - Per-tenant TLS dispatcher (custom CA / insecure / strict)
 */

import { Agent, fetch as undiciFetch, type Dispatcher, type RequestInit } from 'undici';
import {
  UnifiHttpError,
  UnifiTransportError,
  type HttpMethod,
  type UnifiRequestParams,
  type UnifiResponse,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES_429 = 1;

export interface HttpClientConfig {
  /** Full origin, e.g. https://192.168.1.1 or https://api.ui.com (no trailing slash). */
  baseUrl: string;
  /** Path prefix added between baseUrl and operation paths (e.g. "/proxy/network/integration"). */
  pathPrefix: string;
  /** API key for X-API-Key header. */
  apiKey: string;
  /** PEM CA bundle for TLS verification. */
  caCert?: string;
  /** Skip TLS verification entirely. */
  insecure?: boolean;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** A descriptive label for log messages. */
  label?: string;
  /** Optional warn handler — used to surface insecure-mode warnings to the caller. */
  onWarn?: (msg: string) => void;
}

export class HttpClient {
  private readonly dispatcher: Dispatcher | undefined;
  private readonly timeoutMs: number;

  constructor(public readonly config: HttpClientConfig) {
    this.dispatcher = buildDispatcher(config);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (config.insecure) {
      config.onWarn?.(
        `[${config.label ?? 'http'}] TLS verification disabled (insecure mode). ` +
          'Provide a custom CA bundle in production.',
      );
    }
  }

  async request<T = unknown>(params: UnifiRequestParams): Promise<UnifiResponse<T>> {
    const method = (params.method ?? 'GET').toUpperCase() as HttpMethod;
    const url = this.buildUrl(params);
    return this.send<T>(url, method, params);
  }

  // ─── Internals ────────────────────────────────────────────────────

  private buildUrl(params: UnifiRequestParams): string {
    const pathWithParams = substitutePathParams(params.path, params.pathParams);
    const qs = buildQueryString(params.query);
    const fullPath = `${this.config.pathPrefix}${pathWithParams}`;
    const safe = fullPath.startsWith('/') ? fullPath : `/${fullPath}`;
    return `${this.config.baseUrl}${safe}${qs}`;
  }

  private async send<T>(
    url: string,
    method: HttpMethod,
    params: UnifiRequestParams,
    attempt = 0,
  ): Promise<UnifiResponse<T>> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-API-Key': this.config.apiKey,
      ...(params.headers ?? {}),
    };

    let body: string | undefined;
    if (params.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      body = JSON.stringify(params.body);
      headers['Content-Type'] ??= 'application/json';
    }

    const init: RequestInit = {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(url, init);
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
      throw new UnifiTransportError(
        isTimeout
          ? `Request to ${url} timed out after ${String(this.timeoutMs)}ms`
          : `Network error calling ${url}: ${err instanceof Error ? err.message : String(err)}`,
        params.path,
        err,
      );
    }

    if (res.status === 429 && attempt < MAX_RETRIES_429) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      if (retryAfter !== undefined) {
        await sleep(retryAfter);
        return this.send<T>(url, method, params, attempt + 1);
      }
    }

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const ct = res.headers.get('content-type') ?? '';
    let data: unknown;
    if (ct.includes('application/json')) {
      try {
        data = await res.json();
      } catch {
        data = undefined;
      }
    } else if (res.status === 204) {
      data = undefined;
    } else {
      data = await res.text().catch(() => undefined);
    }

    if (!res.ok) {
      throw new UnifiHttpError(
        formatHttpError(res.status, params.path, data),
        res.status,
        params.path,
        data,
      );
    }

    return { status: res.status, headers: responseHeaders, data: data as T };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function buildDispatcher(cfg: HttpClientConfig): Dispatcher | undefined {
  if (cfg.insecure) {
    return new Agent({ connect: { rejectUnauthorized: false } });
  }
  if (cfg.caCert) {
    return new Agent({ connect: { ca: cfg.caCert } });
  }
  return undefined;
}

export function substitutePathParams(
  path: string,
  params: Record<string, string | number | boolean> | undefined,
): string {
  if (!params) return path;
  return path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter "${name}" for ${path}`);
    }
    return encodeURIComponent(String(value));
  });
}

export function buildQueryString(
  query: Record<string, string | number | boolean | string[] | undefined> | undefined,
): string {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) sp.append(k, item);
    } else {
      sp.append(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function formatHttpError(status: number, path: string, body: unknown): string {
  let detail = '';
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const msg = b['message'];
    const code = b['code'];
    if (typeof msg === 'string') detail = `: ${msg}`;
    if (typeof code === 'string') detail += ` [${code}]`;
  } else if (typeof body === 'string' && body.length < 500) {
    detail = `: ${body}`;
  }
  return `HTTP ${String(status)} on ${path}${detail}`;
}
