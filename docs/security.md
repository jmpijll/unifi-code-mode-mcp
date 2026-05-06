# Security model

## Trust boundaries

```
+-------------------+       +-----------------+        +-----------------+
| LLM-generated JS  |  -->  | QuickJS WASM    |  -->   | Host (Node)     |
| (untrusted)       |       | sandbox         |  RPC   | (trusted)       |
+-------------------+       +-----------------+        +-----------------+
                                                              |
                                                              v
                                                    +-----------------------+
                                                    | UniFi APIs (HTTPS,    |
                                                    | per-tenant TLS,       |
                                                    | X-API-Key auth)       |
                                                    +-----------------------+
```

The QuickJS WASM sandbox is the boundary between LLM-generated JavaScript and the host. The host is trusted; the sandbox is not.

## What the sandbox can do

- Read the OpenAPI operation index (`spec.local`, `spec.cloud`)
- Call host-defined functions: `unifi.local.<tag>.<op>(args)`, `unifi.local.callOperation(...)`, `unifi.local.request(...)` (and `unifi.cloud.*`)
- Use ECMAScript primitives, JSON, basic timers (no DOM/network/fs)

## What the sandbox cannot do

- Read process env or files
- Make outbound network calls (no `fetch`, no `XMLHttpRequest`, no `node:http`)
- Spawn processes, load native modules, or escape the WASM heap
- See API keys, CA certificates, or any host-side secrets — credentials live in `TenantContext` on the host

## Credential handling

- Single-user mode: env vars validated at startup; the process holds them in memory.
- Multi-user mode: each request brings its own headers; the resulting `TenantContext` is short-lived (request-scoped) and is garbage-collected when the request finishes. There is no inter-tenant cache of credentials.
- Credentials are passed to `HttpClient` constructors and used for outbound HTTPS only. They never appear in MCP tool output (only call results do).

## Resource limits

Each `execute` call is bounded by:

- **Time** — 30 s deadline via QuickJS interrupt handler
- **Memory** — 64 MB per-runtime (`runtime.setMemoryLimit`)
- **Stack** — 512 KB
- **API calls** — 50 calls per execute (`MAX_CALLS_PER_EXECUTE`, configurable)
- **Code input** — 100 000 chars
- **Result size** — 100 000 chars (truncated with notice)
- **Logs** — 1 MB / 1000 entries

## Network surface

- Outbound: HTTPS to the configured controller(s) and `api.ui.com`. No proxying through the sandbox.
- Inbound (HTTP transport): `/mcp`, `/health`. Origin allowlist is configurable; rate limit is 60 req/min/IP by default.

## TLS verification

Strict by default. Operators can opt in to:

1. **Custom CA**: `X-Unifi-Local-Ca-Cert` (PEM bundle) — TLS verification still runs, just against your CA.
2. **Insecure**: `X-Unifi-Local-Insecure: true` — TLS verification skipped. Loud warning emitted in tool output. Not allowed on the Cloudflare Workers deployment.

## Reporting vulnerabilities

See [SECURITY.md](../SECURITY.md).
