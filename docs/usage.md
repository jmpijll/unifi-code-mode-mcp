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

Run UniFi API calls inside the sandbox. Two namespaces: `unifi.local`, `unifi.cloud`.

> **Sync-style calls.** Inside the sandbox, calls to `unifi.local.<op>(...)` and `unifi.local.request(...)` appear synchronous (the host wraps async work transparently). You generally don't need `await`. The script's last expression is the tool result. Async/await IIFEs are also supported.

Surface:

```ts
unifi.local.<tag>.<operationId>(args)         // typed lookup
unifi.local.callOperation(operationId, args)  // flat lookup by id
unifi.local.request({ method, path, ... })    // raw escape hatch
unifi.local.spec                              // { title, version, sourceUrl, operationCount }
unifi.cloud.* (same shape)
```

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
// Cloud
var hosts = unifi.cloud.hosts.listHosts({});
hosts.data.length;
```

## Common gotchas

- **`(async function() {...})()`** — supported, but the host has to drain the in-VM microtask queue. Sync-style code is faster and easier to debug.
- **Missing credentials** — calls to a namespace without credentials throw inside the sandbox. Catch with `try/catch` if you want to handle gracefully.
- **TLS errors** — if your controller uses a self-signed cert, supply `X-Unifi-Local-Ca-Cert` (preferred) or set `X-Unifi-Local-Insecure: true`.
- **Result size** — large response bodies are truncated to 100 000 chars. Filter, paginate, or select fields server-side.

## Workflow

1. Use `search` to find the operation(s) you need (operationIds, parameter shapes).
2. Use `execute` to call them, batch, post-process, and return only what the user asked for.

This keeps the LLM's context small (~constant) regardless of how big the API is — the canonical Code Mode advantage.
