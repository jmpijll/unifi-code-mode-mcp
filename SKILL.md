---
name: unifi-code-mode-mcp
description: >-
  Drive UniFi Network and UniFi Site Manager deployments through the
  Code-Mode MCP server's two tools (search and execute). Use when the user
  asks about a UniFi controller, site, console, device, network, VLAN,
  Wi-Fi broadcast, firewall zone, ACL, DNS policy, RADIUS, VPN, or any
  inspection or change against UniFi Network or api.ui.com.
---

# UniFi Code-Mode MCP — operating manual

The server exposes only **two tools** and a sandboxed JavaScript runtime.
You drive the entire UniFi API surface by *writing JavaScript that the
sandbox executes*, not by calling per-endpoint tools. This guide tells you
how to do that effectively.

## 1. The two tools

| Tool | Purpose | Sandbox kind |
|---|---|---|
| `search` | Search the OpenAPI catalogue for operationIds, paths, summaries, parameters. | Sync. Returns a JSON list of operations. |
| `execute` | Run JavaScript that calls the UniFi APIs through the sandbox. Returns whatever your script's last expression evaluates to. | Async (host calls appear sync). |

You always start with `search` to find the operationIds you need, then
`execute` to call them. **Never invent operationIds** — always confirm with
`search` first; the spec changes per controller version.

## 2. Five sandbox surfaces

Inside `execute`, the global `unifi` namespace exposes up to five surfaces.
Any surface may be missing if its credentials or spec are not configured —
check `unifi.<surface>.spec` for `{ title, version, sourceUrl }` before
relying on it.

| Surface | Reaches | Credentials |
|---|---|---|
| `unifi.local.*` | A local UniFi controller's Network Integration API (`https://<controller>/proxy/network/integration/v1/...`). | Local API key. |
| `unifi.cloud.*` | UniFi Site Manager (`https://api.ui.com/v1/...`). | Cloud API key. |
| `unifi.cloud.network(consoleId).*` | The Network Integration API of a remote console, **proxied through Site Manager** (`/v1/connector/consoles/{id}/proxy/network/integration`). | **Cloud** API key only. |
| `unifi.local.protect.*` | A local controller's UniFi Protect Integration API (`https://<controller>/proxy/protect/integration/v1/...`) — cameras + PTZ, NVRs, sensors, lights, chimes, viewers, live-views, plus the full official surface when the loader can fetch `apidoc-cdn.ui.com/protect/v<version>/integration.json`. | Local API key (Protect must be installed on the controller). |
| `unifi.cloud.protect(consoleId).*` | Protect Integration API tunneled through the Site Manager connector at `/v1/connector/consoles/{id}/proxy/protect/integration`. URL pattern is officially documented by Ubiquiti (`developer.ui.com/protect/v7.0.107/...`, "Remote" base-URL selector). | Cloud API key only. |

Pick the surface based on what the user has:

- **Local controller, on the same LAN as the MCP host, Network only.** → `unifi.local`.
- **Local controller, with Protect installed.** → `unifi.local` for Network, `unifi.local.protect` for cameras/sensors/lights/etc.
- **Cloud-managed console, you only have a cloud API key.** →
  `unifi.cloud.network(consoleId)` for Network ops; `unifi.cloud` for
  Site-Manager-only ops (multi-console listing, ISP metrics, SD-WAN);
  `unifi.cloud.protect(consoleId)` for Protect (live-verified against a
  real UDM-Pro running Protect 7.0.107 — see §10).
- **Multiple consoles under one Site Manager account.** → discover them
  with `unifi.cloud.callOperation('listHosts')` (or
  `request('GET', '/v1/hosts')`) and then build per-console proxies.

## 3. Each surface offers three call shapes

```js
// 1. Typed-ish operationId call (preferred — readable, future-proof)
const sites = unifi.local.callOperation('getSiteOverviewPage', {
  pageSize: 100,
});

// 2. Tag-grouped accessor (Proxy sugar for the same operation)
//    e.g.  unifi.local.sites.getSiteOverviewPage(...)
const sites2 = unifi.local.sites.getSiteOverviewPage({ pageSize: 100 });

// 3. Raw escape hatch (use when the spec doesn't cover what you need)
const raw = unifi.local.request({
  method: 'GET',
  path: '/v1/sites',
  query: { pageSize: 100 },
});
```

The first form is the default. Reach for `request()` only when the spec
genuinely doesn't cover the call you need — that's a signal to also
`search` for a real operation.

