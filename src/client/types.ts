/**
 * Shared client types — what the sandbox sees when it calls request().
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface UnifiRequestParams {
  /** HTTP method (case-insensitive) — default GET. */
  method?: HttpMethod | Lowercase<HttpMethod>;
  /** Path under the API server (e.g. "/v1/sites" or "/v1/sites/{siteId}"). */
  path: string;
  /**
   * Path parameters to substitute. The path may contain `{name}` placeholders
   * which are replaced with `encodeURIComponent(value)`.
   */
  pathParams?: Record<string, string | number | boolean>;
  /** Query parameters. Arrays are repeated; booleans become "true"/"false". */
  query?: Record<string, string | number | boolean | string[] | undefined>;
  /** JSON request body. */
  body?: unknown;
  /** Extra headers (Content-Type and X-API-Key are set automatically). */
  headers?: Record<string, string>;
}

export interface UnifiResponse<T = unknown> {
  /** HTTP status code. */
  status: number;
  /** Response headers as a plain object. */
  headers: Record<string, string>;
  /** Parsed JSON response body, or text fallback. */
  data: T;
}

export class UnifiHttpError extends Error {
  override readonly name = 'UnifiHttpError';
  public readonly status: number;
  public override readonly cause?: unknown;
  constructor(
    message: string,
    status: number,
    public readonly path: string,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.status = status;
  }
}

export class UnifiTransportError extends Error {
  override readonly name = 'UnifiTransportError';
  public override readonly cause?: unknown;
  constructor(
    message: string,
    public readonly path: string,
    cause?: unknown,
  ) {
    super(message);
    this.cause = cause;
  }
}
