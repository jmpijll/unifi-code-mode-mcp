/**
 * Host-side dispatch — turns sandbox calls into real HTTP requests.
 *
 * Two entry points:
 *   - dispatchOperation(): named operation lookup (the LLM calls
 *     `unifi.local.sites.listSites({...})` which becomes a call here).
 *   - dispatchRawRequest(): the LLM calls `unifi.local.request({...})`.
 *
 * Smart argument routing for dispatchOperation():
 *   - If args has any of {pathParams, query, body, headers}, those are
 *     used as-is and other keys are ignored.
 *   - Otherwise, args keys matching the operation's spec parameters are
 *     auto-routed to pathParams or query based on `param.in`. Remaining
 *     keys form the body (if the operation accepts one).
 */

import type { HttpClient } from '../client/http.js';
import { findOperation } from '../spec/index.js';
import type { IndexedOperation, ProcessedSpec } from '../types/spec.js';
import type { UnifiRequestParams, UnifiResponse, HttpMethod } from '../client/types.js';

export interface DispatchOperationArgs {
  /** A loose argument object — see Smart routing rules in the file header. */
  [key: string]: unknown;
  pathParams?: Record<string, string | number | boolean>;
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

export class UnknownOperationError extends Error {
  override readonly name = 'UnknownOperationError';
  constructor(public readonly namespace: 'local' | 'cloud', public readonly operationId: string) {
    super(`No operation "${operationId}" in unifi.${namespace} spec`);
  }
}

export async function dispatchOperation(
  client: HttpClient,
  spec: ProcessedSpec,
  namespace: 'local' | 'cloud',
  operationId: string,
  args: DispatchOperationArgs = {},
): Promise<UnifiResponse> {
  const op = findOperation(spec, operationId);
  if (!op) throw new UnknownOperationError(namespace, operationId);

  const params = routeArgsToRequest(op, args);
  return client.request(params);
}

export async function dispatchRawRequest(
  client: HttpClient,
  args: UnifiRequestParams,
): Promise<UnifiResponse> {
  if (!args || typeof args !== 'object' || typeof args.path !== 'string') {
    throw new Error(
      'request() argument must be an object with at least a string `path` field. ' +
        'Example: unifi.local.request({ method: "GET", path: "/v1/sites" })',
    );
  }
  return client.request(args);
}

function routeArgsToRequest(op: IndexedOperation, args: DispatchOperationArgs): UnifiRequestParams {
  const explicit =
    args.pathParams !== undefined ||
    args.query !== undefined ||
    args.body !== undefined ||
    args.headers !== undefined;

  if (explicit) {
    return {
      method: op.method as HttpMethod,
      path: op.path,
      pathParams: args.pathParams,
      query: args.query,
      body: args.body,
      headers: args.headers,
    };
  }

  const pathParams: Record<string, string | number | boolean> = {};
  const query: Record<string, string | number | boolean | string[] | undefined> = {};
  const remaining: Record<string, unknown> = { ...args };

  for (const param of op.parameters) {
    if (param.in !== 'path' && param.in !== 'query') continue;
    if (!(param.name in remaining)) continue;
    const value = remaining[param.name];
    delete remaining[param.name];
    if (value === undefined) continue;
    if (param.in === 'path') {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        pathParams[param.name] = value;
      }
    } else {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        Array.isArray(value)
      ) {
        query[param.name] = value as string | number | boolean | string[];
      }
    }
  }

  let body: unknown = undefined;
  if (op.hasRequestBody) {
    const remainingKeys = Object.keys(remaining);
    if (remainingKeys.length > 0) body = remaining;
  }

  return {
    method: op.method as HttpMethod,
    path: op.path,
    pathParams: Object.keys(pathParams).length > 0 ? pathParams : undefined,
    query: Object.keys(query).length > 0 ? query : undefined,
    body,
  };
}

/**
 * Build a JS prelude that creates the `unifi` namespace at sandbox init time.
 *
 * Output shape:
 *   unifi.local.<tag>.<operationId>(args) -> Promise
 *   unifi.local.callOperation(operationId, args) -> Promise
 *   unifi.local.request({ method, path, ... }) -> Promise
 *   unifi.local.spec -> { title, version, sourceUrl }
 *   (same for unifi.cloud if a cloud spec was provided)
 *
 * The functions delegate to host-side bindings injected separately:
 *   __unifiCallLocal, __unifiRawLocal, __unifiCallCloud, __unifiRawCloud
 */
export function buildUnifiPrelude(localSpec?: ProcessedSpec, cloudSpec?: ProcessedSpec): string {
  const lines: string[] = [];
  lines.push('var unifi = {};');

  if (localSpec) {
    lines.push(buildNamespacePrelude('local', localSpec));
  } else {
    lines.push(missingNamespacePrelude('local'));
  }

  if (cloudSpec) {
    lines.push(buildNamespacePrelude('cloud', cloudSpec));
  } else {
    lines.push(missingNamespacePrelude('cloud'));
  }

  return lines.join('\n');
}

function buildNamespacePrelude(namespace: 'local' | 'cloud', spec: ProcessedSpec): string {
  const callBinding = namespace === 'local' ? '__unifiCallLocal' : '__unifiCallCloud';
  const rawBinding = namespace === 'local' ? '__unifiRawLocal' : '__unifiRawCloud';

  const groups = new Map<string, IndexedOperation[]>();
  for (const op of spec.operations) {
    const key = op.primaryTag || 'default';
    const arr = groups.get(key) ?? [];
    arr.push(op);
    groups.set(key, arr);
  }

  const namespaceObj: string[] = [];
  namespaceObj.push(`unifi.${namespace} = (function() {`);
  namespaceObj.push(`  var ns = {`);
  namespaceObj.push(`    spec: ${JSON.stringify({
    title: spec.title,
    version: spec.version,
    sourceUrl: spec.sourceUrl,
    operationCount: spec.operations.length,
  })},`);
  namespaceObj.push(`    request: function(args) { return ${rawBinding}(JSON.stringify(args || {})); },`);
  namespaceObj.push(`    callOperation: function(opId, args) { return ${callBinding}(opId, JSON.stringify(args || {})); }`);
  namespaceObj.push(`  };`);

  for (const [tag, ops] of groups) {
    const safeTag = sanitizeIdentifier(tag);
    namespaceObj.push(`  ns.${safeTag} = {};`);
    for (const op of ops) {
      const methodName = sanitizeIdentifier(op.operationId);
      namespaceObj.push(
        `  ns.${safeTag}.${methodName} = function(args) { return ${callBinding}(${JSON.stringify(op.operationId)}, JSON.stringify(args || {})); };`,
      );
    }
  }

  namespaceObj.push(`  return ns;`);
  namespaceObj.push(`})();`);

  return namespaceObj.join('\n');
}

function missingNamespacePrelude(namespace: 'local' | 'cloud'): string {
  const message = `No spec loaded for unifi.${namespace}. Provide credentials at startup or via headers (see docs/multi-tenant.md).`;
  return `unifi.${namespace} = { __missing: true, request: function() { throw new Error(${JSON.stringify(message)}); }, callOperation: function() { throw new Error(${JSON.stringify(message)}); } };`;
}

const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static',
]);

export function sanitizeIdentifier(input: string): string {
  let out = input.replace(/[^a-zA-Z0-9_$]/g, '_');
  if (out.length === 0 || /^[0-9]/.test(out)) out = `_${out}`;
  if (RESERVED_WORDS.has(out)) out = `${out}_`;
  return out;
}
