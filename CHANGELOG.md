# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `scripts/discover-local.ts` — read-only discovery script for the
  LAN-direct surfaces (mirrors `scripts/discover-network.ts` and
  `scripts/discover-protect.ts` but routes through `unifi.local.*` and
  `unifi.local.protect.*`). Reads the local API key from 1Password
  (`OP_LOCAL_REF`, default `op://AI Agents/Unifi local api key/password`)
  with env-var override.
- `scripts/verify-mutations.ts` — live mutation round-trip script
  (rename a DISCONNECTED Protect camera → GET-verify → revert →
  GET-verify). Hard pre-flight guards: refuses to run if camera is
  not DISCONNECTED, refuses if name already matches a stale-test
  pattern, runs revert in a separate `ExecuteExecutor` invocation
  with fatal exit codes if revert fails.

### Verified live

- **LAN-direct Network** (`unifi.local.*`) against a real UDM-Pro
  running Network 10.3.58. 67-op spec resolved; 1 site / 5 devices
  (UDM-Pro + 4 access points) / 2 WAN / 2 Wi-Fi / 32 wireless clients
  enumerated through 10 sandbox host calls in 608 ms. Sanitized
  transcript at `out/verification/local-network-live-smoke.txt`.
- **LAN-direct Protect** (`unifi.local.protect.*`) against the same
  UDM-Pro running Protect 7.0.107. 35-op official spec resolved;
  4 cameras returned in 162 ms — identical result to the cloud-Protect
  run on the same hardware (cross-confirms the wire path). Sanitized
  transcript at `out/verification/local-protect-live-smoke.txt`.
- **Mutation round-trip on Protect** (`PATCH /v1/cameras/{id}`)
  against the same UDM-Pro. Camera-rename → GET-verify → revert →
  GET-verify completed cleanly in three sequential `ExecuteExecutor`
  invocations (6 host calls total, ~5 s wall-clock). Sanitized
  transcript at `out/verification/mutation-live-smoke.txt`.
- **LLM-mediated invocation against the LAN-direct Network surface.**
  DeepSeek v4 Flash via opencode v1.14.30 drove `unifi.local.*`
  end-to-end against the same UDM-Pro at 172.27.1.1. The model used
  `unifi_search` to discover the right operationId
  (`getSiteOverviewPage`), then `unifi_execute` to call it via
  `callOperation`, returning site count `1` (matches the
  discover-local sweep). Self-corrected through 4 syntax attempts
  using the documented `[unifi.<surface>.<error-class>]` error-shape
  contract. Sanitized transcript at
  `out/verification/opencode-deepseek-local-mcp-call.txt`.
- **MCP Inspector (CLI mode)** against the same UDM-Pro. All four
  phases pass: `tools/list` returns full descriptors for both
  `search` and `execute`; credential-free `tools/call execute`
  returns the surface inventory; credentialled `tools/call search`
  returns live operations including the freshly compacted
  `aclRules` tag accessor; credentialled `tools/call execute`
  returns live site count `1`. Inspector pinned at v0.20.0 because
  v0.21.2 has a missing-`commander` dep on Node v25 (upstream issue,
  not ours). Sanitized transcript at
  `out/verification/mcp-inspector-live-smoke.txt`.

### Changed

- **Tag-name compaction for verbose API-doc boilerplate (BREAKING for
  tag-grouped accessors).** `normalizeTag` (in
  `src/spec/index-builder.ts`) now strips common Ubiquiti API-doc
  boilerplate suffixes (`information & management`, `management`,
  `integration`, `control & management`), prefers parenthetical
  aliases (`Access Control (ACL Rules)` → `aclRules`), and folds
  `Information about X` into `<X> info`. Net effect on the live
  Protect 7.0.107 spec:

  | Raw tag                              | Old accessor                       | New accessor          |
  |--------------------------------------|------------------------------------|-----------------------|
  | Camera information & management      | `cameraInformationManagement`      | `camera`              |
  | Camera PTZ control & management      | `cameraPtzControlManagement`       | `cameraPtz`           |
  | Chime information & management       | `chimeInformationManagement`       | `chime`               |
  | Light information & management       | `lightInformationManagement`       | `light`               |
  | NVR information & management         | `nvrInformationManagement`         | `nvr`                 |
  | Sensor information & management      | `sensorInformationManagement`      | `sensor`              |
  | Viewer information & management      | `viewerInformationManagement`      | `viewer`              |
  | Live view management                 | `liveViewManagement`               | `liveView`            |
  | Device asset file management         | `deviceAssetFileManagement`        | `deviceAssetFile`     |
  | Alarm manager integration            | `alarmManagerIntegration`          | `alarmManager`        |
  | Information about application        | `informationAboutApplication`      | `applicationInfo` ¹   |
  | Access Control (ACL Rules)           | `accessControlAclRules`            | `aclRules`            |

  ¹ Intentionally collides with Network's `Application Info` for
  cross-surface consistency. Operation IDs are unchanged — this is
  ONLY about the tag-grouped Proxy accessor name. Code that uses
  `unifi.local.protect.callOperation('cameraPtzPatrolStart', …)` or
  the operationId-keyed Proxy form continues to work without
  modification. 7 new unit tests cover the compaction logic; all 105
  tests green.
