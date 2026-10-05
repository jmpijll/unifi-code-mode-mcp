# Usage guide

## The two tools

### `search`

Find the operations you want before invoking them. Read-only — no network.

Globals available to your code:

| Global | Type | Description |
| --- | --- | --- |
| `spec.local` | `{ title, version, sourceUrl, serverPrefix, operations[] } \| null` | Local Network Integration spec |
| `spec.cloud` | same shape | Site Manager (cloud) spec |
| `searchOperations(ns, query, limit?)` | function | Ranked text search over operationId/path/summary/tags |
| `getOperation(ns, idOrMethodPath)` | function | Full operation incl. spec parameter detail |
| `findOperationsByPath(ns, substring)` | function | Path substring match |
| `console.log()` | function | Captured into tool output |

Each operation in `spec.<ns>.operations` is:

```ts
{
  operationId: string;
  method: 'GET' | 'POST' | ...;
  path: string;
  tag: string;
  summary?: string;
  parameters: Array<{ name, in, required, type? }>;
  hasRequestBody?: boolean;
  deprecated?: boolean;
}
```

Examples:

```js
// All read-only operations on Sites
spec.local.operations.filter(function (o) {
  return o.tag === 'sites' && o.method === 'GET';
});
```

```js
// Top 5 hits for "voucher"
searchOperations('local', 'voucher', 5);
```

```js
// Full detail (incl. parameters' descriptions) for getSite
getOperation('local', 'getSite');
```

### `execute`

Run UniFi API calls inside the sandbox. Five target surfaces:

| Surface | Auth | Reaches |
| --- | --- | --- |
| `unifi.local.*` | controller API key (`X-Unifi-Local-Api-Key`) | direct Network Integration API over LAN |
| `unifi.cloud.*` | Site Manager key (`X-Unifi-Cloud-Api-Key`) | `api.ui.com` native (Hosts, Sites, Devices, ISP Metrics, SD-WAN) |
| `unifi.cloud.network(consoleId).*` | Site Manager key | full Network Integration API, **tunneled through `api.ui.com`** so the controller never sees public traffic |
| `unifi.local.protect.*` | controller API key | local Protect Integration API (cameras + PTZ, NVRs, sensors, lights, chimes, viewers, live-views, plus the full official surface when the loader can fetch `apidoc-cdn.ui.com/protect/v<version>/integration.json`) — needs Protect installed on the controller |
| `unifi.cloud.protect(consoleId).*` | Site Manager key | Protect Integration API tunneled through the same Site Manager connector at `/v1/connector/consoles/{id}/proxy/protect/integration`. URL pattern is officially documented by Ubiquiti — see [protect-design.md](protect-design.md) |

> **Sync-style calls.** Inside the sandbox, calls to `unifi.local.<op>(...)` and friends appear synchronous (the host wraps async work transparently). You generally don't need `await`. The script's last expression is the tool result. Async/await IIFEs are supported but use sync style if you're chaining many calls — QuickJS's asyncify shim is more reliable that way.

Surface:

```ts
unifi.local.<tag>.<operationId>(args)         // typed lookup
unifi.local.callOperation(operationId, args)  // flat lookup by id
unifi.local.request({ method, path, ... })    // raw escape hatch
unifi.local.spec                              // { title, version, sourceUrl, operationCount }

unifi.cloud.<tag>.<operationId>(args)         // Site Manager native, e.g. unifi.cloud.hosts.listHosts({})
unifi.cloud.callOperation(operationId, args)
unifi.cloud.request({ method, path, ... })
unifi.cloud.spec

unifi.cloud.network(consoleId)                // returns a per-console Network proxy:
  ├─ .<tag>.<op>(args)                        //   same operation shape as unifi.local
  ├─ .callOperation(opId, args)
  ├─ .request({ method, path, ... })
  ├─ .spec                                    //   identical to unifi.local.spec
  └─ .consoleId

unifi.local.protect.<tag>.<op>(args)          // local Protect, e.g. unifi.local.protect.cameras.listCameras({})
unifi.local.protect.callOperation(opId, args)
unifi.local.protect.request({ method, path, ... })
unifi.local.protect.spec

unifi.cloud.protect(consoleId)                // returns a per-console Protect proxy (same shape as cloud.network)
  ├─ .<tag>.<op>(args)
  ├─ .callOperation(opId, args)
  ├─ .request({ method, path, ... })
  ├─ .spec
  └─ .consoleId
```

