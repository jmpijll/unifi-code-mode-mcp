# AGENTS.md — Guidance for AI agents working on this repo

This repository implements a code-mode MCP server for the UniFi
Network Integration API and the Site Manager (cloud) API. **Read this whole
file before making changes** — it captures the architectural invariants and
the lessons we paid for during the initial build.

> If you are an MCP **client** trying to *use* the running server (rather
> than develop it), read `docs/usage.md` and (when present) `SKILL.md`
> instead. This file is for contributors editing the server itself.

---

## 1. 60-second orientation

```text
unify-mcp/
├── src/
│   ├── spec/        OpenAPI loading, $ref resolution, search index
│   ├── client/      Per-tenant HTTP clients (local, cloud, cloud-network proxy)
│   ├── tenant/      TenantContext type + builders (env / HTTP headers)
│   ├── sandbox/     QuickJS executors (search + execute) and resource limits
│   ├── server/      MCP tool registration + stdio / Streamable HTTP transports
│   ├── config.ts    Zod-validated env loading
│   └── index.ts     Node entrypoint
├── cf-worker/       Cloudflare Worker entry (DynamicWorkerExecutor)
├── scripts/         Operational scripts (spec refresh, live test, discovery)
├── docs/            Architecture, deployment, multi-tenant, security, usage
└── src/__tests__/   Vitest suites
```

The whole product is just **two MCP tools** — `search` and `execute` —
backed by a sandboxed JS surface that fans out to two separate UniFi APIs.

---

## 2. Architecture invariants — do not break these

1. **Two MCP tools, always.** `search` and `execute`. Adding tools defeats
   the Code Mode pattern.
2. **Three sandbox surfaces, two real clients.**
   - `unifi.local.*` → local controller via the Network Integration API.
   - `unifi.cloud.*` → Site Manager API on `api.ui.com`.
   - `unifi.cloud.network(consoleId).*` → **same operations as
     `unifi.local`**, but routed through the cloud connector
     (`/v1/connector/consoles/{id}/proxy/network/integration`) using the
     **cloud** API key. No local creds needed.
3. **Credentials never enter the sandbox.** They live on the host and are
   looked up from `TenantContext` when the host-side `request()` runs. The
   sandbox sees an opaque `client` handle, never an `apiKey`.
4. **Per-request multi-tenant scoping.** In the HTTP transport,
   `TenantContext` is rebuilt from `X-Unifi-*` headers on every request and
   is short-lived (`AsyncLocalStorage`). Single-user fallback uses env vars.
5. **Sandbox is QuickJS WASM (Node) or a Cloudflare Worker isolate
   (`cf-worker/`).** No `eval`, no `vm`, no `Function`.
6. **Sync-style is preferred in the sandbox.** Host calls are asyncified
   and *appear synchronous* to QuickJS code. Avoid chaining many `await`s
   in async IIFEs — the asyncify shim has corrupted the QuickJS GC list
   when a Promise rejection unwound through several frames in tests. See
   §6 below for the full story.

---

## 3. Daily dev loop

```bash
npm install                           # one-time
npm run typecheck                     # tsc --noEmit
npm test                              # vitest run (67 cases)
npm run lint                          # eslint
npm run format:check                  # prettier
npm run build                         # tsc → dist/
```

Before opening any PR, all five must be green. CI runs the same set on
Node 22.

For end-to-end smoke against a real controller (read-only):

```bash
export PATH="/opt/homebrew/Caskroom/1password-cli/2.34.0:$PATH"  # macOS
npm run live-test                     # uses op:// references, no creds in shell
npx tsx scripts/sandbox-cloud-proxy-smoke.ts   # exercises cloud-network proxy
npx tsx scripts/discover-network.ts            # full read-only sweep → out/
```

`discover-network.ts` is the canonical example of how the sandbox surface is
meant to be driven from outside the MCP framing — read it when you need a
template for a new operational script.

---

## 4. Where things live (when you're hunting)

