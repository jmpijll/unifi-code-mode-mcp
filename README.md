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
> controller (105/105 unit + integration tests green). **Four of the
> five surfaces are also verified live against a real UDM-Pro:**
> `unifi.local.network` and `unifi.local.protect` (LAN-direct, Network
> 10.3.58 + Protect 7.0.107) and `unifi.cloud.network()` and
> `unifi.cloud.protect(consoleId)` (Site Manager connector path against
> the same hardware). End-to-end LLM-mediated invocation is verified
> through three independent paths: `cursor-agent` interactive PTY
> (Claude Sonnet 4.6, cloud surface), `opencode` (DeepSeek v4 Flash,
> cloud surface), and `opencode` (DeepSeek v4 Flash, **LAN-direct
> Network surface**). Protect mutation is verified through one
> round-trip (`PATCH /v1/cameras/{id}` rename + revert) and the MCP
> Inspector CLI is verified end-to-end. Network mutations, LLM-mediated
> LAN-direct **Protect** invocation, binary Protect endpoints
> (snapshots, RTSPS, talk-back, WebSockets), the Inspector UI mode, and
> every other agent platform (Claude Code, Claude Desktop, VS Code +
> Copilot, Codex CLI, Continue, Cline, Aider, Zed, …) are wired but
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
| Unit tests | Vitest, 105 specs across spec loader, dispatcher, sandbox, server, tag normalisation, Protect surfaces | ✅ all green |
| Integration tests (in-process MCP transport) | `InMemoryTransport` against `createMcpServer` + a mock UniFi controller (Network + Protect) | ✅ green |
| Integration tests (real Streamable HTTP transport) | `StreamableHTTPClientTransport` over a real HTTP listener | ✅ green |
| Protect surface against a mock controller | `unifi.local.protect.*` end-to-end via the integration harness with the bundled fallback spec | ✅ green (see Scenario D in `src/__tests__/integration/scenarios.test.ts`) |
| Live read-only sweep on a real Network (cloud) | `scripts/discover-network.ts` against a real UDM-Pro via `unifi.cloud.network()` | ✅ produced 28 KB JSON snapshot, plus HLD/LLD/best-practices Markdown |
| Live read-only sweep of cloud-Protect | `scripts/discover-protect.ts` against a real UDM-Pro running Protect 7.0.107 via `unifi.cloud.protect(consoleId)` | ✅ official OpenAPI loaded from `apidoc-cdn.ui.com/protect/v7.0.107/integration.json` (35 ops); `getProtectMetaInfo` returned `applicationVersion: "7.0.107"`; `listCameras` returned 4 cameras with name/state. Sanitized transcript at `out/verification/cloud-protect-live-smoke.txt` |
| **Live read-only sweep of LAN-direct Network** | `scripts/discover-local.ts` against the same UDM-Pro running Network 10.3.58 via `unifi.local.*` | ✅ Network 10.1.84 spec resolved (67 ops); 1 site / 5 devices (UDM-Pro + 4 access points) / 2 WAN / 2 Wi-Fi / 32 wireless clients enumerated through 10 sandbox host calls in 608 ms. Sanitized transcript at `out/verification/local-network-live-smoke.txt` |
| **Live read-only sweep of LAN-direct Protect** | `scripts/discover-local.ts` against the same UDM-Pro running Protect 7.0.107 via `unifi.local.protect.*` | ✅ official Protect 7.0.107 spec resolved (35 ops); 4 cameras with full metadata returned in 162 ms; identical results to the cloud-Protect run on the same hardware (cross-confirms the wire path). Sanitized transcript at `out/verification/local-protect-live-smoke.txt` |
| **Live mutation round-trip on Protect** | `scripts/verify-mutations.ts` against the same UDM-Pro: `PATCH /v1/cameras/{id}` to rename a DISCONNECTED camera, GET-verify, `PATCH` revert, GET-verify | ✅ rename → verify → revert → verify in 3 sequential `ExecuteExecutor` invocations (6 sandbox host calls total). Pre-flight refuses to run on non-DISCONNECTED cameras or stale-test names; revert runs in a separate executor invocation with fatal exit codes if it fails. Sanitized transcript at `out/verification/mutation-live-smoke.txt` |
| `cursor-agent mcp list-tools unifi` (protocol smoke) | local CLI, no LLM | ✅ both `search` and `execute` exposed |
| **MCP Inspector (CLI mode)** | `@modelcontextprotocol/inspector@0.20.0 --cli --transport stdio` against the live UDM-Pro at 172.27.1.1 | ✅ all four phases pass: `tools/list` returns both tools with full descriptors; credential-free `execute` returns the surface inventory; credentialled `search` returns live operations including the freshly compacted `aclRules` tag; credentialled `execute` returns live site count `1`. Sanitized transcript at `out/verification/mcp-inspector-live-smoke.txt` |
| End-to-end LLM-mediated invocation via cursor-agent | Claude Sonnet 4.6 driving the server through `cursor-agent` in interactive PTY mode | ✅ JSON-RPC roundtrip, correct value returned (see `out/verification/cursor-agent-sonnet-mcp-call.txt`) |
| End-to-end LLM-mediated invocation via opencode (cloud surface) | DeepSeek v4 Flash via `opencode-go` provider, project-scoped `opencode.json`, opencode v1.14.30 | ✅ MCP tools auto-injected as `unifi_search` / `unifi_execute`, model called `unifi_search` with the right code, server returned `"9"`, model echoed it (see `out/verification/opencode-deepseek-mcp-call.txt`) |
| **End-to-end LLM-mediated invocation via opencode (LAN-direct surface)** | DeepSeek v4 Flash driving `unifi.local.*` against the same UDM-Pro at 172.27.1.1 | ✅ Model used `unifi_search` to find `getSiteOverviewPage`, then `unifi_execute` to call it through the LAN-direct path; server returned site count `1` (matches `discover-local.ts`); model echoed it. Self-corrected through 4 syntax attempts using the documented error-shape contract (top-level `return` / `await` are not allowed in QuickJS — see `out/verification/opencode-deepseek-local-mcp-call.txt`) |

