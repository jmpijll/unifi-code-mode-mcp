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
import { createLocalClient, createLocalProtectClient } from '../client/local.js';
import {
  createCloudClient,
  createCloudNetworkProxyClient,
  createCloudProtectProxyClient,
} from '../client/cloud.js';
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
  /** Local spec (mandatory for unifi.local.* and unifi.cloud.network() methods). */
  localSpec?: ProcessedSpec;
  /** Cloud spec (mandatory for unifi.cloud.* native methods). */
  cloudSpec?: ProcessedSpec;
  /**
   * Protect spec (mandatory for unifi.local.protect.* and
   * unifi.cloud.protect() methods).
   */
  protectSpec?: ProcessedSpec;
  /** Lazy local client factory — only invoked if the sandbox calls a local operation. */
  buildLocalClient?: (tenant: TenantContext, onWarn: (msg: string) => void) => HttpClient;
  /** Lazy cloud client factory — only invoked if the sandbox calls a cloud operation. */
  buildCloudClient?: (tenant: TenantContext, onWarn: (msg: string) => void) => HttpClient;
  /**
   * Lazy cloud-network-proxy client factory — only invoked if the sandbox
   * calls a cloud-proxied Network operation. One client per consoleId.
   */
  buildCloudNetworkClient?: (
    tenant: TenantContext,
    consoleId: string,
    onWarn: (msg: string) => void,
  ) => HttpClient;
  /**
   * Lazy local-Protect client factory — only invoked if the sandbox
   * calls a unifi.local.protect.* operation.
   */
  buildLocalProtectClient?: (
    tenant: TenantContext,
    onWarn: (msg: string) => void,
  ) => HttpClient;
  /**
   * Lazy cloud-Protect-proxy client factory — only invoked if the sandbox
   * calls a unifi.cloud.protect(consoleId).* operation.
   */
  buildCloudProtectClient?: (
    tenant: TenantContext,
    consoleId: string,
    onWarn: (msg: string) => void,
  ) => HttpClient;
  /** Sandbox limits (timeout, memory, calls). */
  limits?: Partial<SandboxLimits>;
}

export class ExecuteExecutor {
  private readonly tenant: TenantContext;
  private readonly localSpec?: ProcessedSpec;
  private readonly cloudSpec?: ProcessedSpec;
  private readonly protectSpec?: ProcessedSpec;
  private readonly limits: SandboxLimits;
  private readonly buildLocalClient: NonNullable<ExecuteExecutorOptions['buildLocalClient']>;
  private readonly buildCloudClient: NonNullable<ExecuteExecutorOptions['buildCloudClient']>;
  private readonly buildCloudNetworkClient: NonNullable<
    ExecuteExecutorOptions['buildCloudNetworkClient']
  >;
  private readonly buildLocalProtectClient: NonNullable<
    ExecuteExecutorOptions['buildLocalProtectClient']
  >;
  private readonly buildCloudProtectClient: NonNullable<
    ExecuteExecutorOptions['buildCloudProtectClient']
  >;

