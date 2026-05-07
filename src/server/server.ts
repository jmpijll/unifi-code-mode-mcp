/**
 * MCP Server — UniFi Code Mode
 *
 * Registers two tools:
 *   - search   — query the OpenAPI specs via sandboxed JS (no network)
 *   - execute  — run UniFi API calls via sandboxed JS
 *
 * Each tool call resolves a TenantContext (env in single-user mode, headers
 * in multi-user mode), constructs a fresh ExecuteExecutor for that request,
 * runs the code, and returns formatted MCP tool content.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ExecuteExecutor } from '../sandbox/execute-executor.js';
import { SearchExecutor } from '../sandbox/search-executor.js';
import { MAX_CODE_SIZE, MAX_RESULT_SIZE, type SandboxLimits } from '../sandbox/limits.js';
import type { ExecuteResult } from '../sandbox/types.js';
import type { ProcessedSpec } from '../types/spec.js';
import type { TenantContext } from '../tenant/context.js';

// ─── Tool descriptions ──────────────────────────────────────────────

const SEARCH_TOOL_DESCRIPTION = `Search the UniFi OpenAPI specs (local Network Integration, cloud Site Manager, and Protect Integration) by writing JavaScript.

The sandbox is read-only — no network. Use this tool to **discover** what to call before invoking \`execute\`.

## Globals

- \`spec.local\`, \`spec.cloud\`, and \`spec.protect\` — each: \`{ title, version, sourceUrl, serverPrefix, operations[] }\`
  Operations are compact: \`{ operationId, method, path, tag, summary, parameters, hasRequestBody, deprecated }\`.
  Any namespace may be \`null\` if not configured (no local controller, no cloud key, or Protect not loaded).
- \`searchOperations(namespace, query, limit?)\` — text-ranked search; namespace is \`"local"\`, \`"cloud"\`, or \`"protect"\`.
- \`getOperation(namespace, operationId)\` — full operation including spec parameter detail. Pass either an \`operationId\` or \`"METHOD /path"\`.
- \`findOperationsByPath(namespace, substring)\` — list operations whose path contains the substring (case-insensitive).
- \`console.log()\` — captured into the tool output.

## Examples

\`\`\`javascript
// All operations on sites in the local API
spec.local.operations.filter(function (op) { return op.tag === 'sites'; });
\`\`\`

\`\`\`javascript
// Top 10 hits for "voucher"
searchOperations('local', 'voucher', 10);
\`\`\`

\`\`\`javascript
// Full detail on listSites
getOperation('local', 'listSites');
\`\`\`
`;

const EXECUTE_TOOL_DESCRIPTION = `Run UniFi API calls by writing JavaScript that uses the \`unifi\` namespace.

Surfaces:

- \`unifi.local\` — UniFi Network Integration API (per-controller). Available only if local credentials are configured (env or \`X-Unifi-Local-*\` headers).
- \`unifi.cloud\` — UniFi Site Manager API at \`https://api.ui.com\`. Available only if a cloud key is configured.
- \`unifi.cloud.network(consoleId)\` — Network Integration API tunneled through the Site Manager connector. Same shape as \`unifi.local\`.
- \`unifi.local.protect\` — UniFi Protect Integration API on a controller running Protect. Available only when both a Protect spec and local credentials are configured.
- \`unifi.cloud.protect(consoleId)\` — Protect Integration API tunneled through the Site Manager connector. **UNVERIFIED** against a real Protect deployment; documented for parity with cloud.network.

Each namespace exposes:

- \`unifi.<ns>.<tag>.<operationId>(args)\` — typed operation call, e.g. \`unifi.local.sites.listSites({ limit: 200 })\`. Args are auto-routed: keys matching path or query params from the spec are placed correctly; remaining keys form the JSON body if the operation accepts one. To override, pass \`{ pathParams: {...}, query: {...}, body: {...}, headers: {...} }\`.
- \`unifi.<ns>.callOperation(operationId, args)\` — flat lookup by id.
- \`unifi.<ns>.request({ method, path, pathParams?, query?, body?, headers? })\` — raw HTTP escape hatch. Use this for endpoints not in the loaded spec.
- \`unifi.<ns>.spec\` — \`{ title, version, sourceUrl, operationCount }\` for diagnostics.

Operations are async — use \`await\`. The final expression is the tool result.

## Examples

\`\`\`javascript
const sites = await unifi.local.sites.listSites({ limit: 200 });
return sites.data.map(function (s) { return { id: s.id, name: s.name }; });
\`\`\`

\`\`\`javascript
const counts = await Promise.all(
  (await unifi.local.sites.listSites({ limit: 200 })).data.map(async function (site) {
    const devices = await unifi.local.devices.listDevices({ siteId: site.id });
    return { site: site.name, devices: devices.data.length };
  }),
);
return counts;
\`\`\`

\`\`\`javascript
// Raw escape hatch — call an endpoint not present in the spec
const r = await unifi.local.request({ method: 'GET', path: '/v1/info' });
return r;
\`\`\`

## Limits

- Hard ceiling on API calls per execute; exceeded → error.
- Sandbox memory + time bounded.
- Credentials never enter the sandbox.
`;

// ─── Server factory ─────────────────────────────────────────────────

export interface CreateServerOptions {
  /** Local OpenAPI spec, or undefined if no local controller is configured. */
  localSpec?: ProcessedSpec;
  /** Cloud OpenAPI spec, or undefined if not loaded. */
  cloudSpec?: ProcessedSpec;
  /**
   * Protect OpenAPI spec, or undefined if not loaded. When present, the
   * unifi.local.protect.* and unifi.cloud.protect(consoleId).* surfaces
   * become available in the execute sandbox.
   */
  protectSpec?: ProcessedSpec;
  /** Function called per request to obtain the TenantContext. */
  tenantResolver: () => TenantContext | Promise<TenantContext>;
  /** Sandbox limits override. */
  limits?: Partial<SandboxLimits>;
  /** Logger for tool-call audit trail. */
  logger?: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
  };
  /** Server name + version for the MCP handshake. */
  name?: string;
  version?: string;
}