What is **not yet verified** (and where help is welcome):

- Cursor IDE chat panel after a fresh window restart (project-scoped `.cursor/mcp.json` registration).
- Other agent / IDE clients: Claude Desktop, Continue, Codeium, Aider, Zed, Cline, etc.
- The official MCP Inspector **UI** (browser) mode and HTTP / SSE transports — only Inspector CLI + stdio are live-verified.
- Hosted/multi-tenant deployment of the Streamable HTTP transport behind a reverse proxy.
- Long-running soak / stability under sustained load.
- Real UniFi networks other than the one author's homelab — we cannot generalise resilience claims from a single network.
- More than one model per verified client (only one model has been driven end-to-end against each: Sonnet 4.6 on cursor-agent, DeepSeek v4 Flash on opencode for both cloud and LAN-direct Network).
- **LLM-mediated invocation against `unifi.local.protect.*`.** DeepSeek v4 Flash via opencode is live-verified against `unifi.local.*` (Network) — see the verification matrix row above. The Protect equivalent (`unifi.local.protect.callOperation('listCameras')` driven by an LLM) has not been recorded yet.
- **Network mutation verification.** The Protect mutation round-trip (`PATCH /v1/cameras/{id}` rename + revert) is live-verified, but every Network create endpoint exposed in this controller's spec (`createAclRule`, `createDnsPolicy`, `createNetwork`, `createWifiBroadcast`, `createTrafficMatchingList`, `createFirewallZone`, `createFirewallPolicy`, `createVouchers`) requires a polymorphic discriminator (`$.type`, `$.management`, …) that the loaded OpenAPI spec does **not** currently expose to the synthesizer; probing them blindly against live hardware is unsafe. A future loader pass needs to extract polymorphic-discriminator enums (or we ship known-good fixture bodies per controller version).
- **Other Protect mutations beyond camera-rename.** PTZ commands (`POST /v1/cameras/{id}/ptz/goto/{slot}`), `disableCameraMicPermanently` (irreversible per its name), the alarm-manager webhook trigger, and the `rtsps-stream` enable/disable pair are wired but not yet driven against real hardware. The `POST /v1/liveviews` endpoint accepts creates, but the Integration API does **not** expose a DELETE for liveviews — `verify-mutations.ts` therefore never creates one.
- **Binary / streaming Protect surfaces.** Snapshots (`/snapshot`), RTSPS streams (`/rtsps-stream`), talk-back sessions (`/talkback-session`), and the WebSocket `subscribe/*` endpoints are all on the Protect spec but the JSON-only `HttpClient` doesn't speak them yet.