  constructor(opts: ExecuteExecutorOptions) {
    this.tenant = opts.tenant;
    this.localSpec = opts.localSpec;
    this.cloudSpec = opts.cloudSpec;
    this.protectSpec = opts.protectSpec;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.buildLocalClient = opts.buildLocalClient ?? defaultBuildLocalClient;
    this.buildCloudClient = opts.buildCloudClient ?? defaultBuildCloudClient;
    this.buildCloudNetworkClient =
      opts.buildCloudNetworkClient ?? defaultBuildCloudNetworkClient;
    this.buildLocalProtectClient =
      opts.buildLocalProtectClient ?? defaultBuildLocalProtectClient;
    this.buildCloudProtectClient =
      opts.buildCloudProtectClient ?? defaultBuildCloudProtectClient;
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
    const cloudNetworkClients = new Map<string, HttpClient>();
    let localProtectClient: HttpClient | undefined;
    const cloudProtectClients = new Map<string, HttpClient>();
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

      // Cloud-proxied Network surface: re-uses the LOCAL Network spec for
      // operation lookups but routes calls through the cloud key + the
      // /v1/connector/consoles/{id}/proxy/network/integration prefix.
      bindCloudNetworkProxyFunctions(context, {
        getCloudNetworkClient: (consoleId) => {
          if (!this.localSpec) {
            throw new Error(
              'No local Network spec loaded; cannot proxy Network calls via the cloud connector.',
            );
          }
          if (!this.tenant.cloud) throw new MissingCredentialsError('cloud');
          const cached = cloudNetworkClients.get(consoleId);
          if (cached) return cached;
          const built = this.buildCloudNetworkClient(this.tenant, consoleId, onWarn);
          cloudNetworkClients.set(consoleId, built);
          return built;
        },
        getNetworkSpec: () => this.localSpec,
        callBudgetGuard,
      });

      // Local Protect surface: uses the Protect spec, the tenant's local
      // credentials, and the /proxy/protect/integration prefix on the
      // controller.
      bindLocalProtectFunctions(context, {
        getClient: () => {
          if (!this.protectSpec) {
            throw new Error(
              'No Protect spec loaded; cannot dispatch unifi.local.protect operations.',
            );
          }
          if (!this.tenant.local) throw new MissingCredentialsError('local');
          localProtectClient ??= this.buildLocalProtectClient(this.tenant, onWarn);
          return localProtectClient;
        },
        getSpec: () => this.protectSpec,
        callBudgetGuard,
      });

      // Cloud-proxied Protect surface: same Protect spec, but routes through
      // the Site Manager connector at /v1/connector/consoles/{id}/proxy/protect/integration.
      bindCloudProtectProxyFunctions(context, {
        getClient: (consoleId) => {
          if (!this.protectSpec) {
            throw new Error(
              'No Protect spec loaded; cannot proxy Protect calls via the cloud connector.',
            );
          }
          if (!this.tenant.cloud) throw new MissingCredentialsError('cloud');
          const cached = cloudProtectClients.get(consoleId);
          if (cached) return cached;
          const built = this.buildCloudProtectClient(this.tenant, consoleId, onWarn);
          cloudProtectClients.set(consoleId, built);
          return built;
        },
        getSpec: () => this.protectSpec,
        callBudgetGuard,
      });

      // Build and inject the unifi namespace prelude. Each surface is gated on
      // having the spec it needs to derive operations from — credentials are
      // checked at call time by the host bindings (see bind*Functions below).
      //
      //  - exposeCloudNetworkProxy needs the Network (local) spec because the
      //    proxy reuses Network operation shapes, just routed through the
      //    /v1/connector/consoles/{id}/proxy/network/integration prefix.
      //  - exposeLocalProtect / exposeCloudProtectProxy need the Protect spec.
      //
      // Notably, neither cloud proxy needs the Site Manager native spec
      // (cloudSpec) — that spec is for unifi.cloud.<tag>.<op>, not the
      // proxy factories. Gating on it would make Protect-only and
      // Network-proxy-only deployments impossible.
      const prelude = buildUnifiPrelude(this.localSpec, this.cloudSpec, {
        exposeCloudNetworkProxy: Boolean(this.localSpec),
        protectSpec: this.protectSpec,
        exposeLocalProtect: Boolean(this.protectSpec),
        exposeCloudProtectProxy: Boolean(this.protectSpec),
      });
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
            const dumped: unknown = context.dump(state.value);
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

interface CloudNetworkBinding {
  getCloudNetworkClient: (consoleId: string) => HttpClient;
  getNetworkSpec: () => ProcessedSpec | undefined;
  callBudgetGuard: () => void;
}

function bindCloudNetworkProxyFunctions(
  context: QuickJSAsyncContext,
  binding: CloudNetworkBinding,
): void {
  const callFn = context.newAsyncifiedFunction(
    '__unifiCallCloudNetwork',
    async (
      consoleIdHandle: QuickJSHandle,
      opIdHandle: QuickJSHandle,
      argsJsonHandle: QuickJSHandle,
    ) => {
      const consoleId = context.getString(consoleIdHandle);
      const opId = context.getString(opIdHandle);
      const argsJson = context.getString(argsJsonHandle);
      try {
        binding.callBudgetGuard();
        if (!consoleId) {
          throw new Error('unifi.cloud.network: consoleId is required.');
        }
        const args = parseJson(argsJson);
        const spec = binding.getNetworkSpec();
        if (!spec) {
          throw new Error(
            'unifi.cloud.network: Network spec not loaded — cannot dispatch operation.',
          );
        }
        const client = binding.getCloudNetworkClient(consoleId);
        const response = await dispatchOperation(client, spec, 'cloud.network', opId, args);
        return jsonResponseToHandle(context, response.data);
      } catch (err) {
        throw new Error(formatCloudNetworkError(err));
      }
    },
  );
  context.setProp(context.global, '__unifiCallCloudNetwork', callFn);
  callFn.dispose();

  const rawFn = context.newAsyncifiedFunction(
    '__unifiRawCloudNetwork',
    async (consoleIdHandle: QuickJSHandle, argsJsonHandle: QuickJSHandle) => {
      const consoleId = context.getString(consoleIdHandle);
      const argsJson = context.getString(argsJsonHandle);
      try {
        binding.callBudgetGuard();
        if (!consoleId) {
          throw new Error('unifi.cloud.network: consoleId is required.');
        }
        const args = parseJson(argsJson) as unknown as Parameters<typeof dispatchRawRequest>[1];
        const client = binding.getCloudNetworkClient(consoleId);
        const response = await dispatchRawRequest(client, args);
        return jsonResponseToHandle(context, response.data);
      } catch (err) {
        throw new Error(formatCloudNetworkError(err));
      }
    },
  );
  context.setProp(context.global, '__unifiRawCloudNetwork', rawFn);
  rawFn.dispose();
}

function formatCloudNetworkError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const tag =
    err instanceof UnifiHttpError
      ? 'unifi.cloud.network.http'
      : err instanceof MissingCredentialsError
      ? 'unifi.cloud.network.missing-credentials'
      : err instanceof UnknownOperationError
      ? 'unifi.cloud.network.unknown-operation'
      : 'unifi.cloud.network.error';
  return `[${tag}] ${detail}`;
}

// ─── Protect: local + cloud-proxy ───────────────────────────────────

interface LocalProtectBinding {
  getClient: () => HttpClient;
  getSpec: () => ProcessedSpec | undefined;
  callBudgetGuard: () => void;
}

function bindLocalProtectFunctions(
  context: QuickJSAsyncContext,
  binding: LocalProtectBinding,
): void {
  const callFn = context.newAsyncifiedFunction(
    '__unifiCallLocalProtect',
    async (opIdHandle: QuickJSHandle, argsJsonHandle: QuickJSHandle) => {
      const opId = context.getString(opIdHandle);
      const argsJson = context.getString(argsJsonHandle);
      try {
        binding.callBudgetGuard();
        const args = parseJson(argsJson);
        const spec = binding.getSpec();
        if (!spec) throw new Error('unifi.local.protect: spec not loaded');
        const client = binding.getClient();
        const response = await dispatchOperation(client, spec, 'local.protect', opId, args);
        return jsonResponseToHandle(context, response.data);
      } catch (err) {
        throw new Error(formatLocalProtectError(err));
      }
    },
  );
  context.setProp(context.global, '__unifiCallLocalProtect', callFn);
  callFn.dispose();

  const rawFn = context.newAsyncifiedFunction(
    '__unifiRawLocalProtect',
    async (argsJsonHandle: QuickJSHandle) => {
      const argsJson = context.getString(argsJsonHandle);
      try {
        binding.callBudgetGuard();
        const args = parseJson(argsJson) as unknown as Parameters<typeof dispatchRawRequest>[1];
        const client = binding.getClient();
        const response = await dispatchRawRequest(client, args);
        return jsonResponseToHandle(context, response.data);
      } catch (err) {
        throw new Error(formatLocalProtectError(err));
      }
    },
  );
  context.setProp(context.global, '__unifiRawLocalProtect', rawFn);
  rawFn.dispose();
}

interface CloudProtectBinding {
  getClient: (consoleId: string) => HttpClient;
  getSpec: () => ProcessedSpec | undefined;
  callBudgetGuard: () => void;
}

function bindCloudProtectProxyFunctions(
  context: QuickJSAsyncContext,
  binding: CloudProtectBinding,
): void {
  const callFn = context.newAsyncifiedFunction(
    '__unifiCallCloudProtect',
    async (
      consoleIdHandle: QuickJSHandle,
      opIdHandle: QuickJSHandle,
      argsJsonHandle: QuickJSHandle,
    ) => {
      const consoleId = context.getString(consoleIdHandle);
      const opId = context.getString(opIdHandle);
      const argsJson = context.getString(argsJsonHandle);
      try {
        binding.callBudgetGuard();
        if (!consoleId) {
          throw new Error('unifi.cloud.protect: consoleId is required.');
        }
        const args = parseJson(argsJson);
        const spec = binding.getSpec();
        if (!spec) {
          throw new Error(
            'unifi.cloud.protect: Protect spec not loaded — cannot dispatch operation.',
          );
        }
        const client = binding.getClient(consoleId);
        const response = await dispatchOperation(client, spec, 'cloud.protect', opId, args);
        return jsonResponseToHandle(context, response.data);
      } catch (err) {
        throw new Error(formatCloudProtectError(err));
      }
    },
  );
  context.setProp(context.global, '__unifiCallCloudProtect', callFn);
  callFn.dispose();

  const rawFn = context.newAsyncifiedFunction(
    '__unifiRawCloudProtect',
    async (consoleIdHandle: QuickJSHandle, argsJsonHandle: QuickJSHandle) => {
      const consoleId = context.getString(consoleIdHandle);
      const argsJson = context.getString(argsJsonHandle);
      try {
        binding.callBudgetGuard();
        if (!consoleId) {
          throw new Error('unifi.cloud.protect: consoleId is required.');
        }
        const args = parseJson(argsJson) as unknown as Parameters<typeof dispatchRawRequest>[1];
        const client = binding.getClient(consoleId);
        const response = await dispatchRawRequest(client, args);
        return jsonResponseToHandle(context, response.data);
      } catch (err) {
        throw new Error(formatCloudProtectError(err));
      }
    },
  );
  context.setProp(context.global, '__unifiRawCloudProtect', rawFn);
  rawFn.dispose();
}

function formatLocalProtectError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const tag =
    err instanceof UnifiHttpError
      ? 'unifi.local.protect.http'
      : err instanceof MissingCredentialsError
      ? 'unifi.local.protect.missing-credentials'
      : err instanceof UnknownOperationError
      ? 'unifi.local.protect.unknown-operation'
      : 'unifi.local.protect.error';
  return `[${tag}] ${detail}`;
}

