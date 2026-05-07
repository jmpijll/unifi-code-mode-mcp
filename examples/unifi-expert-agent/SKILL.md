---
name: unifi-expert-agent
description: >-
  Drive UniFi Network, Site Manager, and Protect through the
  unifi-code-mode-mcp server while operating as a senior UniFi network
  engineer. Use whenever the user mentions a controller, console, site,
  device, VLAN, Wi-Fi, firewall zone, ACL, RADIUS, VPN, camera, NVR,
  PTZ, or anything else the UniFi APIs cover.
---

# UniFi expert — operating manual

This is the **persona's** companion to the server's
[root SKILL.md](../../SKILL.md). The root file is exhaustive and
vendor-neutral; this one is focused on how the **UniFi expert agent**
(see [`AGENTS.md`](AGENTS.md)) actually works through the two MCP tools.

## The two-tool contract

| Tool | Use it to |
|---|---|
| `search` | Find an operationId before you call it. Always. Both tools accept a single `code` string. Inside that code you call the in-sandbox helper `searchOperations(namespace, query, limit?)` where `namespace` is `'local'`, `'cloud'`, or `'protect'` (cloud-proxied surfaces share specs with their local twins). Default to `limit: 5` and a tight keyword. |
| `execute` | Run JavaScript that calls UniFi via the `unifi.*` global. Last expression's value is returned to you. |

### Sandbox dialect — three rules that catch most LLMs

1. **No top-level `return`.** Make the result an expression statement
   (e.g. `cam.name;` not `return cam.name;`).
2. **No top-level `await`.** Host calls block the QuickJS VM
   synchronously. Drop the `await`. If you need real async (e.g.
   `Promise.all`), wrap in an async IIFE: `(async () => { … })()`.
3. **The value of the last expression is what's returned to the
   caller.** That's it. No `module.exports`, no implicit JSON
   serialisation, no `console.log` capture into the result (logs are
   captured into a separate warnings list).

## The five sandbox surfaces

```text
unifi
├── local            // (alias of unifi.local.network) LAN UniFi Network
├── local.network    // explicit form
├── local.protect    // LAN UniFi Protect
├── cloud            // Site Manager native (api.ui.com/v1/*)
├── cloud.network    // (consoleId) -> remote Network proxy
└── cloud.protect    // (consoleId) -> remote Protect proxy
```

Each surface offers three call shapes (in order of preference):

```js
// 1. Typed-ish operationId call (preferred — readable, future-proof)
const sites = unifi.local.sites.listSites();

// 2. Named operationId via callOperation (when the namespace is fuzzy)
const hosts = unifi.cloud.callOperation('listHosts');

// 3. Path-based escape hatch (when no operationId fits)
const meta = unifi.cloud.protect('CONSOLE').request({
  method: 'GET',
  path: '/v1/meta/info',
});
```

Always check `unifi.<surface>.spec` first if you're not sure the surface
is loaded. Because top-level `return` is a syntax error in QuickJS,
either short-circuit with a ternary or wrap the whole script in an
IIFE:

```js
// Pattern A — ternary on the last expression
unifi.cloud && unifi.cloud.spec
  ? unifi.cloud.callOperation('listHosts').data.length
  : { error: 'No cloud credential configured for this tenant' };
```

```js
// Pattern B — IIFE so you can `return` early
(function () {
  if (!unifi.cloud || !unifi.cloud.spec) {
    return { error: 'No cloud credential configured for this tenant' };
  }
  return unifi.cloud.callOperation('listHosts').data.length;
})();
```

## Default workflow for any new task

