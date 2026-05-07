# UniFi Code-Mode MCP

[![CI](https://github.com/jmpijll/unifi-code-mode-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jmpijll/unifi-code-mode-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Model Context Protocol (MCP) server for the **Ubiquiti UniFi Network Integration API** and the **UniFi Site Manager (cloud) API**, built on the **Cloudflare "Code Mode" pattern**: instead of one MCP tool per endpoint, the server exposes **two tools** — `search` and `execute` — and the LLM writes JavaScript that runs in a QuickJS WASM sandbox. This keeps the LLM context small (~constant) regardless of how big the underlying API is.

## Why Code Mode?

The UniFi Network Integration API has **70+ endpoints**. Exposing each as a separate MCP tool floods the LLM context with thousands of tokens before it has even read the user's question. Code Mode collapses the entire API surface into two tools and lets the model search the OpenAPI spec, then execute calls programmatically — including loops, batching, and post-processing. See Cloudflare's [Code Mode for MCP](https://blog.cloudflare.com/code-mode-mcp/) blog post and the official `@cloudflare/codemode` package.

## Highlights

- **Cloudflare Code Mode compatible** — two-tool design (`search` + `execute`), Cloudflare-style sandbox semantics
- **Five API surfaces in one server** —
  - `unifi.local.*` — direct Network Integration API on a controller you can reach over the LAN
  - `unifi.cloud.*` — Site Manager native endpoints (Hosts, Sites, Devices, ISP Metrics, SD-WAN)
  - `unifi.cloud.network(consoleId).*` — full Network Integration API, **proxied through `api.ui.com`** so a single Site Manager API key drives any console without exposing the controller publicly
  - `unifi.local.protect.*` — UniFi Protect Integration API (cameras, NVRs, sensors, lights, alarm hubs, sirens, viewers, live-views, users) — **bundled spec is curated to ~25 ops; verified against the mock controller, not a real Protect deployment**
  - `unifi.cloud.protect(consoleId).*` — Protect Integration API tunneled through the Site Manager connector. **Unverified** against a real Protect-enabled console; structurally analogous to `cloud.network`
- **Single-user (env) and multi-user (per-request HTTP headers)** — the same server runs as a private homelab tool or a hosted multi-tenant gateway
- **QuickJS WASM sandbox** — memory, CPU, time, and call-budget limits; credentials never enter the sandbox
- **Dynamic OpenAPI loading** — the controller's app version is auto-discovered (`GET /v1/info`); the spec is fetched from `apidoc-cdn.ui.com` and cached on disk
- **Hybrid deployment** — runs on Node.js (stdio + Streamable HTTP) or Cloudflare Workers (using `@cloudflare/codemode` + Worker Loader)
- **TLS done right** — strict by default, per-tenant custom CA cert, optional opt-in to insecure (with loud warnings)

## For agents driving this server

If you're an LLM agent (or a human configuring one) connecting to a running instance, read [`SKILL.md`](SKILL.md) for the operating manual — the `search → execute` loop, the three sandbox surfaces, the error taxonomy, and ready-to-paste recipes. For Cursor IDE / Cursor CLI specifically, see [`docs/cursor-skill.md`](docs/cursor-skill.md).

## Quickstart (single-user)

```bash
git clone https://github.com/jmpijll/unifi-code-mode-mcp.git
cd unifi-code-mode-mcp
npm install
cp .env.example .env
# Edit .env: set UNIFI_LOCAL_BASE_URL and UNIFI_LOCAL_API_KEY
npm run build
npm start                # MCP_TRANSPORT=stdio
```

Then point your MCP client at `node /path/to/unifi-code-mode-mcp/dist/index.js`.

## Quickstart (multi-user / HTTP)

```bash
MCP_TRANSPORT=http npm start
```

Each MCP client request must include credentials as headers:

```http
POST /mcp HTTP/1.1
X-Unifi-Local-Api-Key: <controller key>
X-Unifi-Local-Base-Url: https://192.168.1.1
X-Unifi-Local-Insecure: true
X-Unifi-Cloud-Api-Key: <site manager key>
```

See [docs/multi-tenant.md](docs/multi-tenant.md).

## Example session

The model first searches the spec:

```js
// search tool
spec.local.operations
  .filter((op) => op.tags.includes('Sites') && op.method === 'GET')
  .map((op) => ({ id: op.operationId, path: op.path }));
```

Then executes calls:

```js
// execute tool — direct local
var sites = unifi.local.sites.listSites({ limit: 200 });
sites.data.map(function (s) { return { id: s.id, name: s.name }; });
```

Or, if you only have a Site Manager API key and want remote access without exposing the controller to the internet:

```js
// execute tool — Network API proxied through api.ui.com
var net = unifi.cloud.network('CONSOLE-ID-FROM-UNIFI-UI-COM');
var sites = net.sites.listSites({ limit: 200 });
sites.data.length;
```

If the controller is also running Protect, the same code shape works against the Protect surface:

```js
// execute tool — local Protect (camera count, NVR list)
var meta = unifi.local.protect.callOperation('getProtectMetaInfo', {});
var cameras = unifi.local.protect.cameras.listCameras({});
({ protectVersion: meta.applicationVersion, cameras: cameras.data.length });
```

## Status

Pre-1.0. The Network Integration API spec is loaded dynamically from Ubiquiti's CDN; the server should adapt to controller version changes without code edits.

### Verification status

What we have **directly verified** so far:

| Layer | How | Result |
|---|---|---|
| Unit tests | Vitest, 94 specs across spec loader, dispatcher, sandbox, server, Protect surfaces | ✅ all green |
| Integration tests (in-process MCP transport) | `InMemoryTransport` against `createMcpServer` + a mock UniFi controller (Network + Protect) | ✅ green |
| Integration tests (real Streamable HTTP transport) | `StreamableHTTPClientTransport` over a real HTTP listener | ✅ green |
| Protect surface against a mock controller | `unifi.local.protect.*` end-to-end via the integration harness with the bundled fallback spec | ✅ green (see Scenario D in `src/__tests__/integration/scenarios.test.ts`) |
| Live read-only sweep on a real Network | `scripts/discover-network.ts` against a real UDM-Pro-Max via `unifi.cloud.network()` | ✅ produced 28 KB JSON snapshot, plus HLD/LLD/best-practices Markdown |
| `cursor-agent mcp list-tools unifi` (protocol smoke) | local CLI, no LLM | ✅ both `search` and `execute` exposed |
| End-to-end LLM-mediated invocation via cursor-agent | Claude Sonnet 4.6 driving the server through `cursor-agent` in interactive PTY mode | ✅ JSON-RPC roundtrip, correct value returned (see `out/verification/cursor-agent-sonnet-mcp-call.txt`) |
| End-to-end LLM-mediated invocation via opencode | DeepSeek v4 Flash via `opencode-go` provider, project-scoped `opencode.json`, opencode v1.14.30 | ✅ MCP tools auto-injected as `unifi_search` / `unifi_execute`, model called `unifi_search` with the right code, server returned `"9"`, model echoed it (see `out/verification/opencode-deepseek-mcp-call.txt`) |

What is **not yet verified** (and where help is welcome):

- Cursor IDE chat panel after a fresh window restart (project-scoped `.cursor/mcp.json` registration).
- Other agent / IDE clients: Claude Desktop, Continue, Codeium, Aider, Zed, Cline, etc.
- The official MCP Inspector UI.
- Hosted/multi-tenant deployment of the Streamable HTTP transport behind a reverse proxy.
- Long-running soak / stability under sustained load.
- Real UniFi networks other than the one author's homelab — we cannot generalise resilience claims from a single network.
- More than one model on each verified client (only one model per client has been driven end-to-end so far — Sonnet 4.6 on cursor-agent, DeepSeek v4 Flash on opencode).
- **Protect against a real, Protect-enabled UniFi OS device.** The bundled curated fallback spec was hand-written from publicly observable controller behaviour; we have not yet run it against a live `/proxy/protect/integration/*`.
- **Protect via the cloud connector** (`unifi.cloud.protect(consoleId).*`). Ubiquiti has not publicly documented that the Site Manager connector at `api.ui.com` proxies Protect — we expose it on the assumption it follows the Network connector's pattern. If the connector turns out to be Network-only, calls will fail with a structured `[unifi.cloud.protect.http]` error.

Two client-specific subtleties worth calling out:

- **cursor-agent v2026.05.05** does *not* inject custom MCPs as model-callable tools in either `--print` or interactive mode, even when `cursor-agent mcp list` reports them as `ready`. Sufficiently capable models (Sonnet 4.6, Codex 5.3) work around this by reading `.cursor/mcp.json` themselves and driving the server over stdio; the result is correct but indirect. See `docs/cursor-skill.md` §8.
- **opencode v1.14.30** *does* auto-inject MCP tools cleanly (under the `<server>_<tool>` name scheme). Two gotchas: (1) the bundled `plugin.copilot` provider has a Zod schema mismatch in 1.14.30 that hangs bootstrap when not using `--pure`; (2) opencode persists per-model variant settings (e.g. `variant: max`) across runs, so a previously-set "max reasoning" can silently turn an 8-second call into an 8-minute one. See `docs/opencode-skill.md`.

### Roadmap

- **Verify Protect against a real Protect-enabled console** — covers both `unifi.local.protect.*` and the unverified `unifi.cloud.protect(consoleId).*` connector path; until then, both surfaces remain "wired but unproven against live hardware"
- **Broaden the bundled Protect spec** beyond ~25 ops, or wire `UNIFI_PROTECT_SPEC_URL` to a maintained third-party spec
- **Protect WebSocket events** (`/v1/subscribe/events`, `/v1/subscribe/devices`) — currently out of scope
- **Per-tenant rate limiting** keyed on hashed credentials (currently per-IP)
- **Optional persistent spec cache** versioned by controller fingerprint
- **Broader client validation** — confirmed working configs for Claude Desktop, Continue, Cline, Aider, Zed, and the MCP Inspector

## Documentation

- [docs/architecture.md](docs/architecture.md) — How the server is built, request lifecycle, sandbox details
- [docs/multi-tenant.md](docs/multi-tenant.md) — Header protocol, deployment patterns, security model
- [docs/security.md](docs/security.md) — Threat model, credential handling, sandbox guarantees
- [docs/deployment.md](docs/deployment.md) — Docker, Cloudflare Workers, systemd
- [docs/usage.md](docs/usage.md) — Tool descriptions, common patterns, gotchas

## License

MIT — see [LICENSE](LICENSE).
