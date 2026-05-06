/**
 * Base QuickJS sandbox executor — shared lifecycle for both `search` and
 * `execute` tools. Handles runtime limits, console capture, and result/error
 * extraction. Subclasses inject globals via `setupContext()`.
 *
 * Modeled on the FortiManager Code-Mode reference implementation
 * ([src/executor/executor.ts](https://github.com/jmpijll/fortimanager-code-mode-mcp/blob/main/src/executor/executor.ts))
 * but reframed for the UniFi project's per-tenant async clients.
 */

import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';
import {
  DEFAULT_LIMITS,
  MAX_LOG_ENTRIES,
  MAX_LOG_SIZE_BYTES,
  type SandboxLimits,
} from './limits.js';
import type { ExecuteResult, LogEntry } from './types.js';

let quickJSModule: QuickJSWASMModule | null = null;

/** Get or initialize the shared QuickJS WASM module (singleton). */
export async function getQuickJSModule(): Promise<QuickJSWASMModule> {
  quickJSModule ??= await getQuickJS();
  return quickJSModule;
}

export abstract class BaseSyncExecutor {
  protected limits: SandboxLimits;

  constructor(limits: Partial<SandboxLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async execute(code: string): Promise<ExecuteResult> {
    const startTime = Date.now();
    const logs: LogEntry[] = [];
    const warnings: string[] = [];

    const quickJS = await getQuickJSModule();
    const runtime = quickJS.newRuntime();
    const context = runtime.newContext();

    try {
      configureRuntimeLimits(runtime, this.limits);
      setupConsole(context, logs);
      this.setupContext(context, runtime, warnings);

      const result = context.evalCode(code, 'sandbox.js', { type: 'global' });
      if (result.error) {
        const errorValue: unknown = context.dump(result.error);
        result.error.dispose();
        return {
          ok: false,
          error: formatError(errorValue),
          logs,
          warnings,
          durationMs: Date.now() - startTime,
        };
      }

      const value: unknown = context.dump(result.value);
      result.value.dispose();
      return {
        ok: true,
        data: value,
        logs,
        warnings,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        logs,
        warnings,
        durationMs: Date.now() - startTime,
      };
    } finally {
      context.dispose();
      runtime.dispose();
    }
  }

  protected abstract setupContext(
    context: QuickJSContext,
    runtime: QuickJSRuntime,
    warnings: string[],
  ): void;
}

// ─── Helpers (shared between sync and async executors) ──────────────

export function configureRuntimeLimits(runtime: QuickJSRuntime, limits: SandboxLimits): void {
  runtime.setMemoryLimit(limits.maxMemoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + limits.timeoutMs;
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
}

export function setupConsole(context: QuickJSContext, logs: LogEntry[]): void {
  const consoleObj = context.newObject();
  let totalLogSize = 0;

  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const fn = context.newFunction(level, (...args: QuickJSHandle[]) => {
      if (logs.length >= MAX_LOG_ENTRIES || totalLogSize >= MAX_LOG_SIZE_BYTES) return;
      const parts = args.map((a) => {
        try {
          return stringifyValue(context.dump(a));
        } catch {
          return '[unserializable]';
        }
      });
      const message = parts.join(' ');
      totalLogSize += message.length;
      if (totalLogSize > MAX_LOG_SIZE_BYTES) {
        logs.push({
          level: 'warn',
          message: `[log output truncated — exceeded ${String(MAX_LOG_SIZE_BYTES)} byte limit]`,
          timestamp: Date.now(),
        });
        return;
      }
      logs.push({ level, message, timestamp: Date.now() });
    });
    context.setProp(consoleObj, level, fn);
    fn.dispose();
  }
  context.setProp(context.global, 'console', consoleObj);
  consoleObj.dispose();
}

export function injectJsonValue(
  context: QuickJSContext,
  globalName: string,
  value: unknown,
): void {
  const json = JSON.stringify(value);
  const result = context.evalCode(`(${json})`);
  if (result.error) {
    result.error.dispose();
    return;
  }
  context.setProp(context.global, globalName, result.value);
  result.value.dispose();
}

export function formatError(errorValue: unknown): string {
  if (typeof errorValue === 'string') return errorValue;
  if (errorValue && typeof errorValue === 'object') {
    const err = errorValue as Record<string, unknown>;
    const name = typeof err['name'] === 'string' ? err['name'] : 'Error';
    const message = typeof err['message'] === 'string' ? err['message'] : 'Unknown error';
    const stack = typeof err['stack'] === 'string' ? err['stack'] : undefined;
    return stack ? `${name}: ${message}\n${stack}` : `${name}: ${message}`;
  }
  return String(errorValue);
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value);
  } catch {
    if (typeof value === 'object') return '[object]';
    if (typeof value === 'symbol') return value.toString();
    // value is primitive (number/bigint/boolean) — convert via Number/Boolean coercion.
    return Object.prototype.toString.call(value);
  }
}