## 4. The `search → execute` loop

Standard recipe — follow it every time:

```text
1. Call search("<keywords>") with the user's question keywords.
2. Read the operationIds, methods and paths in the result.
3. Construct ONE execute() script that:
     a. fetches what you need with callOperation,
     b. shapes the result (pick fields, aggregate counts, build a table),
     c. returns a small final object — not raw payloads.
4. Format the final object for the user.
```

**Do not** call `execute` once per operation in a loop of separate tool
calls. One script, many host calls. The sandbox call budget per `execute`
is generous (default 50, lifted to 200 in operational scripts), so batch.

## 5. Error taxonomy

Errors raised inside the sandbox are pre-formatted with a stable prefix:

| Prefix | Meaning | What to do |
|---|---|---|
| `[unifi.<surface>.http]` | The UniFi API returned a non-2xx response. The HTTP status and body excerpt are appended. | Read the message; common causes are missing perms, missing feature (e.g. `zone-based-firewall-not-configured`), or a wrong `siteId`. |
| `[unifi.<surface>.transport]` | Network-layer failure (DNS, TLS, connection reset). | Re-run the same script — it's likely transient. If repeating, suspect TLS config (custom CA missing or hostname mismatch). |
| `[unifi.<surface>.missing-credentials]` | The required tenant key is not configured. | Stop and ask the user to set the appropriate header / env var. The error message names the missing field. |
| `[unifi.<surface>.budget]` | Your script exceeded the per-execute call budget. | Reduce calls (skip per-device details for a high-level view) or run two `execute` calls. |

**Always wrap risky calls in `try/catch`** when traversing many sites or
devices, so one failure doesn't lose the rest of the snapshot:

```js
try {
  site.firewallZones = unifi.local.callOperation('getFirewallZones', { siteId });
} catch (e) {
  site.firewallZones_error = String(e);
}
```

## 6. Picking up the user's intent — a decision tree

```text
User asks for a *summary* / *audit* / *inventory*
→ One execute() that fans out across getSiteOverviewPage,
  getAdoptedDeviceOverviewPage, getNetworksOverviewPage,
  getWifiBroadcastPage, etc. Aggregate, return a table-shaped object.
  Reference: scripts/discover-network.ts in the repo.

User asks for a *single fact* ("what firmware is the AP in the bedroom?")
→ search('device firmware'), then a tiny execute() that filters by name.

User asks for a *change* ("disable the L2TP VPN", "rotate Yuki Pro PSK")
→ search('vpn server' or 'wifi broadcast'), confirm the PUT/PATCH/DELETE
  operationId, run a *read-only* execute first to print the current
  state and the new payload you intend to send, ask the user to confirm,
  THEN run the mutating execute().

User asks for something the API doesn't expose (legacy firewall rules,
DHCP options, port profiles, mDNS reflector, etc.)
→ Say so. Cite the limitation. Suggest the UniFi UI. Don't fabricate.
```

## 7. Performance and budget

| Operation kind | Approximate cost |
|---|---|
| One `callOperation` / `request` round-trip to a local controller | 100–300 ms |
| Same against `api.ui.com` / cloud-network proxy | 300–800 ms (TLS + edge hop) |
| Default per-`execute` call budget | 50 host calls |
| Default per-`execute` wall-clock timeout | 30 s |

Rough sizing:

- "Tell me about my network" against a 1-site / 5-device home setup
  → ~25 calls, ~20 s on the cloud proxy.
- Same against a 10-site / 200-device deployment
  → split into two or three `execute` calls (sites first, then devices in
  batches), or ask the operator to lift `maxCallsPerExecute`.

## 8. Multi-tenant calling

If the host is configured for multi-tenant HTTP transport, your client
provides credentials via headers on each MCP request:

```text
X-Unifi-Local-Api-Key       (required for unifi.local.*)
X-Unifi-Local-Base-Url       (required for unifi.local.*)
X-Unifi-Local-Ca-Cert        (optional PEM; alternatively *-Ca-Cert-Path)
X-Unifi-Local-Insecure       (optional, "true" to skip TLS verify; warns)
X-Unifi-Cloud-Api-Key        (required for unifi.cloud.* and cloud.network)
X-Unifi-Cloud-Base-Url       (optional override; default api.ui.com)
```

Single-tenant deployments use the equivalent env vars (`UNIFI_LOCAL_*`,
`UNIFI_CLOUD_*`).

