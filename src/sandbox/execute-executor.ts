/**
 * Execute Executor — runs LLM-written JS that performs real UniFi API calls.
 *
 * Async QuickJS context. Per-tenant credentials are bound at construction
 * time so each MCP request gets its own short-lived executor.
 *
 * Sandbox surface:
 *   unifi.local.<tag>.<operationId>(args) -> Promise
 *   unifi.local.callOperation(operationId, args) -> Promise
 *   unifi.local.request({ method, path, pathParams?, query?, body?, headers? }) -> Promise
 *   unifi.local.spec -> { title, version, sourceUrl, operationCount }
 *   (same shape for unifi.cloud)
 *
 * Hosts are responsible for enforcing the per-execute call budget.
 */

import {
  newAsyncContext,
  type QuickJSAsyncContext,
  type QuickJSHandle,
} from 'quickjs-emscripten';
import type { HttpClient } from '../client/http.js';
import { createLocalClient } from '../client/local.js';
import { createCloudClient } from '../client/cloud.js';
import { UnifiHttpError } from '../client/types.js';
import {
  buildUnifiPrelude,
  dispatchOperation,
  dispatchRawRequest,
  UnknownOperationError,
} from './dispatch.js';
import {
  configureRuntimeLimits,
  formatError,
  setupConsole,
} from './executor.js';
import { DEFAULT_LIMITS, type SandboxLimits } from './limits.js';
import type { ExecuteResult, LogEntry } from './types.js';
import { MissingCredentialsError, type TenantContext } from '../tenant/context.js';
import type { ProcessedSpec } from '../types/spec.js';

export interface ExecuteExecutorOptions {
  /** Tenant credentials — sandboxed clients are built from these on demand. */
  tenant: TenantContext;
  /** Local spec (mandatory for unifi.local.* methods to be defined). */
  localSpec?: ProcessedSpec;
  /** Cloud spec (mandatory for unifi.cloud.* methods to be defined). */
  cloudSpec?: ProcessedSpec;
  /** Lazy local client factory — only invoked if the sandbox calls a local operation. */
  buildLocalClient?: (tenant: TenantContext, onWarn: (msg: string) => void) => HttpClient;
  /** Lazy cloud client factory — only invoked if the sandbox calls a cloud operation. */
  buildCloudClient?: (tenant: TenantContext, onWarn: (msg: string) => void) => HttpClient;
  /** Sandbox limits (timeout, memory, calls). */
  limits?: Partial<SandboxLimits>;
}

export class ExecuteExecutor {
  private readonly tenant: TenantContext;
  private readonly localSpec?: ProcessedSpec;
  private readonly cloudSpec?: ProcessedSpec;
  private readonly limits: SandboxLimits;
  private readonly buildLocalClient: NonNullable<ExecuteExecutorOptions['buildLocalClient']>;
  private readonly buildCloudClient: NonNullable<ExecuteExecutorOptions['buildCloudClient']>;

  constructor(opts: ExecuteExecutorOptions) {
    this.tenant = opts.tenant;
    this.localSpec = opts.localSpec;
    this.cloudSpec = opts.cloudSpec;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.buildLocalClient = opts.buildLocalClient ?? defaultBuildLocalClient;
    this.buildCloudClient = opts.buildCloudClient ?? defaultBuildCloudClient;
  }