Find your `consoleId` at `https://unifi.ui.com/consoles/<consoleId>/...` after logging in.

Argument routing for typed calls:

- If `args` contains any of `pathParams`, `query`, `body`, or `headers`, those keys are passed through verbatim.
- Otherwise, keys matching the operation's spec parameters are auto-routed (`path` → `pathParams`, `query` → `query`). Remaining keys form the JSON body if the operation accepts one.

#### Examples

```js
// List sites (sync)
var sites = unifi.local.sites.listSites({ limit: 200 });
sites.data.map(function (s) { return { id: s.id, name: s.name }; });
```

```js
// Loop, count devices per site
var sites = unifi.local.sites.listSites({ limit: 200 }).data;
var counts = sites.map(function (site) {
  var devices = unifi.local.devices.listDevices({ siteId: site.id });
  return { site: site.name, devices: devices.data.length };
});
counts;
```

```js
// Raw request — endpoint not in the spec
unifi.local.request({ method: 'GET', path: '/v1/info' });
```

```js
// Cloud — Site Manager native
var hosts = unifi.cloud.hosts.listHosts({});
hosts.data.length;
```

```js
// Cloud — Network API tunneled through api.ui.com
// No need for the controller to be reachable from the internet.
var net = unifi.cloud.network('CONSOLE-ID-FROM-UNIFI-UI-COM');
var sites = net.sites.listSites({ limit: 200 });
var totalDevices = 0;
for (var i = 0; i < sites.data.length; i++) {
  var d = net.devices.listDevices({ siteId: sites.data[i].id });
  totalDevices += (d && d.data ? d.data.length : 0);
}
({ siteCount: sites.data.length, totalDevices: totalDevices });
```

```js
// Cloud-proxied raw escape hatch
var net = unifi.cloud.network('CONSOLE-ID');
net.request({ method: 'GET', path: '/v1/info' });
```

```js
// Local Protect — camera + NVR inventory
var meta = unifi.local.protect.callOperation('getProtectMetaInfo', {});
var cams = unifi.local.protect.cameras.listCameras({});
var nvrs = unifi.local.protect.nvrs.listNvrs({});
({
  protectVersion: meta.applicationVersion,
  cameras: cams.data.length,
  nvrs: nvrs.data.length,
});
```

```js
// Cloud-proxied Protect (best-effort — falls back to a clear error if the
// Site Manager connector doesn't proxy Protect on this account/console).
try {
  var protect = unifi.cloud.protect('CONSOLE-ID');
  ({ ok: true, cameras: protect.cameras.listCameras({}).data.length });
} catch (e) {
  ({ ok: false, reason: String(e) });
}
```

## Common gotchas

- **`(async function() {...})()`** — supported for a single `await`, but chaining several awaits inside one async IIFE can stress QuickJS's asyncify shim. Prefer sync-style for multi-call workflows.
- **Missing credentials** — calls to a namespace without credentials throw inside the sandbox. `unifi.cloud.network(...)` requires the **cloud** key, not the local one. Catch with `try/catch` if you want to handle gracefully.
- **TLS errors** — only relevant for `unifi.local.*`. `api.ui.com` always uses a publicly trusted cert. If your controller uses a self-signed cert, supply `X-Unifi-Local-Ca-Cert` (preferred) or set `X-Unifi-Local-Insecure: true`.
- **Result size** — large response bodies are truncated to 100 000 chars. Filter, paginate, or select fields server-side.
- **Cloud-proxy auth** — the proxy uses the **Site Manager** key (`X-Unifi-Cloud-Api-Key`), NOT the controller's local key. Generate it at unifi.ui.com under your account API settings.

