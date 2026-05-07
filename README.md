# UniFi Code-Mode MCP

[![CI](https://github.com/jmpijll/unifi-code-mode-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jmpijll/unifi-code-mode-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Model Context Protocol (MCP) server for the **Ubiquiti UniFi Network Integration API** and the **UniFi Site Manager (cloud) API**, built on the **Cloudflare "Code Mode" pattern**: instead of one MCP tool per endpoint, the server exposes **two tools** — `search` and `execute` — and the LLM writes JavaScript that runs in a QuickJS WASM sandbox. This keeps the LLM context small (~constant) regardless of how big the underlying API is.

## Why Code Mode?

The UniFi Network Integration API has **70+ endpoints**. Exposing each as a separate MCP tool floods the LLM context with thousands of tokens before it has even read the user's question. Code Mode collapses the entire API surface into two tools and lets the model search the OpenAPI spec, then execute calls programmatically — including loops, batching, and post-processing. See Cloudflare's [Code Mode for MCP](https://blog.cloudflare.com/code-mode-mcp/) blog post and the official `@cloudflare/codemode` package.

## Highlights

- **Cloudflare Code Mode compatible** — two-tool design (`search` + `execute`), Cloudflare-style sandbox semantics
- **Three API surfaces in one server** —
  - `unifi.local.*` — direct Network Integration API on a controller you can reach over the LAN
  - `unifi.cloud.*` — Site Manager native endpoints (Hosts, Sites, Devices, ISP Metrics, SD-WAN)
  - `unifi.cloud.network(consoleId).*` — full Network Integration API, **proxied through `api.ui.com`** so a single Site Manager API key drives any console without exposing the controller publicly
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

## Status

Pre-1.0. The Network Integration API spec is loaded dynamically from Ubiquiti's CDN; the server should adapt to controller version changes without code edits.

### Verification status

What we have **directly verified** so far:

| Layer | How | Result |
|---|---|---|
| Unit tests | Vitest, 78 specs across spec loader, dispatcher, sandbox, server | ✅ all green |
| Integration tests (in-process MCP transport) | `InMemoryTransport` against `createMcpServer` + a mock UniFi controller | ✅ green |
| Integration tests (real Streamable HTTP transport) | `StreamableHTTPClientTransport` over a real HTTP listener | ✅ green |
| Live read-only sweep on a real network | `scripts/discover-network.ts` against a real UDM-Pro-Max via `unifi.cloud.network()` | ✅ produced 28 KB JSON snapshot, plus HLD/LLD/best-practices Markdown |
| `cursor-agent mcp list-tools unifi` (protocol smoke) | local CLI, no LLM | ✅ both `search` and `execute` exposed |
| End-to-end LLM-mediated invocation via cursor-agent | Claude Sonnet 4.6 driving the server through `cursor-agent` in interactive PTY mode | ✅ JSON-RPC roundtrip, correct value returned (see `out/verification/cursor-agent-sonnet-mcp-call.txt`) |

What is **not yet verified** (and where help is welcome):

- Cursor IDE chat panel after a fresh window restart (project-scoped `.cursor/mcp.json` registration).
- Other agent / IDE clients: Claude Desktop, Continue, Codeium, Aider, Zed, Cline, etc.
- The official MCP Inspector UI.
- Hosted/multi-tenant deployment of the Streamable HTTP transport behind a reverse proxy.
- Long-running soak / stability under sustained load.
- Real UniFi networks other than the one author's homelab — we cannot generalise resilience claims from a single network.

A subtlety worth calling out for `cursor-agent` users: against `cursor-agent v2026.05.05`, custom MCP servers configured in `.cursor/mcp.json` are *not* injected as model-callable tools in either `--print` or interactive mode, even when `cursor-agent mcp list` reports them as `ready`. Sufficiently capable models (Sonnet 4.6, Codex 5.3) work around this by reading `.cursor/mcp.json` themselves and driving the server over stdio; the result is correct but indirect. See `docs/cursor-skill.md` §8 for the full writeup and reproducer.

### Roadmap

- **UniFi Protect proxy** — `unifi.cloud.protect(consoleId).*` over the same `/v1/connector/consoles/{id}/proxy/protect/integration` connector
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