In Cursor IDE / Cursor CLI specifically, headers are static per server
entry in `mcp.json` (no per-request header injection). To address several
tenants from a single Cursor session, register one MCP server entry per
tenant — see [docs/cursor-skill.md](docs/cursor-skill.md).

## 9. Common recipes

### 9.1 Pick the right surface from a single cloud API key

```js
// Discover consoles, then build a network proxy for the first one.
const hosts = unifi.cloud.request({ method: 'GET', path: '/v1/hosts' });
const consoleId = hosts.data?.[0]?.id;
const net = unifi.cloud.network(consoleId);
// Now drive net.* exactly like unifi.local.*
```

### 9.2 List sites and counts in one round-trip

```js
const net = unifi.cloud.network(consoleId);
const sites = net.callOperation('getSiteOverviewPage', { pageSize: 100 }).data;
sites.map((s) => ({
  id: s.id,
  name: s.name,
  devices: net.callOperation('getAdoptedDeviceOverviewPage', { siteId: s.id, pageSize: 200 }).data?.length ?? 0,
  networks: net.callOperation('getNetworksOverviewPage', { siteId: s.id, pageSize: 100 }).data?.length ?? 0,
}));
```

### 9.3 Find the operation for a question you can't phrase

```text
search "ssid password psk wifi"
search "firewall rule policy"
search "firmware update device"
```

The `search` tool ranks by both `operationId` and `summary`, so natural
phrasing works. Look at the `path` and `description` to confirm.

### 9.4 Read the connected-client view safely

```js
const page = unifi.local.callOperation('getConnectedClientOverviewPage', {
  siteId,
  pageSize: 200,
});
const wireless = (page.data ?? []).filter((c) => c.type === 'WIRELESS');
const wired    = (page.data ?? []).filter((c) => c.type === 'WIRED');
({ total: page.totalCount ?? page.data?.length ?? 0, wireless: wireless.length, wired: wired.length });
```

### 9.5 Confirm before mutating

```js
// Step 1 — READ the current state in one execute() and present to the user.
const current = unifi.local.callOperation('getWifiBroadcastDetails', {
  siteId, wifiBroadcastId: id,
});
({ current });

// Step 2 — only after the user approves, run a SECOND execute() with PUT.
unifi.local.callOperation('updateWifiBroadcast', {
  siteId, wifiBroadcastId: id,
  body: { ...current, securityConfiguration: { type: 'WPA2_PERSONAL', passphrase: '<new>' } },
});
```

### 9.6 Inventory Protect cameras and pull a single camera detail

```js
// Local Protect — works whenever the controller has Protect installed.
const meta = unifi.local.protect.callOperation('getProtectMetaInfo', {});
const cams = unifi.local.protect.cameras.listCameras({});
const detail = cams.data.length > 0
  ? unifi.local.protect.cameras.getCamera({ id: cams.data[0].id })
  : null;
({
  protectVersion: meta.applicationVersion,
  cameraCount: cams.data.length,
  firstCamera: detail ? { name: detail.name, model: detail.type, state: detail.state } : null,
});
```

For the cloud-proxied variant (live-verified against a real UDM-Pro
running Protect 7.0.107):

```js
const protect = unifi.cloud.protect(consoleId);
const cameras = protect.callOperation('listCameras', {});
cameras.data.length;
```

If you do see `[unifi.cloud.protect.http] 404` against a real console,
the most likely cause is that Protect is not installed on that
particular console, not that the connector path is wrong. Fall back to
`unifi.local.protect` through a direct controller connection if you
have LAN reachability.

## 10. Caveats and known unknowns

- **OpenAPI version drift is normal.** Ubiquiti's CDN only hosts a few
  tagged spec versions (currently `v10.1.84`). Controllers run ahead.
  The server transparently falls back to the closest known version, so
  some operationIds the controller actually accepts may be absent from
  `search`. When in doubt, try the call — `[unifi.local.http]` errors
  are explicit when an operationId/path doesn't exist.
- **Legacy firewall rules are not in the v1 Integration API.** If
  `getFirewallZones` / `getFirewallPolicies` return
  `api.firewall.zone-based-firewall-not-configured`, the site is on the
  legacy rule-based firewall and the v1 surface can't enumerate the
  individual rules. Don't claim "no rules exist" — claim "the API
  doesn't expose them on this site".
