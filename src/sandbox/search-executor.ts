/**
 * Search Executor — runs LLM-written JS against the OpenAPI specs.
 *
 * Sync QuickJS context. No network. Exposes:
 *   - `spec.local`, `spec.cloud` — { title, version, sourceUrl, serverPrefix, operations[] }
 *     Each operation is the compact form from `summarizeOperation()`.
 *   - `getOperation(namespace, idOrMethodPath)` — full operation lookup
 *   - `searchOperations(namespace, query, limit?)` — ranked text search
 *   - `findOperationsByPath(namespace, pattern)` — substring on path
 */

import type { QuickJSContext, QuickJSHandle, QuickJSRuntime } from 'quickjs-emscripten';
import { findOperation, searchOperations, summarizeOperation } from '../spec/index.js';
import type { ProcessedSpec } from '../types/spec.js';
import { BaseSyncExecutor, injectJsonValue } from './executor.js';
import { SEARCH_MAX_MEMORY_BYTES, SEARCH_TIMEOUT_MS } from './limits.js';

export interface SearchExecutorOptions {
  local?: ProcessedSpec;
  cloud?: ProcessedSpec;
}

export class SearchExecutor extends BaseSyncExecutor {
  private readonly local?: ProcessedSpec;
  private readonly cloud?: ProcessedSpec;

  constructor(options: SearchExecutorOptions) {
    super({ timeoutMs: SEARCH_TIMEOUT_MS, maxMemoryBytes: SEARCH_MAX_MEMORY_BYTES });
    this.local = options.local;
    this.cloud = options.cloud;
  }

  protected setupContext(
    context: QuickJSContext,
    _runtime: QuickJSRuntime,
    _warnings: string[],
  ): void {
    const summarize = (spec: ProcessedSpec | undefined): unknown => {
      if (!spec) return null;
      return {
        title: spec.title,
        version: spec.version,
        sourceUrl: spec.sourceUrl,
        serverPrefix: spec.serverPrefix,
        operations: spec.operations.map(summarizeOperation),
      };
    };

    injectJsonValue(context, 'spec', {
      local: summarize(this.local),
      cloud: summarize(this.cloud),
    });

    // getOperation(namespace, identifier) — full operation incl. spec parameter details.
    const getOperationFn = context.newFunction(
      'getOperation',
      (nsHandle: QuickJSHandle, idHandle: QuickJSHandle) => {
        const ns = context.getString(nsHandle);
        const id = context.getString(idHandle);
        const spec = this.specFor(ns);
        if (!spec) return context.null;
        const op = findOperation(spec, id);
        if (!op) return context.null;
        return jsonValueToHandle(context, op);
      },
    );
    context.setProp(context.global, 'getOperation', getOperationFn);
    getOperationFn.dispose();

    // searchOperations(namespace, query, limit?) — ranked text search.
    const searchFn = context.newFunction(
      'searchOperations',
      (nsHandle: QuickJSHandle, qHandle: QuickJSHandle, limitHandle?: QuickJSHandle) => {
        const ns = context.getString(nsHandle);
        const q = context.getString(qHandle);
        const limit = limitHandle ? context.getNumber(limitHandle) : 25;
        const spec = this.specFor(ns);
        if (!spec) {
          return jsonValueToHandle(context, []);
        }
        const ops = searchOperations(spec, q, limit).map(summarizeOperation);
        return jsonValueToHandle(context, ops);
      },
    );
    context.setProp(context.global, 'searchOperations', searchFn);
    searchFn.dispose();

    // findOperationsByPath(namespace, pathPattern) — substring on path.
    const byPathFn = context.newFunction(
      'findOperationsByPath',
      (nsHandle: QuickJSHandle, pHandle: QuickJSHandle) => {
        const ns = context.getString(nsHandle);
        const pattern = context.getString(pHandle).toLowerCase();
        const spec = this.specFor(ns);
        if (!spec) {
          return jsonValueToHandle(context, []);
        }
        const matches = spec.operations
          .filter((op) => op.path.toLowerCase().includes(pattern))
          .map(summarizeOperation);
        return jsonValueToHandle(context, matches);
      },
    );
    context.setProp(context.global, 'findOperationsByPath', byPathFn);
    byPathFn.dispose();
  }

  private specFor(namespace: string): ProcessedSpec | undefined {
    if (namespace === 'local') return this.local;
    if (namespace === 'cloud') return this.cloud;
    return undefined;
  }
}

function jsonValueToHandle(context: QuickJSContext, value: unknown): QuickJSHandle {
  const json = JSON.stringify(value);
  const result = context.evalCode(`(${json})`);
  if (result.error) {
    result.error.dispose();
    return context.null;
  }
  return result.value;
}