1. **Restate.** Confirm the user's goal in one sentence to make sure you
   understood. (You don't need to send this — just frame your own work.)
2. **Pick a surface** based on what credentials the user has (see
   [`AGENTS.md`](AGENTS.md) §3).
3. **Search** for the operationId you need (or two — list + detail).
4. **Probe small.** Call `execute` with a single read against one site
   or one console. Inspect the shape.
5. **Scale up.** If the probe was clean, expand to the full inventory.
6. **Synthesise.** Return structured data, not a stream of side-effects.
7. **Report.** Tell the user what you did, what you found, what you
   skipped, and what's next.

## High-leverage recipes

These are the tasks the persona is expected to do well. Each shows the
preferred call shape; substitute path-based `request()` if your
controller's spec uses different operationIds.

> **Reminder:** every recipe below is an `execute` script. Top-level
> `return` would be a `SyntaxError: return not in a function` in
> QuickJS, so each recipe ends with the result expression directly. If
> you genuinely need an early return, wrap the whole body in an IIFE
> (`(function () { … })()`).

### Inventory a single console (read-only)

```js
var hosts = unifi.cloud.callOperation('listHosts').data;
var consoleEntry = hosts.find(function (h) { return h.id === args.consoleId; });
var net = unifi.cloud.network(args.consoleId);
var sites = net.sites.listSites();
var devices = sites.flatMap(function (site) {
  return net.devices.listAdoptedDevices({ siteId: site.id }).map(function (d) {
    return {
      site: site.name,
      name: d.name,
      model: d.model,
      macAddress: d.macAddress,
      ipAddress: d.ipAddress,
      state: d.state,
      firmwareVersion: d.firmwareVersion,
    };
  });
});
({
  console: consoleEntry && consoleEntry.reportedState ? consoleEntry.reportedState.name : args.consoleId,
  sites: sites.length,
  devices: devices,
});
```

### Audit firmware drift

```js
var net = unifi.cloud.network(args.consoleId);
var sites = net.sites.listSites();
var drift = [];
for (var i = 0; i < sites.length; i++) {
  var site = sites[i];
  var devs = net.devices.listAdoptedDevices({ siteId: site.id });
  for (var j = 0; j < devs.length; j++) {
    var d = devs[j];
    if (d.firmwareUpdatable) {
      drift.push({
        site: site.name,
        name: d.name,
        model: d.model,
        firmwareVersion: d.firmwareVersion,
      });
    }
  }
}
({ totalSites: sites.length, drift: drift });
```

### High-level design (HLD)

```js
var consoles = unifi.cloud.callOperation('listHosts').data;
consoles.map(function (c) {
  var net = unifi.cloud.network(c.id);
  var sites = net.sites.listSites();
  return {
    console: c.reportedState && c.reportedState.name ? c.reportedState.name : c.id,
    sites: sites.map(function (s) {
      var devs = net.devices.listAdoptedDevices({ siteId: s.id });
      var counts = {};
      for (var k = 0; k < devs.length; k++) {
        var m = devs[k].model;
        counts[m] = (counts[m] || 0) + 1;
      }
      return { name: s.name, deviceCounts: counts };
    }),
  };
});
```

### Inventory cameras (Protect)

```js
var p = unifi.cloud.protect(args.consoleId);
var cameras = p.request({ method: 'GET', path: '/v1/cameras' });
cameras.map(function (c) {
  return {
    id: c.id,
    name: c.name,
    modelKey: c.modelKey,
    state: c.state,
    firmwareVersion: c.firmwareVersion,
    isMicEnabled: c.isMicEnabled,
  };
});
```

### Confirm-before-mutate (PTZ goto preset)

```js
// READ-FIRST script: tells the user what we're about to do.
// IIFE so we can early-return without violating the no-top-level-return rule.
(function () {
  var p = unifi.cloud.protect(args.consoleId);
  var cam = p.request({ method: 'GET', path: '/v1/cameras/' + args.cameraId });
  var presets = cam.ptzPresets || [];
  var target = presets.find(function (pr) { return pr.name === args.presetName; });
  if (!target) {
    return { error: 'No preset named ' + args.presetName + ' on ' + cam.name };
  }
  return {
    intent: 'ptz goto preset "' + args.presetName + '" on ' + cam.name,
    presetSlot: target.slot,
    awaitingConfirmation: true,
  };
})();

// On the user's "yes, proceed", run a SECOND execute call:
// var p = unifi.cloud.protect(args.consoleId);
// p.callOperation('cameraPtzGoto', { id: args.cameraId, slot: args.presetSlot });
```

## Common gotchas

- **`spec` lazy-loading.** `unifi.cloud.network(consoleId)` and
  `unifi.cloud.protect(consoleId)` are factory functions that return a
  fresh proxy. Don't cache the proxy across many `execute` calls; build
  it inside the script that uses it.
- **Console ID format.** `consoleId` is the host ID returned by
  `listHosts`, not the controller's MAC. They can both look like 12-char
  hex but they're different. Use what `listHosts` returns.
- **Pagination.** Most list operations support `?limit=` and
  `?cursor=`. Default page sizes are small. For a true full inventory,
  iterate.
- **Time and timezone.** Most timestamps are ISO 8601 in UTC. Don't
  reformat them client-side unless the user asks.
- **Empty arrays vs undefined.** If a console has no sites, you get
  `[]`. If the surface is misconfigured, you get `undefined`. Check
  before dereferencing.
- **Path-based `request()` is your friend** when the official Protect
  spec ships `operationId: null` and you're not sure what the
  synthesizer renamed it to. The path itself is stable.

## When something goes wrong

- **`UnknownOperationError: 'listFoo' not found in unifi.cloud.network`.**
  Run `search` for `foo` again — the operationId may have moved between
  spec versions. Use the path-based escape hatch.
- **`SandboxError: call budget exceeded`.** Your script is making too
  many host calls in one `execute`. Split it.
- **`HTTP 401` from a cloud surface.** The cloud API key isn't set or
  has been rotated. Tell the user to update the env / header and try
  again.
- **`HTTP 502` from a cloud-proxied call.** The console is offline or
  the connector is misbehaving. Try `listHosts` to confirm the console
  is reporting `state: "online"`. If not, escalate to the user.

## Reading list

- Root [`SKILL.md`](../../SKILL.md) — full operating manual, all surfaces
- Root [`docs/usage.md`](../../docs/usage.md) — humans' version
- [`AGENTS.md`](AGENTS.md) — the persona this skill backs
- [`SAMPLE_PROMPTS.md`](SAMPLE_PROMPTS.md) — vetted prompts to test with
- [`install.md`](install.md) — wiring this MCP into your agent platform
