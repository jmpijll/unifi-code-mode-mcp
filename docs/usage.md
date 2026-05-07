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
| `unifi.local.protect.*` | controller API key | local Protect Integration API (cameras, NVRs, sensors, lights, alarm hubs, sirens, viewers, live-views, users) — needs Protect installed on the controller |
| `unifi.cloud.protect(consoleId).*` | Site Manager key | Protect API tunneled through the same Site Manager connector. **UNVERIFIED** against a real Protect deployment — see [protect-design.md](protect-design.md) |

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