  async execute(code: string): Promise<ExecuteResult> {
    const startTime = Date.now();
    const logs: LogEntry[] = [];
    const warnings: string[] = [];
    let callsMade = 0;

    const context = await newAsyncContext();
    const runtime = context.runtime;

    let localClient: HttpClient | undefined;
    let cloudClient: HttpClient | undefined;
    const onWarn = (msg: string): void => {
      if (!warnings.includes(msg)) warnings.push(msg);
    };

    try {
      configureRuntimeLimits(runtime, this.limits);
      setupConsole(context, logs);

      // Bind host-side dispatch functions.
      const callBudgetGuard = (): void => {
        callsMade += 1;
        if (callsMade > this.limits.maxCallsPerExecute) {
          throw new Error(
            `API call limit exceeded (max ${String(this.limits.maxCallsPerExecute)} calls per execute). ` +
              'Use more targeted queries or batch results.',
          );
        }
      };

      bindNamespaceFunctions(context, 'local', {
        getClient: () => {
          if (!this.localSpec) {
            throw new Error('No local spec loaded; cannot dispatch local operations.');
          }
          if (!this.tenant.local) throw new MissingCredentialsError('local');
          localClient ??= this.buildLocalClient(this.tenant, onWarn);
          return localClient;
        },
        getSpec: () => this.localSpec,
        callBudgetGuard,
      });

      bindNamespaceFunctions(context, 'cloud', {
        getClient: () => {
          if (!this.cloudSpec) {
            throw new Error('No cloud spec loaded; cannot dispatch cloud operations.');
          }
          if (!this.tenant.cloud) throw new MissingCredentialsError('cloud');
          cloudClient ??= this.buildCloudClient(this.tenant, onWarn);
          return cloudClient;
        },
        getSpec: () => this.cloudSpec,
        callBudgetGuard,
      });

      // Build and inject the unifi namespace prelude.
      const prelude = buildUnifiPrelude(this.localSpec, this.cloudSpec);
      const preludeResult = context.evalCode(prelude, 'prelude.js', { type: 'global' });
      if (preludeResult.error) {
        const errValue: unknown = context.dump(preludeResult.error);
        preludeResult.error.dispose();
        throw new Error(`Failed to bootstrap unifi namespace: ${formatError(errValue)}`);
      }
      preludeResult.value.dispose();

      // Run user code. evalCodeAsync awaits asyncified host calls. Inside
      // the sandbox, `unifi.<ns>.<op>(...)` and `unifi.<ns>.request(...)`
      // appear synchronous (the `newAsyncifiedFunction` wrapper makes them
      // sync to QuickJS). The script's last expression is the value.
      const result = await context.evalCodeAsync(code, 'sandbox.js', { type: 'global' });
      if (result.error) {
        const errorValue: unknown = context.dump(result.error);
        result.error.dispose();
        return {
          ok: false,
          error: formatError(errorValue),
          logs,
          warnings,
          callsMade,
          durationMs: Date.now() - startTime,
        };
      }

      // If the script returned a Promise (e.g. from an `async` IIFE),
      // drain the in-sandbox microtask queue and read the settled state.
      // For sync scripts, return the value directly.
      const valueHandle = result.value;
      try {
        if (context.typeof(valueHandle) !== 'object') {
          return {
            ok: true,
            data: context.dump(valueHandle),
            logs,
            warnings,
            callsMade,
            durationMs: Date.now() - startTime,
          };
        }

        const initial = context.getPromiseState(valueHandle);
        if (initial.type === 'fulfilled' && initial.notAPromise === true) {
          return {
            ok: true,
            data: context.dump(valueHandle),
            logs,
            warnings,
            callsMade,
            durationMs: Date.now() - startTime,
          };
        }

        const maxDrains = 1000;
        for (let i = 0; i < maxDrains; i += 1) {
          const state = context.getPromiseState(valueHandle);
          if (state.type === 'fulfilled') {
            const dumped = context.dump(state.value);
            state.value.dispose();
            return {
              ok: true,
              data: dumped,
              logs,
              warnings,
              callsMade,
              durationMs: Date.now() - startTime,
            };
          }
          if (state.type === 'rejected') {
            const dumped: unknown = context.dump(state.error);
            state.error.dispose();
            return {
              ok: false,
              error: formatError(dumped),
              logs,
              warnings,
              callsMade,
              durationMs: Date.now() - startTime,
            };
          }
          const drain = runtime.executePendingJobs(64);
          if (drain.error) {
            const errorValue: unknown = context.dump(drain.error);
            drain.error.dispose();
            return {
              ok: false,
              error: formatError(errorValue),
              logs,
              warnings,
              callsMade,
              durationMs: Date.now() - startTime,
            };
          }
          await new Promise<void>((r) => setImmediate(r));
        }
        return {
          ok: false,
          error: 'Sandbox promise did not settle within microtask budget',
          logs,
          warnings,
          callsMade,
          durationMs: Date.now() - startTime,
        };
      } finally {
        valueHandle.dispose();
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        logs,
        warnings,
        callsMade,
        durationMs: Date.now() - startTime,
      };
    } finally {
      // Dispose may throw in rare paths where the in-VM Promise rejection
      // machinery left dangling references (e.g. multiple in-flight
      // asyncified calls aborted mid-stream). The result has already been
      // captured at this point; tolerate the disposal failure rather than
      // surfacing a confusing WASM stack trace.
      try {
        context.dispose();
      } catch {
        /* swallow disposal-time WASM aborts */
      }
      try {
        runtime.dispose();
      } catch {
        /* swallow disposal-time WASM aborts */
      }
    }
  }
}