- **What the Network v1 Integration API does *not* expose:** legacy
  firewall rules, DHCP options, port profiles, PoE profiles, mDNS
  reflector, rogue-AP scan results, RADIUS clients (the binding is
  exposed; secrets are not), WireGuard peer lists, Talk/Access state.
  Protect is exposed via its own Integration API at
  `/proxy/protect/integration/v1/...` (use `unifi.local.protect`).
- **Protect surfaces — what's verified, what's not.** The loader
  auto-fetches Ubiquiti's official spec at
  `apidoc-cdn.ui.com/protect/v<version>/integration.json` (confirmed
  v7.0.107 and v7.0.94); when reachable you get the full ~25-path
  surface across cameras, NVRs, sensors, lights, chimes, viewers,
  liveviews, alarm-manager webhooks, files, RTSPS streams, talk-back,
  and `subscribe/*` WebSockets. When the CDN is unreachable, the
  bundled fallback covers ~18 JSON-over-HTTP ops. To override:
  `UNIFI_PROTECT_SPEC_URL=<full-spec>`.
- **`unifi.cloud.protect(consoleId)` is verified on real hardware**
  against a UDM-Pro running Protect 7.0.107 (read-only sweep,
  2026-05-07 — see `out/verification/cloud-protect-live-smoke.txt`).
- **`unifi.local.protect.*` is also verified on real hardware** against
  the same UDM-Pro (read-only sweep, 2026-05-07 — see
  `out/verification/local-protect-live-smoke.txt`). Returned identical
  4-camera result to the cloud-Protect run on the same controller.
- **`unifi.local.*` is verified on real hardware** against a UDM-Pro
  running Network 10.3.58 (read-only sweep, 2026-05-07 — 1 site / 5
  devices / 2 WAN / 2 Wi-Fi / 32 clients enumerated, see
  `out/verification/local-network-live-smoke.txt`).
- **Mutations on every surface (Network and Protect) are wired but not
  yet exercised live.** The 2026-05-07 live sweeps were read-only:
  Network listed sites/networks/wifi/devices/clients, Protect called
  `getProtectMetaInfo` and `listCameras`. PATCH/POST/DELETE on Network
  resources, PTZ commands, `disableCameraMicPermanently`, and the
  alarm-manager webhook trigger are wired through the spec but unproven
  against real hardware.
- **Binary/streaming Protect ops** (snapshot bytes, RTSPS streams,
  talk-back, `subscribe/*` WebSockets) are present in the spec but the
  JSON-only `HttpClient` doesn't speak them yet.
- **Tag namespacing differs between fallback and CDN-loaded specs.**
  The fallback uses short tags (`cameras`, `nvrs`, `meta`); the
  official spec uses verbose tags like `"Camera PTZ control &
  management"` which normalize to `cameraPtzControlManagement`. When
  in doubt, use `unifi.local.protect.callOperation('<opId>', args)`
  (flat lookup) or `request({ method, path })` (path-based, naming-
  agnostic) instead of typed tag.method() lookups.
- **Snapshots in this repo's `out/` folder contain MAC and IP material**
  and are gitignored. Do not paste them into chats unless the user is
  the network owner.
- **Pre-1.0 client coverage is narrow.** The MCP wire protocol has
  been verified end-to-end with two clients:
  - Claude Sonnet 4.6 through `cursor-agent` interactive PTY mode.
  - DeepSeek v4 Flash through `opencode --pure run`.

  See [README → Verification status](README.md#verification-status)
  for the matrix and known per-client gotchas (`docs/cursor-skill.md`
  §8 and `docs/opencode-skill.md` §6). It has *not* yet been validated
  against the Cursor IDE chat panel, Claude Desktop, Continue, Cline,
  Codeium, Aider, Zed, or the MCP Inspector UI. If you find a client
  where the server misbehaves, open an issue with the protocol log;
  the server itself is wire-correct, so most surprises will be in
  client wiring or env-var passing.

## 11. Where to look for more

- [README.md](README.md) — project overview and deployment.
- [AGENTS.md](AGENTS.md) — for *contributors* editing the server itself.
- [docs/usage.md](docs/usage.md) — how to install and run the server.
- [docs/cursor-skill.md](docs/cursor-skill.md) — how to wire the server
  into Cursor IDE and Cursor CLI, including multi-tenant.
- [scripts/discover-network.ts](scripts/discover-network.ts) — a real,
  end-to-end example of the search → execute loop driving the cloud-network
  proxy across every section of a deployment.
