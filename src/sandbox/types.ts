export interface ExecuteResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  logs: LogEntry[];
  warnings: string[];
  durationMs: number;
  /** Number of API calls made during this execute() invocation. */
  callsMade?: number;
}

export interface LogEntry {
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
}