Two client-specific subtleties worth calling out:

- **cursor-agent v2026.05.05** does *not* inject custom MCPs as model-callable tools in either `--print` or interactive mode, even when `cursor-agent mcp list` reports them as `ready`. Sufficiently capable models (Sonnet 4.6, Codex 5.3) work around this by reading `.cursor/mcp.json` themselves and driving the server over stdio; the result is correct but indirect. See `docs/cursor-skill.md` §8.
- **opencode v1.14.30** *does* auto-inject MCP tools cleanly (under the `<server>_<tool>` name scheme). Two gotchas: (1) the bundled `plugin.copilot` provider has a Zod schema mismatch in 1.14.30 that hangs bootstrap when not using `--pure`; (2) opencode persists per-model variant settings (e.g. `variant: max`) across runs, so a previously-set "max reasoning" can silently turn an 8-second call into an 8-minute one. See `docs/opencode-skill.md`.

### Roadmap

- **Cross-spec polymorphic-discriminator extraction → Network mutation verification.** Every Network 10.3.58 create endpoint (`createAclRule`, `createDnsPolicy`, `createNetwork`, `createWifiBroadcast`, `createTrafficMatchingList`, `createFirewallZone`, `createFirewallPolicy`, `createVouchers`) returns `api.request.missing-type-id` because the loader doesn't currently expose the polymorphic discriminator enum to the synthesizer. Once that's wired, Network mutations can be live-verified the same way the Protect camera-rename round-trip was
- **LLM-mediated invocation against the LAN-direct Protect surface.** `unifi.local.*` (Network) is now LLM-verified end-to-end via `opencode`; the equivalent against `unifi.local.protect.*` has not been recorded yet
- **Other Protect mutations beyond camera-rename** — PTZ goto/patrol, alarm-manager webhook trigger, and the `rtsps-stream` enable/disable pair (skipping `disableCameraMicPermanently`, which is irreversible by name)
- **Broaden the bundled fallback** beyond the current ~18 JSON-over-HTTP ops, or expose binary surfaces (snapshots, RTSPS metadata, files) once the sandbox supports them
- **Protect WebSocket events** (`/v1/subscribe/events`, `/v1/subscribe/devices`) — currently out of scope
- **Per-tenant rate limiting** keyed on hashed credentials (currently per-IP)
- **Optional persistent spec cache** versioned by controller fingerprint (we already version by `CACHE_SCHEMA_VERSION` to invalidate on internal-shape changes; controller-version pinning is the next layer)
- **Broader client validation** — confirmed working configs for Claude Desktop, Continue, Cline, Aider, Zed, the MCP Inspector UI mode, and HTTP/SSE transports for the Inspector
- **NPM publish** — reserved for `1.0.0`. The package is `"private": true` until then.

## Documentation

- [docs/architecture.md](docs/architecture.md) — How the server is built, request lifecycle, sandbox details
- [docs/multi-tenant.md](docs/multi-tenant.md) — Header protocol, deployment patterns, security model
- [docs/security.md](docs/security.md) — Threat model, credential handling, sandbox guarantees
- [docs/deployment.md](docs/deployment.md) — Docker, Cloudflare Workers, systemd
- [docs/usage.md](docs/usage.md) — Tool descriptions, common patterns, gotchas

## License

MIT — see [LICENSE](LICENSE).