| Concern | File |
|---|---|
| OpenAPI fetch + cache + version fallback | `src/spec/loader.ts` |
| Curated Site Manager fallback schema | `src/spec/cloud-fallback.json` |
| Search index shape (the `search` tool's payload) | `src/spec/index-builder.ts` |
| Tenant resolution from env / headers | `src/tenant/context.ts` |
| HTTP client (TLS, retry, error normalisation) | `src/client/http.ts` |
| Cloud-network proxy client factory | `src/client/cloud.ts` (`createCloudNetworkProxyClient`) |
| Sandbox resource limits | `src/sandbox/limits.ts` |
| `search` tool sandbox (sync) | `src/sandbox/search-executor.ts` |
| `execute` tool sandbox (async) | `src/sandbox/execute-executor.ts` |
| Sandbox prelude (the JS injected on every run) | `src/sandbox/dispatch.ts` |
| Tool registration & response framing | `src/server/server.ts` |
| stdio + Streamable HTTP transports | `src/server/transport.ts` |
| Per-request header storage | `src/server/request-context.ts` |
| Cloudflare Workers entrypoint | `cf-worker/index.ts` |
| Live read-only smoke against a tenant | `scripts/live-test.ts` |
| Full read-only network discovery | `scripts/discover-network.ts` |

---

## 5. Multi-tenant header contract

| Header | Purpose |
|---|---|
| `X-Unifi-Local-Api-Key` | API key minted in UniFi Network → Integrations |
| `X-Unifi-Local-Base-Url` | `https://<controller>` (no path) |
| `X-Unifi-Local-Ca-Cert` | PEM-encoded CA bundle for TLS verification |
| `X-Unifi-Local-Ca-Cert-Path` | absolute path to a CA bundle file (alternative) |
| `X-Unifi-Local-Insecure` | `true` to skip TLS verification (logs a warning) |
| `X-Unifi-Cloud-Api-Key` | API key for `https://api.ui.com` (Site Manager) |
| `X-Unifi-Cloud-Base-Url` | optional override for the Site Manager origin |

Equivalent env vars exist for stdio mode (`UNIFI_LOCAL_API_KEY`,
`UNIFI_LOCAL_BASE_URL`, `UNIFI_LOCAL_CA_CERT_PATH`, `UNIFI_LOCAL_INSECURE`,
`UNIFI_CLOUD_API_KEY`, `UNIFI_CLOUD_BASE_URL`).

Missing credentials produce a `MissingCredentialsError` **inside the
sandbox**, surfaced to the model with an actionable message — never a 5xx.

`unifi.cloud.network(consoleId).*` only requires the **cloud** key.

---

## 6. Gotchas we already paid for — read before re-debugging

### 6.1 OpenAPI version mismatch is normal

Ubiquiti's CDN at `apidoc-cdn.ui.com/network/v<ver>/integration.json` only
hosts a handful of tagged versions (currently `v10.1.84`). Controllers run
ahead of that — e.g. 10.3.58 in production. The loader (`src/spec/loader.ts`)
silently falls back to the closest known version listed in
`KNOWN_NETWORK_SPEC_VERSIONS` and caches under both keys. **Do not "fix"
this by hardcoding a version**; instead, append to the known-versions list
when a new spec is published.

### 6.2 `MAX_RESULT_SIZE` only applies at the MCP boundary

`src/server/server.ts` truncates the JSON-stringified result before sending
it back as an MCP tool response. The executor itself returns the full
in-memory object. Operational scripts (like `discover-network.ts`) that
call the executor directly receive the full payload — that's intentional.
If you wire a new transport, you must re-apply the boundary truncation.

### 6.3 Async re-entrancy in the QuickJS sandbox

Symptom: `Lifetime not alive`, or
`Aborted(Assertion failed: list_empty(&rt->gc_obj_list))` from
`quickjs-emscripten` when a sandbox script chains several `await`s in a
single async IIFE, especially across a Promise rejection.

Mitigations already in place in `src/sandbox/execute-executor.ts`:

1. After `evalCodeAsync` returns, drain microtasks with a loop of
   `runtime.executePendingJobs(64)` + `await new Promise(setImmediate)`
   until idle. Don't shortcut this.
2. Wrap `context.dispose()` and `runtime.dispose()` in `try/catch` in the
   `finally` block to swallow WASM aborts on the error path so they don't
   crash the host.
3. **Prefer sync-style in the sandbox.** Most code that *looks* async
   should be written as plain function calls — host functions are
   asyncified and appear synchronous. The async IIFE pattern is only
   needed when you genuinely need `Promise.all` parallelism.

If you are tempted to "simplify" any of the above, run the full Vitest
suite first — the sandbox tests will tell you within seconds.

### 6.4 The cloud-network proxy is *not* a third spec

`unifi.cloud.network(consoleId)` reuses the **local** Network Integration
spec. Operations dispatch through the cloud client, with a path prefix of
`/v1/connector/consoles/{id}/proxy/network/integration`. Don't add a new
spec for it; do extend `buildCloudNetworkProxyPrelude` if you need new
behaviour.

### 6.5 Per-AP / port detail vs. site-level config

The v1 Integration API exposes pages, devices, networks, WANs, WiFi
broadcasts, ZBF zones/policies, ACLs, DNS policies, RADIUS profiles and
VPN servers — but **not** legacy firewall rules, DHCP options, port
profiles, PoE settings, mDNS reflectors or rogue-AP scans. If you need
those, the v1 API will reject you. Don't try to monkey-patch around it.

### 6.6 Test-only ESLint disables are intentional

A few `eslint-disable-*` comments in `src/__tests__/` (e.g.
`no-implied-eval`, `no-non-null-assertion`) exist because we intentionally
construct strings of sandbox JS or assert through known-non-null
fixtures. Do not strip them.

---

## 7. Code style

- TypeScript, strict, ESM. Node 20+ (CI: 22).
- Match the patterns in
  [`fortimanager-code-mode-mcp`](https://github.com/jmpijll/fortimanager-code-mode-mcp)
  where applicable.
- **Avoid narrative comments.** Comments explain the *why* of non-obvious
  decisions only — never restate what the code does.
- Prefer plain functions over classes when there's no state.
- Errors in the host that need to reach the sandbox go through
  `formatToolError` / `formatCloudNetworkError` — preserve the
  `[unifi.<surface>.<error-class>]` prefix, the model relies on it.

---

## 8. Tests live next to the system

- `src/__tests__/tenant.test.ts` — env / header builders + missing-cred paths
- `src/__tests__/spec-loader.test.ts` — CDN fallback + cache behaviour
- `src/__tests__/spec-index.test.ts` — search index shape + tag normalisation
- `src/__tests__/http-client.test.ts` — local, cloud, cloud-network proxy
- `src/__tests__/dispatch.test.ts` — sandbox prelude generation
- `src/__tests__/sandbox.test.ts` — `ExecuteExecutor` Proxy dispatch end-to-end

When fixing a bug, write a Vitest case before the fix.

---

## 9. Commit and PR conventions

- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`).
- One logical change per commit. Keep `src/spec/cache/*` out of commits.
- Don't commit the `out/` folder (gitignored — it holds live network
  snapshots and generated docs that contain MAC/IP material).
- Do not bump deps in unrelated commits.

---

## 10. Roadmap (intentional, not yet implemented)

- `unifi.cloud.protect(consoleId).*` — same connector pattern
  (`/v1/connector/consoles/{id}/proxy/protect/integration`) for the Protect
  API. Schema to be added once Ubiquiti publishes one.
- Per-tenant rate limiting (today the limiter is per-IP only).
- An MCP-side `SKILL.md` describing how a client agent should drive the
  two tools (search → execute, error-recovery patterns, budgets).
- `cf-worker` parity tests so the Workers entry doesn't drift from the
  Node implementation.

If you pick one up, write a short design note in `docs/` first.
