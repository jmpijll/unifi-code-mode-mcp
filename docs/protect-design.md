# UniFi Protect proxy — design note

Status: **shipping in v0.2.x, mock-verified, awaiting live-controller verification.**

This document describes how the UniFi Protect surface is added to the
server, what we have verified about it, and what we have not.

## 1. Goal

Mirror the existing two cloud surfaces with a third:

| Surface | Existing | New |
|---|---|---|
| Direct local Network API | `unifi.local.<tag>.<op>(args)` | unchanged |
| Cloud-native Site Manager | `unifi.cloud.<tag>.<op>(args)` | unchanged |
| Cloud-proxied Network API | `unifi.cloud.network(consoleId).<tag>.<op>(args)` | unchanged |
| **Direct local Protect API** | — | `unifi.local.protect.<tag>.<op>(args)` |
| **Cloud-proxied Protect API** | — | `unifi.cloud.protect(consoleId).<tag>.<op>(args)` |

Same Code-Mode pattern, same two-tool surface (`search` + `execute`),
same per-tenant credential plumbing.

## 2. What Ubiquiti publishes (recon, 2026-05-07)

| Asset | URL | Status |
|---|---|---|
| Network Integration API docs | `developer.ui.com/network/v<x>/...` | Published |
| Network OpenAPI specs | `apidoc-cdn.ui.com/network/v<x>/integration.json` | Published (selectively — only specific tagged versions; we probe a known-good list) |
| Site Manager API docs | `developer.ui.com/site-manager-api/applications` | Published |
| Site Manager OpenAPI | `apidoc-cdn.ui.com/site-manager/openapi.json` | **Not published** (we ship a curated `cloud-fallback.json`) |
| Site Manager → Network proxy | `api.ui.com/v1/connector/consoles/{id}/proxy/network/integration/...` | Verified working with our own UDM-Pro-Max + cloud key |
| **Protect Integration API docs** | `developer.ui.com/protect/v<x>/gettingstarted` | **Published** (e.g. `v7.0.107/gettingstarted`) |
| **Protect OpenAPI specs** | `apidoc-cdn.ui.com/protect/v<x>/integration.json` | **Published** (confirmed v7.0.107, v7.0.94 via HTTP HEAD; same selective-tag pattern as Network) |
| **Site Manager → Protect proxy** | `api.ui.com/v1/connector/consoles/{id}/proxy/protect/integration/...` | **Officially documented** by Ubiquiti (curl example in published docs); not yet exercised live by us, but structurally identical to the Network proxy we already use |

