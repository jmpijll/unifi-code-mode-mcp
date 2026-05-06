/**
 * Sandbox & tool limits — shared constants and types.
 */

/** Maximum size of any tool input code (characters). */
export const MAX_CODE_SIZE = 100_000;

/** Maximum size of a serialized tool result (characters). */
export const MAX_RESULT_SIZE = 100_000;

/** Maximum total log size in bytes before truncation. */
export const MAX_LOG_SIZE_BYTES = 1_048_576;

/** Maximum number of log entries. */
export const MAX_LOG_ENTRIES = 1_000;

/** Default maximum number of API calls per execute() invocation. */
export const DEFAULT_MAX_CALLS_PER_EXECUTE = 50;

/** Default sandbox memory limit (bytes). */
export const DEFAULT_MAX_MEMORY_BYTES = 64 * 1024 * 1024;

/** Default sandbox CPU/time deadline (ms). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Search executor uses tighter limits — pure CPU work, smaller spec. */
export const SEARCH_TIMEOUT_MS = 10_000;
export const SEARCH_MAX_MEMORY_BYTES = 32 * 1024 * 1024;

export interface SandboxLimits {
  timeoutMs: number;
  maxMemoryBytes: number;
  maxCallsPerExecute: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxMemoryBytes: DEFAULT_MAX_MEMORY_BYTES,
  maxCallsPerExecute: DEFAULT_MAX_CALLS_PER_EXECUTE,
};