export function createMcpServer(options: CreateServerOptions): McpServer {
  const {
    localSpec,
    cloudSpec,
    protectSpec,
    tenantResolver,
    limits,
    logger,
    name = 'unifi-code-mode-mcp',
    version = '0.1.0',
  } = options;

  const server = new McpServer(
    { name, version },
    {
      capabilities: { tools: {} },
      instructions: [
        'UniFi Code Mode MCP Server.',
        localSpec
          ? `unifi.local: ${localSpec.title} v${localSpec.version} — ${String(localSpec.operations.length)} operations`
          : 'unifi.local: NOT CONFIGURED',
        cloudSpec
          ? `unifi.cloud: ${cloudSpec.title} v${cloudSpec.version} — ${String(cloudSpec.operations.length)} operations`
          : 'unifi.cloud: NOT CONFIGURED',
        protectSpec
          ? `unifi.*.protect: ${protectSpec.title} v${protectSpec.version} — ${String(protectSpec.operations.length)} operations`
          : 'unifi.*.protect: NOT CONFIGURED',
        '',
        'Workflow: use `search` to find the operationIds you need, then call them via `execute`.',
      ].join('\n'),
    },
  );

  // ── Search tool ─────────────────────────────────────────────────

  const searchExecutor = new SearchExecutor({
    local: localSpec,
    cloud: cloudSpec,
    protect: protectSpec,
  });

  server.registerTool(
    'search',
    {
      title: 'Search UniFi API spec',
      description: SEARCH_TOOL_DESCRIPTION,
      inputSchema: {
        code: z
          .string()
          .describe(
            'JavaScript code to execute against the OpenAPI specs. The final expression is returned.',
          ),
      },
    },
    async ({ code }) => {
      logger?.info(`[search] ${String(code.length)} chars`);
      if (code.length > MAX_CODE_SIZE) {
        return errorResult(`Code too large (${String(code.length)} chars, max ${String(MAX_CODE_SIZE)}).`);
      }
      try {
        const result = await searchExecutor.execute(code);
        logger?.info(`[search] ${result.ok ? 'ok' : 'error'} ${String(result.durationMs)}ms`);
        return formatToolResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── Execute tool ────────────────────────────────────────────────

  server.registerTool(
    'execute',
    {
      title: 'Execute UniFi API calls',
      description: EXECUTE_TOOL_DESCRIPTION,
      inputSchema: {
        code: z
          .string()
          .describe(
            'JavaScript code to execute against the live UniFi APIs. Use await — operations are async.',
          ),
      },
    },
    async ({ code }) => {
      logger?.info(`[execute] ${String(code.length)} chars`);
      if (code.length > MAX_CODE_SIZE) {
        return errorResult(`Code too large (${String(code.length)} chars, max ${String(MAX_CODE_SIZE)}).`);
      }

      let tenant: TenantContext;
      try {
        tenant = await tenantResolver();
      } catch (err) {
        return errorResult(
          `Failed to resolve tenant credentials: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const executor = new ExecuteExecutor({
        tenant,
        localSpec,
        cloudSpec,
        protectSpec,
        ...(limits ? { limits } : {}),
      });

      try {
        const result = await executor.execute(code);
        logger?.info(
          `[execute][${tenant.requestId}] ${result.ok ? 'ok' : 'error'} ${String(result.durationMs)}ms ${String(result.callsMade ?? 0)} calls`,
        );
        return formatToolResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}

// ─── Result formatting ──────────────────────────────────────────────

function errorResult(message: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

function formatToolResult(result: ExecuteResult): {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
} {
  const parts: Array<{ type: 'text'; text: string }> = [];

  if (result.warnings.length > 0) {
    parts.push({
      type: 'text',
      text: `--- Warnings ---\n${result.warnings.map((w) => `[warn] ${w}`).join('\n')}`,
    });
  }

  if (result.logs.length > 0) {
    parts.push({
      type: 'text',
      text: `--- Console Output ---\n${result.logs.map((l) => `[${l.level}] ${l.message}`).join('\n')}`,
    });
  }

  if (result.ok) {
    let dataStr =
      result.data !== undefined
        ? typeof result.data === 'string'
          ? result.data
          : JSON.stringify(result.data, null, 2)
        : '(no return value)';
    if (dataStr.length > MAX_RESULT_SIZE) {
      const total = dataStr.length;
      dataStr =
        dataStr.slice(0, MAX_RESULT_SIZE) +
        `\n\n--- TRUNCATED (${String(total)} chars total, showing first ${String(MAX_RESULT_SIZE)}) ---` +
        '\nTip: filter, paginate, or select specific fields to reduce size.';
    }
    parts.push({ type: 'text', text: dataStr });
  } else {
    parts.push({ type: 'text', text: `Error: ${result.error ?? 'Unknown error'}` });
  }

  const meta = [`--- Executed in ${String(result.durationMs)}ms`];
  if (typeof result.callsMade === 'number' && result.callsMade > 0) {
    meta.push(`${String(result.callsMade)} API calls`);
  }
  parts.push({ type: 'text', text: `${meta.join(' · ')} ---` });

  return {
    content: parts,
    isError: !result.ok,
  };
}
