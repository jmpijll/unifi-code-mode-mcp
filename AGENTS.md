# AGENTS.md — Guidance for AI agents working on this repo

This repository implements a code-mode MCP server for the UniFi Network Integration API and the Site Manager (cloud) API. Read this before making changes.

## Architecture invariants

- **Two MCP tools, always.** `search` and `execute`. Do not add more tools — that defeats the Code Mode pattern.
- **Two namespaces in the sandbox.** `unifi.local.*` (per-controller Integration v1) and `unifi.cloud.*` (Site Manager). They have different credentials and different specs.
- **Credentials never enter the sandbox.** They live on the host and are looked up from `TenantContext` when the host-side `request()` runs.
- **Per-request multi-tenant scoping.** In HTTP transport, `TenantContext` is built from `X-Unifi-*` headers on every request and is short-lived. Single-user fallback uses env vars.
- **Sandbox is QuickJS WASM (Node) or Cloudflare Worker isolate (cf-worker entry).** No `eval`, no `vm`, no `Function`.

## Code style

- TypeScript, strict, ESM. Node 20+.
- Match the patterns in [`fortimanager-code-mode-mcp`](https://github.com/jmpijll/fortimanager-code-mode-mcp) where applicable.
- Avoid narrative comments. Comments explain the *why* of non-obvious decisions only.

## Where things live

- `src/spec/` — OpenAPI loading, $ref resolution, search index
- `src/client/` — Per-tenant HTTP clients (local + cloud), TLS handling
- `src/tenant/` — TenantContext type and builders
- `src/sandbox/` — QuickJS executors (search + execute) and limits
- `src/server/` — MCP tool registration, transports
- `cf-worker/` — Cloudflare Workers entry (uses `@cloudflare/codemode/mcp`)
- `scripts/` — Operational scripts (spec refresh, live test)

## Testing

- Unit tests with Vitest: tenant resolver, spec loader cache, search index, sandbox limits, Proxy dispatch with mocked clients
- Live tests are gated behind env vars and pull credentials from 1Password (`op` CLI) on demand; they are read-only

## Multi-tenant header contract

| Header | Purpose |
| --- | --- |
| `X-Unifi-Local-Api-Key` | API key minted in UniFi Network → Integrations |
| `X-Unifi-Local-Base-Url` | `https://<controller>` (no path) |
| `X-Unifi-Local-Ca-Cert` | PEM-encoded CA bundle for TLS verification |
| `X-Unifi-Local-Insecure` | `true` to skip TLS verification (warns) |
| `X-Unifi-Cloud-Api-Key` | API key for `https://api.ui.com` |

Missing credentials produce a `MissingCredentialsError` *inside the sandbox*, with an actionable message — the LLM sees it and can react.