## Workflow

1. Use `search` to find the operation(s) you need (operationIds, parameter shapes).
2. Use `execute` to call them, batch, post-process, and return only what the user asked for.

This keeps the LLM's context small (~constant) regardless of how big the API is — the canonical Code Mode advantage.


---

# Setup and verification reference

The following details were moved from the README during repository harmonization.
Historical verification records describe the maintainer's earlier runs; they are not
claims that live services or clients were retested in this change.

## Quickstart (single-user)

```bash
git clone https://github.com/jmpijll/unifi-code-mode-mcp.git
cd unifi-code-mode-mcp
npm ci
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

See [docs/multi-tenant.md](../docs/multi-tenant.md).

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
| **End-to-end LLM-mediated invocation via opencode (LAN-direct Network)** | DeepSeek v4 Flash driving `unifi.local.*` against the same UDM-Pro at 172.27.1.1 | ✅ Model used `unifi_search` to find `getSiteOverviewPage`, then `unifi_execute` to call it through the LAN-direct path; server returned site count `1` (matches `discover-local.ts`); model echoed it. Self-corrected through 4 syntax attempts using the documented error-shape contract (top-level `return` / `await` are not allowed in QuickJS — see `out/verification/opencode-deepseek-local-mcp-call.txt`) |
| **End-to-end LLM-mediated invocation via opencode (LAN-direct Protect)** | DeepSeek v4 Flash driving `unifi.local.protect.*` against the same UDM-Pro at 172.27.1.1 | ✅ Single-call success: model invoked `unifi_execute` with the async-IIFE `listCameras` recipe and returned `count=4 names=Daisy,Cnc,Voordeur,Tuin` — same camera array as `discover-local.ts` and the cloud-Protect run on the same hardware. Sanitized transcript at `out/verification/opencode-deepseek-local-protect-mcp-call.txt` |
| **Second live mutation round-trip on Protect — RTSPS stream toggle** | `scripts/verify-mutations-rtsps.ts`: `DELETE /v1/cameras/{id}/rtsps-stream?qualities=high` → GET-verify all-null → `POST /v1/cameras/{id}/rtsps-stream` body `{qualities:['high']}` → GET-verify high re-enabled (with rotated token) | ✅ Self-reverting DELETE+POST pattern works against `unifi.local.protect.*`, confirms `buildQueryString()` array serialisation. Sanitized transcript at `out/verification/mutation-rtsps-live-smoke.txt` |
| **MCP Inspector (UI / browser mode)** | `@modelcontextprotocol/inspector@0.20.0` browser UI driven via headless Chromium. Connect → List Tools → select `execute` → run `getSiteOverviewPage` one-liner | ✅ Connect succeeded; both tools listed with full descriptors; `execute` returned `Tool Result: Success` with live site count; History pane recorded `initialize` → `tools/list` → `tools/call`. Transcript + two screenshots at `out/verification/mcp-inspector-ui-*` |
| **Claude Code CLI (handshake-level)** | `claude mcp add unifi --transport stdio …` then `claude mcp list` then `claude mcp get unifi` | ✅ `✓ Connected` from Claude Code v2.0.47's bundled MCP client; full descriptor returned by `claude mcp get`. End-to-end LLM call through `claude --print` blocked by client-side Claude auth (no API key in env), documented as a tester recipe. Sanitized transcript at `out/verification/claude-code-cli-mcp-handshake.txt` |
| **Cloudflare Workers — `wrangler dev` parity smoke** | `npm run cf:dev` (Miniflare) + curl probes against `/health`, `/mcp`, unknown paths | ✅ Worker boots; `/health` → `{"status":"ok","namespace":"local"}`; `/mcp` without creds → 401 with documented missing-header message; `/mcp` with creds → 502 spec-load failure (expected for stub baseUrl). The 501 transport-adapter scaffold is documented and unreachable without real creds + a publicly-trusted controller. Sanitized transcript at `out/verification/cf-worker-parity-smoke.txt` |

What is **not yet verified** (and where help is welcome):

- Cursor IDE chat panel after a fresh window restart (project-scoped `.cursor/mcp.json` registration).
- Other agent / IDE clients beyond cursor-agent, opencode, MCP Inspector (CLI + UI), and Claude Code CLI handshake: Claude Desktop, VS Code + Copilot, Continue, Codeium, Aider, Zed, Cline, etc.
- **End-to-end LLM-mediated invocation through Claude Code CLI.** The MCP register + connect handshake is verified (Claude Code's bundled MCP client reports `✓ Connected`), but driving a full prompt → `unifi_execute` → response loop through `claude --print` requires `ANTHROPIC_API_KEY` (or interactive auth) which our verification environment didn't have. Tester recipe in `out/verification/claude-code-cli-mcp-handshake.txt`.
- HTTP / SSE transports inside the MCP Inspector — only stdio is live-verified through both CLI and UI.
- Hosted/multi-tenant deployment of the Streamable HTTP transport behind a reverse proxy.
- Long-running soak / stability under sustained load.
- Real UniFi networks other than the one author's homelab — we cannot generalise resilience claims from a single network.
- More than one model per verified client (only one model has been driven end-to-end against each: Sonnet 4.6 on cursor-agent, DeepSeek v4 Flash on opencode for cloud + LAN-direct Network + LAN-direct Protect).
- **Network mutation verification.** The two Protect mutation round-trips (`PATCH /v1/cameras/{id}` rename + revert; DELETE+POST RTSPS-stream toggle) are live-verified, but every Network create endpoint exposed in this controller's spec (`createAclRule`, `createDnsPolicy`, `createNetwork`, `createWifiBroadcast`, `createTrafficMatchingList`, `createFirewallZone`, `createFirewallPolicy`, `createVouchers`) requires a polymorphic discriminator (`$.type`, `$.management`, …) that the loaded OpenAPI spec does **not** currently expose to the synthesizer; probing them blindly against live hardware is unsafe. A future loader pass needs to extract polymorphic-discriminator enums (or we ship known-good fixture bodies per controller version).
- **PTZ Protect mutations** (`POST /v1/cameras/{id}/ptz/goto/{slot}` and the patrol start/stop pair). None of the four cameras in the maintainer's homelab is PTZ-capable (`featurePtz === false` on all four), so this is homelab-blocked rather than wiring-broken. Verification deferred to a contributor with PTZ hardware.
- **Alarm-manager webhook trigger** (`POST /v1/alarm-manager/webhook/{id}`). Requires an alarm pre-configured in the Protect UI with the matching ID; the homelab has none, so the operation is a no-op against this controller. Verification deferred to a contributor with alarm-managed Protect.
- **`disableCameraMicPermanently`** is wired but intentionally unverified — irreversible per its name; we won't drive it against any controller.
- **Binary / streaming Protect surfaces.** Snapshots (`/snapshot`), RTSPS streams (`/rtsps-stream`), talk-back sessions (`/talkback-session`), and the WebSocket `subscribe/*` endpoints are all on the Protect spec but the JSON-only `HttpClient` doesn't speak them yet.
- **Cloudflare Workers full transport.** `wrangler dev` parity smoke verified the routing, auth-header validation, spec-loader, and 404/401/502 paths all work; the 501 transport-adapter scaffold and the `worker_loaders` `LOADER` binding (requires wrangler v4) remain unimplemented and unreached. See `cf-worker/README.md` for the open work.

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
