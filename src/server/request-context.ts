/**
 * Per-request context propagated via AsyncLocalStorage.
 *
 * The HTTP transport runs each MCP request inside an ALS scope that carries
 * the request's HTTP headers. The `tenantResolver` provided to createMcpServer
 * reads from this scope to build the TenantContext.
 *
 * In stdio mode, no scope is established — the resolver falls back to env vars.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestScope {
  /** Lower-cased HTTP headers (only relevant ones). */
  headers: Record<string, string | string[] | undefined>;
  /** Caller IP for logging. */
  clientIp?: string;
}

export const requestStore = new AsyncLocalStorage<RequestScope>();

export function currentRequestScope(): RequestScope | undefined {
  return requestStore.getStore();
}