// ─── Bind host functions ────────────────────────────────────────────

interface NamespaceBinding {
  getClient: () => HttpClient;
  getSpec: () => ProcessedSpec | undefined;
  callBudgetGuard: () => void;
}

function bindNamespaceFunctions(
  context: QuickJSAsyncContext,
  namespace: 'local' | 'cloud',
  binding: NamespaceBinding,
): void {
  const callName = namespace === 'local' ? '__unifiCallLocal' : '__unifiCallCloud';
  const rawName = namespace === 'local' ? '__unifiRawLocal' : '__unifiRawCloud';

  const callFn = context.newAsyncifiedFunction(
    callName,
    async (opIdHandle: QuickJSHandle, argsJsonHandle: QuickJSHandle) => {
      // IMPORTANT: read the handles synchronously before any await — handle
      // lifetimes don't extend across async boundaries.
      const opId = context.getString(opIdHandle);
      const argsJson = context.getString(argsJsonHandle);
      try {
        binding.callBudgetGuard();
        const args = parseJson(argsJson);
        const spec = binding.getSpec();
        if (!spec) throw new Error(`unifi.${namespace}: spec not loaded`);
        const client = binding.getClient();
        const response = await dispatchOperation(client, spec, namespace, opId, args);
        return jsonResponseToHandle(context, response.data);
      } catch (err) {
        // Throwing here rejects the in-sandbox promise.
        throw new Error(formatNamespacedError(namespace, err));
      }
    },
  );
  context.setProp(context.global, callName, callFn);
  callFn.dispose();

  const rawFn = context.newAsyncifiedFunction(
    rawName,
    async (argsJsonHandle: QuickJSHandle) => {
      const argsJson = context.getString(argsJsonHandle);
      try {
        binding.callBudgetGuard();
        const args = parseJson(argsJson) as unknown as Parameters<typeof dispatchRawRequest>[1];
        const client = binding.getClient();
        const response = await dispatchRawRequest(client, args);
        return jsonResponseToHandle(context, response.data);
      } catch (err) {
        throw new Error(formatNamespacedError(namespace, err));
      }
    },
  );
  context.setProp(context.global, rawName, rawFn);
  rawFn.dispose();
}

function formatNamespacedError(namespace: 'local' | 'cloud', err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const tag =
    err instanceof UnifiHttpError
      ? `unifi.${namespace}.http`
      : err instanceof MissingCredentialsError
      ? `unifi.${namespace}.missing-credentials`
      : err instanceof UnknownOperationError
      ? `unifi.${namespace}.unknown-operation`
      : `unifi.${namespace}.error`;
  return `[${tag}] ${detail}`;
}

function parseJson(json: string): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

function jsonResponseToHandle(context: QuickJSAsyncContext, data: unknown): QuickJSHandle {
  // Use JSON.parse via a string handle. Calling evalCode with arbitrary JSON
  // as an expression has subtle re-entrancy issues with the async runtime, so
  // we go through a dedicated parse path that mirrors the FortiManager
  // reference implementation.
  const json = JSON.stringify(data ?? null);
  const stringHandle = context.newString(json);
  const parseExpr = context.evalCode('JSON.parse');
  if (parseExpr.error) {
    parseExpr.error.dispose();
    stringHandle.dispose();
    return context.null;
  }
  const parsed = context.callFunction(parseExpr.value, context.undefined, stringHandle);
  parseExpr.value.dispose();
  stringHandle.dispose();
  if (parsed.error) {
    parsed.error.dispose();
    return context.null;
  }
  return parsed.value;
}


// ─── Default client factories ───────────────────────────────────────

function defaultBuildLocalClient(
  tenant: TenantContext,
  onWarn: (msg: string) => void,
): HttpClient {
  if (!tenant.local) throw new MissingCredentialsError('local');
  return createLocalClient(tenant.local, { onWarn });
}

function defaultBuildCloudClient(
  tenant: TenantContext,
  onWarn: (msg: string) => void,
): HttpClient {
  if (!tenant.cloud) throw new MissingCredentialsError('cloud');
  return createCloudClient(tenant.cloud, { onWarn });
}