- `opencode.json` now passes `UNIFI_LOCAL_BASE_URL`,
  `UNIFI_LOCAL_API_KEY`, `UNIFI_LOCAL_INSECURE`, and
  `UNIFI_CLOUD_API_KEY` through to the spawned MCP server via
  opencode's `environment` block with `{env:VAR}` interpolation, so
  one `opencode run` can drive both LAN-direct and cloud surfaces
  without rewriting the config.
- `SKILL.md` and `examples/unifi-expert-agent/SKILL.md` now
  explicitly call out three sandbox-dialect gotchas surfaced by
  real-LLM verification: no top-level `return`, no top-level
  `await`, and the last-expression-as-return-value contract. This
  should reduce wrong-attempt counts on models that haven't been
  trained on QuickJS specifics.

### Fixed

- **Stale processed-spec caches were invisible to `normalizeTag`
  changes.** `src/spec/cache/*.json` stores the OUTPUT of
  `buildOperationIndex` (including pre-baked `primaryTag` strings),
  so today's tag-name compaction was invisible to anyone with a
  cached spec on disk. Fixed by adding a `cacheSchemaVersion` field
  (`CACHE_SCHEMA_VERSION = 2` in `src/spec/loader.ts`); a mismatch
  causes the loader to ignore the cache and refetch upstream. Bump
  `CACHE_SCHEMA_VERSION` on any future change to
  `buildOperationIndex` or `processSpec` shape. Discovered during
  the MCP Inspector live verification — the Inspector returned
  `accessControlAclRules` from the search index even after rebuilding
  the binary, which exposed the stale-cache bug.

### Discovered

- **Network mutations need polymorphic-discriminator extraction in
  the spec loader.** Every Network create endpoint exposed in
  Network 10.3.58 (`createAclRule`, `createDnsPolicy`,
  `createNetwork`, `createWifiBroadcast`,
  `createTrafficMatchingList`, `createFirewallZone`,
  `createFirewallPolicy`, `createVouchers`) returns
  `api.request.missing-type-id` on an empty body. The discriminator
  enum is in the OpenAPI spec but is not currently surfaced to the
  synthesizer. Live mutation verification on Network is therefore
  deferred until the loader extracts those enums (or we ship known-
  good fixture bodies per controller version).
- **Protect Integration API does not expose DELETE for liveviews.**
  `POST /v1/liveviews` accepts creates and `PATCH /v1/liveviews/{id}`
  works (with full schema), but `DELETE /v1/liveviews/{id}`,
  `DELETE /v1/liveviews?id=...`, and the non-Integration
  `/proxy/protect/api/liveviews/{id}` paths all 404 / 401. A liveview
  was inadvertently created during design probing of this verification
  pass; it's PATCHed to `name="_unused"` and `isGlobal=false`, but the
  maintainer needs to manually delete it from the Protect web UI
  (Protect → Live View → Manage Layouts → "_unused" → Delete).
  `verify-mutations.ts` therefore never creates liveviews.

### Documentation

- README "Project status" callout updated: 4-of-5 surfaces are now
  live-verified.
- README verification matrix gains two new rows for the LAN-direct
  sweeps; the "not yet verified" list and roadmap drop the local-
  Protect entries that are now satisfied and gain new entries for
  LLM-mediated LAN-direct invocation and mutation paths.
- Root `SKILL.md`, root `AGENTS.md`, and
  `examples/unifi-expert-agent/AGENTS.md` updated to reflect
  `unifi.local.*` and `unifi.local.protect.*` as live-verified.
- `examples/unifi-expert-agent/install.md` adds a surface-verification
  callout under the verification legend.

## [0.2.0-beta.1] — 2026-05-07

**Public beta.** Not published to npm; install from source for now (see
README "Quickstart"). The package is intentionally `"private": true` in
`package.json` to make accidental publishes impossible. We'll lift that
when the surface is fully live-verified and we tag `1.0.0`.

Five sandbox surfaces, live-verified against the maintainer's UDM-Pro
for both the cloud-Network and cloud-Protect paths, and end-to-end
LLM-mediated invocation verified through two clients (Cursor's
`cursor-agent` interactive PTY mode + opencode `--pure run`). Direct
local Protect, mutation operations, and other agent platforms (Claude
Code, Claude Desktop, VS Code + Copilot, Codex CLI, Continue, Cline,
MCP Inspector, …) are unverified — see [`SECURITY.md`](SECURITY.md)
and [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to report what you
find.

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
  bulky tag-grouped accessors like `cameraPtzControlManagement`
  could be compacted (resolved in `[Unreleased]` — see "Changed" above)
- Broaden the bundled Protect fallback beyond the current 18 ops, and/or
  expose binary surfaces (snapshots, RTSPS metadata, files) once the
  sandbox supports them
- Per-tenant rate limiting keyed on hashed credentials (currently per-IP)
- Optional persistent spec cache versioned by controller fingerprint
- Broader client validation — confirmed working configs for Claude
  Desktop, Continue, Cline, Aider, Zed, and the MCP Inspector UI

[Unreleased]: https://github.com/jmpijll/unifi-code-mode-mcp/compare/v0.2.0-beta.1...HEAD
[0.2.0-beta.1]: https://github.com/jmpijll/unifi-code-mode-mcp/releases/tag/v0.2.0-beta.1
