# UniFi Code-Mode MCP

[![CI](https://github.com/jmpijll/unifi-code-mode-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jmpijll/unifi-code-mode-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Status: beta](https://img.shields.io/badge/status-beta-orange.svg)](#project-status)
[![Version: v0.2.0-beta.1](https://img.shields.io/badge/version-v0.2.0--beta.1-blue.svg)](CHANGELOG.md)

> ## Project status
>
> **This is a public beta. Install from source. Not on npm yet.**
>
> Five sandbox surfaces are wired and tested against an in-process mock
> controller (98/98 unit + integration tests green). Two surfaces are
> additionally verified live against a real UDM-Pro:
> `unifi.cloud.network()` and `unifi.cloud.protect(consoleId)`.
> End-to-end LLM-mediated invocation is verified through two clients:
> Cursor's `cursor-agent` (Claude Sonnet 4.6) and `opencode` (DeepSeek
> v4 Flash). Direct-local Protect, Protect mutations, binary surfaces,
> and every other agent platform (Claude Code, Claude Desktop, VS Code +
> Copilot, Codex CLI, Continue, Cline, MCP Inspector, …) are wired but
> **NOT verified by us**. We need testers — please file
> [verification reports](.github/ISSUE_TEMPLATE/verification_report.yml)
> and [bug reports](.github/ISSUE_TEMPLATE/bug_report.yml) with whatever
> you find. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the rules and
> [`examples/unifi-expert-agent/`](examples/unifi-expert-agent/) for a
> ready-made persona + cross-platform install snippets.

A Model Context Protocol (MCP) server for the **Ubiquiti UniFi Network Integration API** and the **UniFi Site Manager (cloud) API**, built on the **Cloudflare "Code Mode" pattern**: instead of one MCP tool per endpoint, the server exposes **two tools** — `search` and `execute` — and the LLM writes JavaScript that runs in a QuickJS WASM sandbox. This keeps the LLM context small (~constant) regardless of how big the underlying API is.

## Why Code Mode?

The UniFi Network Integration API has **70+ endpoints**. Exposing each as a separate MCP tool floods the LLM context with thousands of tokens before it has even read the user's question. Code Mode collapses the entire API surface into two tools and lets the model search the OpenAPI spec, then execute calls programmatically — including loops, batching, and post-processing. See Cloudflare's [Code Mode for MCP](https://blog.cloudflare.com/code-mode-mcp/) blog post and the official `@cloudflare/codemode` package.

## Highlights

- **Cloudflare Code Mode compatible** — two-tool design (`search` + `execute`), Cloudflare-style sandbox semantics
- **Five API surfaces in one server** —
  - `unifi.local.*` — direct Network Integration API on a controller you can reach over the LAN
  - `unifi.cloud.*` — Site Manager native endpoints (Hosts, Sites, Devices, ISP Metrics, SD-WAN)
  - `unifi.cloud.network(consoleId).*` — full Network Integration API, **proxied through `api.ui.com`** so a single Site Manager API key drives any console without exposing the controller publicly
  - `unifi.local.protect.*` — UniFi Protect Integration API (cameras + PTZ, NVRs, sensors, lights, chimes, viewers, live-views) — official spec auto-loaded from `apidoc-cdn.ui.com/protect/v<version>/integration.json`; bundled curated fallback ships ~18 JSON-over-HTTP ops for offline use
  - `unifi.cloud.protect(consoleId).*` — Protect Integration API tunneled through the Site Manager connector at `/v1/connector/consoles/{id}/proxy/protect/integration`. URL pattern is officially documented by Ubiquiti (`developer.ui.com/protect/v7.0.107/...`, "Remote" base-URL selector)
- **Single-user (env) and multi-user (per-request HTTP headers)** — the same server runs as a private homelab tool or a hosted multi-tenant gateway
- **QuickJS WASM sandbox** — memory, CPU, time, and call-budget limits; credentials never enter the sandbox
- **Dynamic OpenAPI loading** — the controller's app version is auto-discovered (`GET /v1/info`); the spec is fetched from `apidoc-cdn.ui.com` and cached on disk
- **Hybrid deployment** — runs on Node.js (stdio + Streamable HTTP) or Cloudflare Workers (using `@cloudflare/codemode` + Worker Loader)
- **TLS done right** — strict by default, per-tenant custom CA cert, optional opt-in to insecure (with loud warnings)

## For agents driving this server

If you're an LLM agent (or a human configuring one) connecting to a running instance, read [`SKILL.md`](SKILL.md) for the operating manual — the `search → execute` loop, the five sandbox surfaces, the error taxonomy, and ready-to-paste recipes. For Cursor IDE / Cursor CLI specifically, see [`docs/cursor-skill.md`](docs/cursor-skill.md); for opencode see [`docs/opencode-skill.md`](docs/opencode-skill.md).

**For testers**, [`examples/unifi-expert-agent/`](examples/unifi-expert-agent/) ships a ready-made "UniFi network engineering expert" persona, a focused operating manual, [cross-platform install snippets](examples/unifi-expert-agent/install.md) (Cursor, opencode, Claude Code, Claude Desktop, VS Code + Copilot, Codex CLI, Continue, Cline, MCP Inspector, …), and [sample prompts](examples/unifi-expert-agent/SAMPLE_PROMPTS.md) you can run against the persona. We need verification reports — see the [project status](#project-status) callout above.

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
| Unit tests | Vitest, 98 specs across spec loader, dispatcher, sandbox, server, Protect surfaces | ✅ all green |
| Integration tests (in-process MCP transport) | `InMemoryTransport` against `createMcpServer` + a mock UniFi controller (Network + Protect) | ✅ green |
| Integration tests (real Streamable HTTP transport) | `StreamableHTTPClientTransport` over a real HTTP listener | ✅ green |
| Protect surface against a mock controller | `unifi.local.protect.*` end-to-end via the integration harness with the bundled fallback spec | ✅ green (see Scenario D in `src/__tests__/integration/scenarios.test.ts`) |
| Live read-only sweep on a real Network | `scripts/discover-network.ts` against a real UDM-Pro via `unifi.cloud.network()` | ✅ produced 28 KB JSON snapshot, plus HLD/LLD/best-practices Markdown |
| **Live read-only sweep of cloud-Protect** | `scripts/discover-protect.ts` against a real UDM-Pro running Protect 7.0.107 via `unifi.cloud.protect(consoleId)` | ✅ official OpenAPI loaded from `apidoc-cdn.ui.com/protect/v7.0.107/integration.json` (35 ops); `getProtectMetaInfo` returned `applicationVersion: "7.0.107"`; `listCameras` returned 4 cameras with name/state. Sanitized transcript at `out/verification/cloud-protect-live-smoke.txt` |
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
- **Direct local Protect path** (`https://<controller>/proxy/protect/integration/*` via `unifi.local.protect.*`). The cloud path was just verified live — the local path is the same `HttpClient` shape with a different prefix, but no LAN-side smoke run has been captured yet.
- **Mutation operations on Protect.** The 2026-05-07 live verification only exercised read-only ops (`GET /v1/meta/info`, `GET /v1/cameras`). PTZ commands (`POST /v1/cameras/{id}/ptz/goto/{slot}`, etc.), `disableCameraMicPermanently`, and the alarm-manager webhook trigger are wired but not yet driven against real hardware.
- **Binary / streaming Protect surfaces.** Snapshots (`/snapshot`), RTSPS streams (`/rtsps-stream`), talk-back sessions (`/talkback-session`), and the WebSocket `subscribe/*` endpoints are all on the Protect spec but the JSON-only `HttpClient` doesn't speak them yet.

Two client-specific subtleties worth calling out:

- **cursor-agent v2026.05.05** does *not* inject custom MCPs as model-callable tools in either `--print` or interactive mode, even when `cursor-agent mcp list` reports them as `ready`. Sufficiently capable models (Sonnet 4.6, Codex 5.3) work around this by reading `.cursor/mcp.json` themselves and driving the server over stdio; the result is correct but indirect. See `docs/cursor-skill.md` §8.
- **opencode v1.14.30** *does* auto-inject MCP tools cleanly (under the `<server>_<tool>` name scheme). Two gotchas: (1) the bundled `plugin.copilot` provider has a Zod schema mismatch in 1.14.30 that hangs bootstrap when not using `--pure`; (2) opencode persists per-model variant settings (e.g. `variant: max`) across runs, so a previously-set "max reasoning" can silently turn an 8-second call into an 8-minute one. See `docs/opencode-skill.md`.

### Roadmap

- **Verify the direct-local Protect path** against a Protect-enabled console on the LAN (`unifi.local.protect.*`). Cloud-Protect was verified live on 2026-05-07; local is the same shape but unproven on real hardware
- **Verify Protect mutation paths** (PTZ commands, disable-mic, alarm-manager webhook trigger) — the 2026-05-07 live run was read-only
- **Tag/operationId normalization for the official Protect spec** — Ubiquiti's CDN spec ships with `operationId: null` and verbose tag names like `"Camera PTZ control & management"`. The synthesizer produces friendly names like `cameraPtzPatrolStart`, but the tag namespace becomes `cameraPtzControlManagement`. Compact-tag heuristics are a follow-up
- **Broaden the bundled fallback** beyond the current ~18 JSON-over-HTTP ops, or expose binary surfaces (snapshots, RTSPS metadata, files) once the sandbox supports them
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
