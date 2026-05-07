# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-05-07

First tagged release. Five sandbox surfaces, live-verified against the
maintainer's UDM-Pro for both the cloud-Network and cloud-Protect paths,
and end-to-end LLM-mediated invocation verified through two clients
(Cursor's `cursor-agent` interactive PTY mode + opencode `--pure run`).

### Added

#### Core server
- Cloudflare-style Code-Mode MCP server with two tools (`search` + `execute`)
  and a QuickJS WASM sandbox running on Node.js
- Single-user (env) and multi-user (per-request HTTP headers) modes — the
  same server runs as a private homelab tool or a hosted multi-tenant gateway
- Stdio + Streamable HTTP transports
- Cloudflare Workers entry point under `cf-worker/`
- Per-tenant TLS handling: strict by default, optional custom CA cert,
  opt-in `INSECURE` with loud warnings on every call

#### Five API surfaces
- `unifi.local.<tag>.<op>(args)` — direct UniFi Network Integration API on
  a controller you can reach over the LAN (`https://<controller>/proxy/network/integration/v1/...`)
- `unifi.cloud.<tag>.<op>(args)` — UniFi Site Manager native endpoints
  (`https://api.ui.com/v1/...`) — Hosts, Sites, Devices, ISP Metrics, SD-WAN
- `unifi.cloud.network(consoleId).<tag>.<op>(args)` — Network Integration API
  tunneled through the Site Manager connector at
  `/v1/connector/consoles/{id}/proxy/network/integration`. Drive any cloud-
  managed console with a single Site Manager API key, no controller exposure
- `unifi.local.protect.<tag>.<op>(args)` — UniFi Protect Integration API on
  a Protect-enabled controller (`https://<controller>/proxy/protect/integration/v1/...`)
- `unifi.cloud.protect(consoleId).<tag>.<op>(args)` — Protect Integration API
  tunneled through the same Site Manager connector at
  `/v1/connector/consoles/{id}/proxy/protect/integration`. Officially
  documented by Ubiquiti at `developer.ui.com/protect/v7.0.107/...`

#### Spec loading
- Dynamic OpenAPI loading from `apidoc-cdn.ui.com` with on-disk caching
  keyed by spec kind + version
- Network spec auto-discovery via `GET /v1/info` on the controller; falls
  back through `KNOWN_NETWORK_SPEC_VERSIONS = ['10.1.84']` when the
  controller's reported version isn't on Ubiquiti's CDN (most minor
  versions aren't)
- Protect spec auto-discovery via `GET /proxy/protect/integration/v1/meta/info`
  on the local controller; cloud baseUrls skip the discovery probe and go
  straight to the known-version ladder (`['7.0.107', '7.0.94']`)
- Optional opt-in to a community-maintained Protect snapshot via
  `UNIFI_PROTECT_ALLOW_BEEZLY_FALLBACK=true`
- Spec URL overrides: `UNIFI_LOCAL_SPEC_URL`, `UNIFI_PROTECT_SPEC_URL`
- Bundled curated fallbacks for both Site Manager (no public spec exists)
  and Protect (~18 JSON-over-HTTP ops, used only when CDN is unreachable)
- Smarter `synthesizeOperationId()` for specs that ship `operationId: null`
  (notably the official Protect spec): produces friendly REST-style names
  like `listCameras`, `getCamera`, `cameraPtzPatrolStart` instead of the
  legacy `getV1CamerasIdPtz...` form

#### Sandbox & dispatcher
- Per-execute call budget, wall-clock timeout, memory cap (QuickJS runtime)
- Synchronous-style host calls inside the sandbox via QuickJS asyncify
- Argument auto-routing for typed lookups: `{ siteId, body }` is split
  into path-params, query, headers, and body based on the operation's
  OpenAPI schema
- Path-based escape hatch: `unifi.<surface>.request({ method, path, ... })`
- Structured error taxonomy: every error reaching the model carries an
  `[unifi.<surface>.<error-class>]` prefix the LLM can pattern-match on:
  `http`, `missing-credentials`, `unknown-operation`, `error`

#### Operational scripts
- `scripts/discover-network.ts` — live read-only sweep through
  `unifi.cloud.network()`, dumps a JSON snapshot to `out/`
- `scripts/discover-protect.ts` — live read-only Protect probe + smoke
  test through `unifi.cloud.protect(consoleId)`
- `scripts/live-test.ts` — surface-by-surface live test harness
- `scripts/sandbox-cloud-proxy-smoke.ts` — end-to-end QuickJS smoke
- `scripts/cursor-cli-smoke.sh` + `scripts/cursor-agent-pty-smoke.exp` —
  developer-local validation against `cursor-agent`
- All scripts read API keys from 1Password (`op://AI Agents/...`) by
  default, with `UNIFI_*_API_KEY` env-var override

#### Tests
- 98 unit + integration tests, all green
- Mock UniFi controller (`src/__tests__/integration/mock-controller.ts`)
  serves both `/proxy/network/integration/*` and `/proxy/protect/integration/*`
- Integration tests run twice — once over `InMemoryTransport` (in-process
  MCP client/server pair) and once over a real `StreamableHTTPClientTransport`
  with a real HTTP listener
- Scenario D drives the full `unifi.local.protect.*` surface end-to-end
  through the in-process MCP transport against the mock controller

#### Documentation
- `README.md` — overview, quickstart, verification status table
- `SKILL.md` — operating manual for an LLM agent driving the server
  (recipes, error taxonomy, surface decision tree)
- `AGENTS.md` — manual for human contributors / coding agents working
  on this codebase (architecture invariants, daily dev loop, sharp edges)
- `docs/architecture.md`, `docs/multi-tenant.md`, `docs/security.md`,
  `docs/deployment.md`, `docs/usage.md`, `docs/cursor-skill.md`,
  `docs/opencode-skill.md`, `docs/protect-design.md`

### Verified live

- **Network through cloud connector** (`unifi.cloud.network()`) against a
  real UDM-Pro running v10.3.58. Produced a 28 KB JSON snapshot plus
  HLD/LLD/best-practices Markdown. Loader gracefully fell back to the
  v10.1.84 spec.
- **Protect through cloud connector** (`unifi.cloud.protect(consoleId)`)
  against the same UDM-Pro running Protect 7.0.107. The loader pulled
  the official Ubiquiti spec from
  `apidoc-cdn.ui.com/protect/v7.0.107/integration.json` (35 ops). Read-
  only sweep returned `applicationVersion: "7.0.107"` and 4 cameras.
  Sanitized transcript: `out/verification/cloud-protect-live-smoke.txt`
- **End-to-end LLM-mediated invocation:**
  - Claude Sonnet 4.6 via `cursor-agent` interactive PTY mode — see
    `out/verification/cursor-agent-sonnet-mcp-call.txt`
  - DeepSeek v4 Flash via `opencode --pure run` — see
    `out/verification/opencode-deepseek-mcp-call.txt`

### Fixed

- `loadLocalSpec` now falls back through `KNOWN_NETWORK_SPEC_VERSIONS`
  when `apidoc-cdn.ui.com` returns 403/404 for the controller's reported
  version. Ubiquiti only publishes specs for tagged releases.
- `dispatchOperation` merges convenience args (e.g. `{ siteId, body }`)
  with explicit body / pathParams / query buckets correctly.
- `dist/spec/cloud-fallback.json` and `dist/spec/protect-fallback.json`
  are now copied into the build output (the published package was
  missing them in early builds).
- **Cloud-Protect proxy gating bug:** `unifi.cloud.protect(consoleId)`
  was previously gated on the Site Manager spec being loaded. The two
  specs are independent — fixed so cloud-Protect is exposed whenever
  the Protect spec is loaded. Same shape of bug existed on cloud-Network
  proxy (gated on having both specs) — also fixed.
- **Cloud-Protect version-discovery bug:** the loader probed
  `<baseUrl>/proxy/protect/integration/v1/meta/info` for version
  discovery, which is meaningless against `api.ui.com` (no consoleId
  in the path). Skipped for cloud baseUrls; fall through to known-version
  ladder cleanly.
- **Misleading error namespace label:** `UnknownOperationError` was
  attributing every miss to `unifi.local spec` regardless of which
  surface called it. Now reports the right surface
  (`unifi.cloud.network`, `unifi.local.protect`, `unifi.cloud.protect`).

### Documentation correction

- The initial Protect implementation documented the cloud-Protect path as
  "UNVERIFIED — Ubiquiti has not publicly documented" the connector
  proxying Protect. That was wrong: Ubiquiti does publish docs at
  `developer.ui.com/protect/v7.0.107/gettingstarted` with a "Remote" /
  "Local" base-URL selector that maps every operation to exactly the
  paths this server emits. All references to "UNVERIFIED" / "not
  publicly documented" have been replaced with accurate wording, and
  `KNOWN_PROTECT_SPEC_VERSIONS` was retuned from a guess (`['7.1.46',
  '7.0.107']`) to the actually-published tags (`['7.0.107', '7.0.94']`,
  confirmed via HEAD probes).

### Roadmap

- Verify the direct-local Protect path (`unifi.local.protect.*`) on real
  hardware (cloud-Protect already verified)
- Verify Protect mutation paths (PTZ, disable-mic, alarm-manager webhook)
- Tag/operationId normalisation for the official Protect spec — its
  verbose tag names like `"Camera PTZ control & management"` normalise
  into bulky `cameraPtzControlManagement` namespace identifiers that
  could be compacted
- Broaden the bundled Protect fallback beyond the current 18 ops, and/or
  expose binary surfaces (snapshots, RTSPS metadata, files) once the
  sandbox supports them
- Per-tenant rate limiting keyed on hashed credentials (currently per-IP)
- Optional persistent spec cache versioned by controller fingerprint
- Broader client validation — confirmed working configs for Claude
  Desktop, Continue, Cline, Aider, Zed, and the MCP Inspector UI

[0.2.0]: https://github.com/jmpijll/unifi-code-mode-mcp/releases/tag/v0.2.0
