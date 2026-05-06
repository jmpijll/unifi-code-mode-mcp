# UniFi Code-Mode MCP

[![CI](https://github.com/jmpijll/unifi-code-mode-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jmpijll/unifi-code-mode-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Model Context Protocol (MCP) server for the **Ubiquiti UniFi Network Integration API** and the **UniFi Site Manager (cloud) API**, built on the **Cloudflare "Code Mode" pattern**: instead of one MCP tool per endpoint, the server exposes **two tools** — `search` and `execute` — and the LLM writes JavaScript that runs in a QuickJS WASM sandbox. This keeps the LLM context small (~constant) regardless of how big the underlying API is.

## Why Code Mode?

The UniFi Network Integration API has **70+ endpoints**. Exposing each as a separate MCP tool floods the LLM context with thousands of tokens before it has even read the user's question. Code Mode collapses the entire API surface into two tools and lets the model search the OpenAPI spec, then execute calls programmatically — including loops, batching, and post-processing. See Cloudflare's [Code Mode for MCP](https://blog.cloudflare.com/code-mode-mcp/) blog post and the official `@cloudflare/codemode` package.

## Highlights

- **Cloudflare Code Mode compatible** — two-tool design (`search` + `execute`), Cloudflare-style sandbox semantics
- **Two API surfaces in one server** — `unifi.local.*` (per-controller Network Integration) and `unifi.cloud.*` (Site Manager)
- **Single-user (env) and multi-user (per-request HTTP headers)** — the same server runs as a private homelab tool or a hosted multi-tenant gateway
- **QuickJS WASM sandbox** — memory, CPU, time, and call-budget limits; credentials never enter the sandbox
- **Dynamic OpenAPI loading** — the controller's app version is auto-discovered (`GET /v1/info`); the spec is fetched from `apidoc-cdn.ui.com` and cached on disk
- **Hybrid deployment** — runs on Node.js (stdio + Streamable HTTP) or Cloudflare Workers (using `@cloudflare/codemode` + Worker Loader)
- **TLS done right** — strict by default, per-tenant custom CA cert, optional opt-in to insecure (with loud warnings)

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
// execute tool
const sites = await unifi.local.sites.list({ limit: 200 });
const counts = await Promise.all(
  sites.data.map(async (site) => ({
    name: site.name,
    devices: (await unifi.local.devices.list({ siteId: site.id })).data.length,
  })),
);
return counts;
```

## Documentation

- [docs/architecture.md](docs/architecture.md) — How the server is built, request lifecycle, sandbox details
- [docs/multi-tenant.md](docs/multi-tenant.md) — Header protocol, deployment patterns, security model
- [docs/security.md](docs/security.md) — Threat model, credential handling, sandbox guarantees
- [docs/deployment.md](docs/deployment.md) — Docker, Cloudflare Workers, systemd
- [docs/usage.md](docs/usage.md) — Tool descriptions, common patterns, gotchas

## Status

Pre-1.0. The Network Integration API spec is loaded dynamically from Ubiquiti's CDN; the server should adapt to controller version changes without code edits.

## License

MIT — see [LICENSE](LICENSE).
