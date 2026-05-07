# UniFi Protect proxy — design note

Status: **proposed, partially verified**. Built into v0.2.x.

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

## 2. What Ubiquiti publishes (recon, 2026-05)

| Asset | URL | Status |
|---|---|---|
| Network Integration API docs | `developer.ui.com/network/v<x>/...` | Published |
| Network OpenAPI specs | `apidoc-cdn.ui.com/network/v<x>/integration.json` | Published |
| Site Manager API docs | `developer.ui.com/site-manager-api/applications` | Published |
| Site Manager OpenAPI | `apidoc-cdn.ui.com/site-manager/openapi.json` | **Not published** (we ship a curated `cloud-fallback.json`) |
| Site Manager → Network proxy | `api.ui.com/v1/connector/consoles/{id}/proxy/network/integration/...` | Verified working with our own UDM-Pro-Max + cloud key |
| **Protect Integration API docs** | `developer.ui.com/protect/...` | **Not published** |
| **Protect OpenAPI specs** | `apidoc-cdn.ui.com/protect/v<x>/integration.json` | **Probably not published** (HEAD probe is 404) |
| **Site Manager → Protect proxy** | `api.ui.com/v1/connector/consoles/{id}/proxy/protect/integration/...` | **Unverified** — structurally analogous to Network's, but Ubiquiti has not documented it |

A community-extracted OpenAPI document (`beezly/unifi-apis`, OpenAPI 3.1.0,
54 paths, latest 7.1.46) is available on GitHub. It is extracted directly
from real Protect controllers. We do **not** bundle it into this repo
(no explicit license), but we expose `UNIFI_PROTECT_SPEC_URL` so users
who want the full surface can point the loader at any URL of their
choice (including the beezly raw file).

## 3. What we ship

### 3.1 Bundled fallback

`src/spec/protect-fallback.json` — a curated, hand-written OpenAPI 3.1
fragment for the most commonly-used Protect operations:

- `meta` — `getProtectMetaInfo` (used for version discovery)
- `cameras` — list, get, snapshot, ptz/goto, ptz/patrol/start, ptz/patrol/stop
- `nvrs` — list
- `sensors` — list, get
- `lights` — list, get
- `chimes` — list, get
- `alarm-hubs` — list, get
- `sirens` — list, get, play, stop
- `viewers` — list, get
- `liveviews` — list, get
- `users` — list, get

Roughly 25 operations. Enough to be immediately useful for monitoring
and basic control, hand-written from the Ubiquiti app's behaviour and
publicly visible internal API patterns.

### 3.2 Spec loader

Same pattern as the Network loader:

1. If `UNIFI_PROTECT_SPEC_URL` is set, fetch it (full override).
2. Else try `apidoc-cdn.ui.com/protect/v<discovered-version>/integration.json`.
3. Else try the well-known beezly raw URL **only if** the user opts in
   via `UNIFI_PROTECT_SPEC_FROM_BEEZLY=true` (off by default).
4. Else load the bundled `protect-fallback.json`.

Version discovery: call `GET /proxy/protect/integration/v1/meta/info` on
the controller (the Protect equivalent of Network's `/v1/info`).

### 3.3 HTTP clients

- `createLocalProtectClient(creds)` — `pathPrefix: '/proxy/protect/integration'`,
  same TLS handling as the Network local client (strict by default,
  per-tenant CA / insecure opt-out).
- `createCloudProtectProxyClient(creds, consoleId)` — `pathPrefix:
  '/v1/connector/consoles/${id}/proxy/protect/integration'`, same auth
  as the Network cloud proxy (`X-API-Key` from `creds.apiKey`).

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

## 4. Verification plan

What we **can** verify in CI:

- Unit tests against `protect-fallback.json` (loader, dispatcher, prelude
  emission).
- Mock-controller integration tests (the same harness we built for
  Network) — drive the new prelude through `InMemoryTransport` and
  Streamable HTTP.

What we **cannot** verify without a Protect deployment:

- That `apidoc-cdn.ui.com/protect/...` actually exists.
- That the cloud connector proxy at
  `api.ui.com/v1/connector/consoles/{id}/proxy/protect/integration/...`
  actually works (structurally we expect it to; Ubiquiti hasn't
  documented it).
- That a real Protect 7.x controller responds the way our hand-written
  fallback spec says it does.

These will go into the README "Verification status" table as
**unverified** until someone with a Protect deployment proves them.

## 5. Out of scope (this iteration)

- WebSocket event subscription (`/v1/subscribe/events`, `/v1/subscribe/devices`)
  — needs a real WebSocket transport in the sandbox, separate work.
- Camera RTSPS stream URLs (`/v1/cameras/{id}/rtsps-stream`) — same.
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

- Does `apidoc-cdn.ui.com` host Protect specs under any URL pattern?
  (Currently we assume not.)
- Does Ubiquiti's cloud connector support proxying additional
  applications (`access`, `talk`, `connect`, `drive`, `mobility`)?
  If yes, we should generalise `createCloudNetworkProxyClient` and
  `createCloudProtectProxyClient` into a single
  `createCloudAppProxyClient(creds, consoleId, app)` factory.
