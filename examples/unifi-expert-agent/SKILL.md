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
| `search` | Find an operationId before you call it. Always. Default to `limit: 5` and a tight keyword. Optionally pass `namespace: "local" \| "cloud" \| "local.protect" \| "cloud.protect"` to scope the catalogue. |
| `execute` | Run JavaScript that calls UniFi via the `unifi.*` global. Last expression's value is returned to you. |

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
is loaded:

```js
if (!unifi.cloud?.spec) {
  return { error: 'No cloud credential configured for this tenant' };
}
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

### Inventory a single console (read-only)

```js
const hosts = unifi.cloud.callOperation('listHosts').data;
const console = hosts.find(h => h.id === args.consoleId);
const net = unifi.cloud.network(args.consoleId);
const sites = net.sites.listSites();
const devices = sites.flatMap(site =>
  net.devices.listAdoptedDevices({ siteId: site.id }).map(d => ({
    site: site.name,
    name: d.name,
    model: d.model,
    macAddress: d.macAddress,
    ipAddress: d.ipAddress,
    state: d.state,
    firmwareVersion: d.firmwareVersion,
  })),
);
return { console: console?.reportedState?.name ?? args.consoleId, sites: sites.length, devices };
```

### Audit firmware drift

```js
const sites = unifi.cloud.network(args.consoleId).sites.listSites();
const drift = [];
for (const site of sites) {
  const devs = unifi.cloud.network(args.consoleId)
    .devices.listAdoptedDevices({ siteId: site.id });
  for (const d of devs) {
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
return { totalSites: sites.length, drift };
```

### High-level design (HLD)

```js
const consoles = unifi.cloud.callOperation('listHosts').data;
const summary = consoles.map(c => {
  const net = unifi.cloud.network(c.id);
  const sites = net.sites.listSites();
  return {
    console: c.reportedState?.name ?? c.id,
    sites: sites.map(s => {
      const devs = net.devices.listAdoptedDevices({ siteId: s.id });
      const counts = {};
      for (const d of devs) counts[d.model] = (counts[d.model] ?? 0) + 1;
      return { name: s.name, deviceCounts: counts };
    }),
  };
});
return summary;
```

### Inventory cameras (Protect)

```js
const p = unifi.cloud.protect(args.consoleId);
const cameras = p.request({ method: 'GET', path: '/v1/cameras' });
return cameras.map(c => ({
  id: c.id,
  name: c.name,
  modelKey: c.modelKey,
  state: c.state,
  firmwareVersion: c.firmwareVersion,
  isMicEnabled: c.isMicEnabled,
}));
```

### Confirm-before-mutate (PTZ goto preset)

```js
// READ FIRST: tell the user what we're about to do.
const p = unifi.cloud.protect(args.consoleId);
const cam = p.request({ method: 'GET', path: `/v1/cameras/${args.cameraId}` });
const target = cam.ptzPresets?.find(pr => pr.name === args.presetName);
if (!target) {
  return { error: `No preset named ${args.presetName} on ${cam.name}` };
}
// HALT. Surface this back to the user and only proceed on a follow-up turn:
return {
  intent: `ptz goto preset "${args.presetName}" on ${cam.name}`,
  presetSlot: target.slot,
  awaitingConfirmation: true,
};

// On the user's "yes, proceed", run a second execute call:
// p.callOperation('cameraPtzGoto', { id: args.cameraId, slot: target.slot });
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