Reference: <https://developer.ui.com/protect/v7.0.107/gettingstarted>.
The official spec at `apidoc-cdn.ui.com/protect/v7.0.107/integration.json`
contains 25 paths across 12 tags (cameras + PTZ, NVRs, sensors, lights,
chimes, viewers, liveviews, alarm-manager webhooks, files, RTSPS streams,
talk-back sessions, subscribe/* WebSockets).

A community-extracted snapshot (`beezly/unifi-apis`, 7.1.46, 54 paths)
also exists on GitHub. We do **not** bundle it (no explicit license),
but we expose `UNIFI_PROTECT_SPEC_URL` for users who want a different
spec — the official URL is the recommended override target.

## 3. What we ship

### 3.1 Bundled fallback (last resort only)

`src/spec/protect-fallback.json` — a curated, hand-written OpenAPI 3.1
fragment for ~18 JSON-over-HTTP operations that exist in **both** the
two confirmed-published versions (v7.0.94 and v7.0.107):

- `meta` — `getProtectMetaInfo` (used for version discovery)
- `cameras` — list, get, snapshot, disable-mic-permanently, ptz/goto, ptz/patrol/start, ptz/patrol/stop
- `nvrs` — list
- `sensors` — list, get
- `lights` — list, get
- `chimes` — list, get
- `viewers` — list, get
- `liveviews` — list, get

Deliberately excluded from the fallback (available via the official
spec when the loader can reach `apidoc-cdn.ui.com`):

- `alarm-manager/webhook/{id}` — non-stream, but trigger-only and rare.
- `files/{fileType}` — binary download, current `HttpClient` is JSON-only.
- `cameras/{id}/rtsps-stream` — returns stream metadata; UX needs design.
- `cameras/{id}/talkback-session` — bidirectional audio, separate work.
- `subscribe/{events,devices}` — WebSocket, separate work.

### 3.2 Spec loader

Same pattern as the Network loader:

1. If `UNIFI_PROTECT_SPEC_URL` is set, fetch it (full override).
2. Try `apidoc-cdn.ui.com/protect/v<discovered>/integration.json`,
   where `<discovered>` comes from `GET /proxy/protect/integration/v1/meta/info`
   on the controller.
3. Try `apidoc-cdn.ui.com/protect/v<known>/integration.json` for each
   tag in `KNOWN_PROTECT_SPEC_VERSIONS = ['7.0.107', '7.0.94']`.
4. If `UNIFI_PROTECT_ALLOW_BEEZLY_FALLBACK=true`, try the beezly raw URL.
5. Else load the bundled `protect-fallback.json`.

### 3.3 HTTP clients

- `createLocalProtectClient(creds)` — `pathPrefix: '/proxy/protect/integration'`,
  same TLS handling as the Network local client (strict by default,
  per-tenant CA / insecure opt-out).
- `createCloudProtectProxyClient(creds, consoleId)` — `pathPrefix:
  '/v1/connector/consoles/${id}/proxy/protect/integration'`, same auth
  as the Network cloud proxy (`X-API-Key` from `creds.apiKey`). The
  `/connector/consoles/{id}/proxy/protect/integration/...` URL pattern
  is officially documented by Ubiquiti.

### 3.4 Sandbox surface

Mirrors the Network proxy emit pattern in `src/sandbox/dispatch.ts`.
Two additions to the prelude (only emitted when a Protect spec is
loaded):

```js
unifi.local.protect = {
  spec: { title, version, sourceUrl, operationCount },
  request, callOperation,
  cameras: { listCameras, getCamera, getSnapshot, ... },
  // ...one tag bucket per Protect tag...
};

unifi.cloud.protect = function(consoleId) { ...same shape as cloud.network... };
```

Only attached when **both** the Protect spec is loaded **and** the
relevant credentials are present (`tenant.local` for `unifi.local.protect`,
`tenant.cloud` for `unifi.cloud.protect`).

### 3.5 Error taxonomy

New error tags, matching the existing pattern:

- `[unifi.local.protect.http]`
- `[unifi.local.protect.missing-credentials]`
- `[unifi.local.protect.unknown-operation]`
- `[unifi.local.protect.error]`
- `[unifi.cloud.protect.http]`
- `[unifi.cloud.protect.missing-credentials]`
- `[unifi.cloud.protect.unknown-operation]`
- `[unifi.cloud.protect.error]`

If a controller does not have the Protect application installed, calls
will fail with `404` from the controller; we map this to a clear
`[unifi.local.protect.http] 404 ... — is the Protect application installed
on this controller?` style message.

## 4. Verification status

What we **have** verified:

- Unit tests against `protect-fallback.json` (loader, dispatcher, prelude
  emission, error formatting). 94 tests, all passing.
- Mock-controller integration tests (Scenario D) — drive the new prelude
  through `InMemoryTransport` for `getProtectMetaInfo`, `listCameras`,
  `getCamera`.
- HTTP HEAD probes confirm `apidoc-cdn.ui.com/protect/v7.0.107/integration.json`
  and `v7.0.94/integration.json` are 200, identifying which CDN tags
  the loader can rely on.
- The Site Manager → Protect proxy URL pattern is officially documented
  by Ubiquiti (`developer.ui.com/protect/v7.0.107/...`).

What is **not yet** verified (needs a Protect deployment):

- That a real Protect 7.x controller responds the way our hand-written
  fallback says it does, when the loader can't reach the CDN.
- That `unifi.cloud.protect(consoleId).<tag>.<op>(args)` works against
  a real Protect-enabled console via the `api.ui.com` cloud connector.
  Structurally identical to the Network cloud proxy we already use; the
  curl path pattern matches what the loader emits; but no live-fire
  smoke test yet.

These will be marked **mock-verified, live-pending** in the README
verification table until someone with a Protect deployment proves them.

## 5. Out of scope (this iteration)

- WebSocket event subscription (`/v1/subscribe/events`, `/v1/subscribe/devices`)
  — needs a real WebSocket transport in the sandbox, separate work.
- Camera RTSPS stream URLs (`/v1/cameras/{id}/rtsps-stream`) — handled
  by the official spec when loaded, but the sandbox's binding pattern
  is JSON-shaped; UX needs design.
- File downloads (`/v1/files/{fileType}`) — needs binary streaming, the
  current `HttpClient` only handles JSON.
- Talk-back sessions (`/v1/cameras/{id}/talkback-session`) — bidirectional
  audio, separate work.

## 6. Naming choice

We considered renaming `unifi.local.*` → `unifi.local.network.*` so that
adding `unifi.local.protect.*` would feel symmetric. We rejected this:
it is a breaking change for every existing caller, and the
`unifi.local.<networkTag>` namespace has no current overlap with
Protect's `<tag>` namespace (Protect tags are `cameras`, `nvrs`,
`sensors`, etc.; Network tags are `Sites`, `Devices`, `WiFi
Configurations`, etc.). We can revisit if a real conflict appears.

## 7. Open questions for a future contributor

- Does Ubiquiti's cloud connector support proxying additional
  applications (`access`, `talk`, `connect`, `drive`, `mobility`)?
  If yes, we should generalise `createCloudNetworkProxyClient` and
  `createCloudProtectProxyClient` into a single
  `createCloudAppProxyClient(creds, consoleId, app)` factory.
- Should we extend the curated fallback to cover the alarm-manager
  webhook trigger? It's small and useful, but the dynamic CDN load
  already covers it for any Protect-enabled controller.