function formatCloudProtectError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const tag =
    err instanceof UnifiHttpError
      ? 'unifi.cloud.protect.http'
      : err instanceof MissingCredentialsError
      ? 'unifi.cloud.protect.missing-credentials'
      : err instanceof UnknownOperationError
      ? 'unifi.cloud.protect.unknown-operation'
      : 'unifi.cloud.protect.error';
  return `[${tag}] ${detail}`;
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

function defaultBuildCloudNetworkClient(
  tenant: TenantContext,
  consoleId: string,
  onWarn: (msg: string) => void,
): HttpClient {
  if (!tenant.cloud) throw new MissingCredentialsError('cloud');
  return createCloudNetworkProxyClient(tenant.cloud, consoleId, { onWarn });
}

function defaultBuildLocalProtectClient(
  tenant: TenantContext,
  onWarn: (msg: string) => void,
): HttpClient {
  if (!tenant.local) throw new MissingCredentialsError('local');
  return createLocalProtectClient(tenant.local, { onWarn });
}

function defaultBuildCloudProtectClient(
  tenant: TenantContext,
  consoleId: string,
  onWarn: (msg: string) => void,
): HttpClient {
  if (!tenant.cloud) throw new MissingCredentialsError('cloud');
  return createCloudProtectProxyClient(tenant.cloud, consoleId, { onWarn });
}
