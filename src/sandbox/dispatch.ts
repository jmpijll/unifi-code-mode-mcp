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
  if (typeof args !== 'object' || typeof args.path !== 'string') {
    throw new Error(
      'request() argument must be an object with at least a string `path` field. ' +
        'Example: unifi.local.request({ method: "GET", path: "/v1/sites" })',
    );
  }
  return client.request(args);
}

function routeArgsToRequest(op: IndexedOperation, args: DispatchOperationArgs): UnifiRequestParams {
  // Start from any explicitly-provided buckets, then auto-route the remaining
  // top-level keys. This lets callers write the natural shape
  // `{ siteId, wifiBroadcastId, body: { ... } }` for a PUT/POST: explicit
  // `body` / `headers` are honoured, and the loose `siteId` / `wifiBroadcastId`
  // are still substituted into the path.
  const pathParams: Record<string, string | number | boolean> = {
    ...(args.pathParams ?? {}),
  };
  const query: Record<string, string | number | boolean | string[] | undefined> = {
    ...(args.query ?? {}),
  };
  const headers = args.headers;
  let body: unknown = args.body;

  const remaining: Record<string, unknown> = { ...args };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete remaining['pathParams'];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete remaining['query'];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete remaining['body'];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete remaining['headers'];

  for (const param of op.parameters) {
    if (param.in !== 'path' && param.in !== 'query') continue;
    if (!(param.name in remaining)) continue;
    const value = remaining[param.name];
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
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

  // If the caller didn't supply an explicit `body` and the operation accepts
  // one, gather any remaining unrouted keys into the body. We never override
  // an explicitly-provided body with sibling keys.
  if (body === undefined && op.hasRequestBody) {
    const remainingKeys = Object.keys(remaining);
    if (remainingKeys.length > 0) body = remaining;
  }

  const result: UnifiRequestParams = {
    method: op.method as HttpMethod,
    path: op.path,
    pathParams: Object.keys(pathParams).length > 0 ? pathParams : undefined,
    query: Object.keys(query).length > 0 ? query : undefined,
    body,
  };
  if (headers !== undefined) result.headers = headers;
  return result;
}

/**
 * Build a JS prelude that creates the `unifi` namespace at sandbox init time.
 *
 * Output shape:
 *   unifi.local.<tag>.<operationId>(args) -> Promise          // direct to controller (Network)
 *   unifi.local.callOperation(operationId, args) -> Promise
 *   unifi.local.request({ method, path, ... }) -> Promise
 *   unifi.local.spec -> { title, version, sourceUrl }
 *
 *   unifi.local.protect.<tag>.<operationId>(args) -> Promise  // direct to controller (Protect)
 *   unifi.local.protect.callOperation, request, spec
 *
 *   unifi.cloud.<tag>.<operationId>(args) -> Promise          // Site Manager native
 *   unifi.cloud.callOperation(operationId, args) -> Promise
 *   unifi.cloud.request({ method, path, ... }) -> Promise
 *   unifi.cloud.spec -> { title, version, sourceUrl }
 *
 *   unifi.cloud.network(consoleId) -> {                       // Network Integration via cloud proxy
 *     <tag>.<operationId>(args) -> Promise,
 *     callOperation, request, spec, consoleId
 *   }
 *   unifi.cloud.protect(consoleId) -> {                       // Protect Integration via cloud proxy
 *     <tag>.<operationId>(args) -> Promise,
 *     callOperation, request, spec, consoleId
 *   }
 *   unifi.cloud.consoles -> [list of known console ids, if any]
 *
 * The functions delegate to host-side bindings injected separately:
 *   __unifiCallLocal, __unifiRawLocal,
 *   __unifiCallCloud, __unifiRawCloud,
 *   __unifiCallCloudNetwork, __unifiRawCloudNetwork,
 *   __unifiCallLocalProtect, __unifiRawLocalProtect,
 *   __unifiCallCloudProtect, __unifiRawCloudProtect
 */
export function buildUnifiPrelude(
  localSpec?: ProcessedSpec,
  cloudSpec?: ProcessedSpec,
  options: {
    exposeCloudNetworkProxy?: boolean;
    protectSpec?: ProcessedSpec;
    exposeLocalProtect?: boolean;
    exposeCloudProtectProxy?: boolean;
  } = {},
): string {
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

  // Cloud → Network proxy attaches to unifi.cloud and reuses the local Network spec.
  // We only attach it when a local spec is available; the cloud key is checked at call time.
  if (options.exposeCloudNetworkProxy && localSpec) {
    lines.push(buildCloudNetworkProxyPrelude(localSpec));
  }

  // Protect surfaces — both local and cloud-proxied — share the same
  // Protect spec for operation lookups but route to different host bindings.
  if (options.protectSpec) {
    if (options.exposeLocalProtect) {
      lines.push(buildLocalProtectPrelude(options.protectSpec));
    }
    if (options.exposeCloudProtectProxy) {
      lines.push(buildCloudProtectProxyPrelude(options.protectSpec));
    }
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

/**
 * Cloud→Network proxy: emits a `unifi.cloud.network(consoleId)` factory
 * that returns a per-console object identical in shape to `unifi.local`,
 * but routed through the Site Manager connector via host bindings
 * `__unifiCallCloudNetwork(consoleId, opId, argsJson)` and
 * `__unifiRawCloudNetwork(consoleId, argsJson)`.
 *
 * The factory caches per-consoleId instances inside the sandbox so the
 * LLM can keep a stable handle: `var net = unifi.cloud.network('abc'); net.sites.listSites()`.
 */
function buildCloudNetworkProxyPrelude(localSpec: ProcessedSpec): string {
  const groups = new Map<string, IndexedOperation[]>();
  for (const op of localSpec.operations) {
    const key = op.primaryTag || 'default';
    const arr = groups.get(key) ?? [];
    arr.push(op);
    groups.set(key, arr);
  }

  const operationFactoryLines: string[] = [];
  operationFactoryLines.push('  function buildProxyForConsole(consoleId) {');
  operationFactoryLines.push('    var ns = {');
  operationFactoryLines.push(`      spec: ${JSON.stringify({
    title: localSpec.title,
    version: localSpec.version,
    sourceUrl: localSpec.sourceUrl,
    operationCount: localSpec.operations.length,
  })},`);
  operationFactoryLines.push('      consoleId: consoleId,');
  operationFactoryLines.push(
    '      request: function(args) { return __unifiRawCloudNetwork(consoleId, JSON.stringify(args || {})); },',
  );
  operationFactoryLines.push(
    '      callOperation: function(opId, args) { return __unifiCallCloudNetwork(consoleId, opId, JSON.stringify(args || {})); }',
  );
  operationFactoryLines.push('    };');

  for (const [tag, ops] of groups) {
    const safeTag = sanitizeIdentifier(tag);
    operationFactoryLines.push(`    ns.${safeTag} = {};`);
    for (const op of ops) {
      const methodName = sanitizeIdentifier(op.operationId);
      operationFactoryLines.push(
        `    ns.${safeTag}.${methodName} = function(args) { return __unifiCallCloudNetwork(consoleId, ${JSON.stringify(op.operationId)}, JSON.stringify(args || {})); };`,
      );
    }
  }

  operationFactoryLines.push('    return ns;');
  operationFactoryLines.push('  }');

  return [
    '(function() {',
    '  if (typeof unifi.cloud !== "object" || unifi.cloud === null || unifi.cloud.__missing) {',
    '    return; // cloud namespace not available; nothing to attach',
    '  }',
    '  var cache = {};',
    ...operationFactoryLines,
    '  unifi.cloud.network = function(consoleId) {',
    '    if (typeof consoleId !== "string" || consoleId.length === 0) {',
    '      throw new Error("unifi.cloud.network(consoleId): consoleId must be a non-empty string. Find it in https://unifi.ui.com/consoles/<id>/.");',
    '    }',
    '    if (cache[consoleId]) return cache[consoleId];',
    '    cache[consoleId] = buildProxyForConsole(consoleId);',
    '    return cache[consoleId];',
    '  };',
    '})();',
  ].join('\n');
}

/**
 * Local Protect: emits `unifi.local.protect.*` using the same Protect spec.
 *
 * Routes through host bindings `__unifiCallLocalProtect(opId, argsJson)` and
 * `__unifiRawLocalProtect(argsJson)`.
 */
function buildLocalProtectPrelude(protectSpec: ProcessedSpec): string {
  const groups = new Map<string, IndexedOperation[]>();
  for (const op of protectSpec.operations) {
    const key = op.primaryTag || 'default';
    const arr = groups.get(key) ?? [];
    arr.push(op);
    groups.set(key, arr);
  }

  const lines: string[] = [];
  lines.push('(function() {');
  lines.push('  if (typeof unifi.local !== "object" || unifi.local === null) {');
  lines.push('    unifi.local = {};');
  lines.push('  }');
  lines.push('  var protectNs = {');
  lines.push(`    spec: ${JSON.stringify({
    title: protectSpec.title,
    version: protectSpec.version,
    sourceUrl: protectSpec.sourceUrl,
    operationCount: protectSpec.operations.length,
  })},`);
  lines.push(
    '    request: function(args) { return __unifiRawLocalProtect(JSON.stringify(args || {})); },',
  );
  lines.push(
    '    callOperation: function(opId, args) { return __unifiCallLocalProtect(opId, JSON.stringify(args || {})); }',
  );
  lines.push('  };');

  for (const [tag, ops] of groups) {
    const safeTag = sanitizeIdentifier(tag);
    // Avoid colliding with the protectNs.spec / request / callOperation
    // properties we just defined.
    if (safeTag === 'spec' || safeTag === 'request' || safeTag === 'callOperation') continue;
    lines.push(`  protectNs.${safeTag} = {};`);
    for (const op of ops) {
      const methodName = sanitizeIdentifier(op.operationId);
      lines.push(
        `  protectNs.${safeTag}.${methodName} = function(args) { return __unifiCallLocalProtect(${JSON.stringify(op.operationId)}, JSON.stringify(args || {})); };`,
      );
    }
  }

  lines.push('  unifi.local.protect = protectNs;');
  lines.push('})();');

  return lines.join('\n');
}

/**
 * Cloud→Protect proxy: emits a `unifi.cloud.protect(consoleId)` factory.
 * Identical structure to `unifi.cloud.network()` but routed through host
 * bindings `__unifiCallCloudProtect(consoleId, opId, argsJson)` and
 * `__unifiRawCloudProtect(consoleId, argsJson)`.
 */
function buildCloudProtectProxyPrelude(protectSpec: ProcessedSpec): string {
  const groups = new Map<string, IndexedOperation[]>();
  for (const op of protectSpec.operations) {
    const key = op.primaryTag || 'default';
    const arr = groups.get(key) ?? [];
    arr.push(op);
    groups.set(key, arr);
  }

  const operationFactoryLines: string[] = [];
  operationFactoryLines.push('  function buildProtectProxyForConsole(consoleId) {');
  operationFactoryLines.push('    var ns = {');
  operationFactoryLines.push(`      spec: ${JSON.stringify({
    title: protectSpec.title,
    version: protectSpec.version,
    sourceUrl: protectSpec.sourceUrl,
    operationCount: protectSpec.operations.length,
  })},`);
  operationFactoryLines.push('      consoleId: consoleId,');
  operationFactoryLines.push(
    '      request: function(args) { return __unifiRawCloudProtect(consoleId, JSON.stringify(args || {})); },',
  );
  operationFactoryLines.push(
    '      callOperation: function(opId, args) { return __unifiCallCloudProtect(consoleId, opId, JSON.stringify(args || {})); }',
  );
  operationFactoryLines.push('    };');

  for (const [tag, ops] of groups) {
    const safeTag = sanitizeIdentifier(tag);
    if (safeTag === 'spec' || safeTag === 'request' || safeTag === 'callOperation') continue;
    operationFactoryLines.push(`    ns.${safeTag} = {};`);
    for (const op of ops) {
      const methodName = sanitizeIdentifier(op.operationId);
      operationFactoryLines.push(
        `    ns.${safeTag}.${methodName} = function(args) { return __unifiCallCloudProtect(consoleId, ${JSON.stringify(op.operationId)}, JSON.stringify(args || {})); };`,
      );
    }
  }

  operationFactoryLines.push('    return ns;');
  operationFactoryLines.push('  }');

  return [
    '(function() {',
    '  if (typeof unifi.cloud !== "object" || unifi.cloud === null || unifi.cloud.__missing) {',
    '    return; // cloud namespace not available; nothing to attach',
    '  }',
    '  var cache = {};',
    ...operationFactoryLines,
    '  unifi.cloud.protect = function(consoleId) {',
    '    if (typeof consoleId !== "string" || consoleId.length === 0) {',
    '      throw new Error("unifi.cloud.protect(consoleId): consoleId must be a non-empty string. Find it in https://unifi.ui.com/consoles/<id>/.");',
    '    }',
    '    if (cache[consoleId]) return cache[consoleId];',
    '    cache[consoleId] = buildProtectProxyForConsole(consoleId);',
    '    return cache[consoleId];',
    '  };',
    '})();',
  ].join('\n');
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
