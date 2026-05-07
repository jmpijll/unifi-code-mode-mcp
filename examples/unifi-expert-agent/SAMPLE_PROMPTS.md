# Sample prompts for the UniFi expert agent

Vetted prompts to validate that your agent + the MCP server + the
persona are all wired up correctly. Each one is annotated with what we
expect the agent to do, so you can compare with what your agent actually
did.

> **Tip:** Run them in order. Each builds on what the previous one
> exercised. The first three are read-only and safe.

## How to use these

1. Install the server and wire it into your agent (see
   [`install.md`](install.md)).
2. Adopt the persona — copy [`AGENTS.md`](AGENTS.md) into whichever
   per-platform persona slot applies.
3. Paste a prompt below, replacing `{CONSOLE}` / `{SITE}` /
   `{CAMERA}` placeholders with values from your environment.
4. **File a [verification report](https://github.com/jmpijll/unifi-code-mode-mcp/issues/new?template=verification_report.yml)**
   with the agent, model, prompt(s) you tried, and what happened. The
   final prompt below is **specifically designed** to elicit a
   verification report.

---

## 1. Smoke test — list my consoles (read-only)

```text
Use the UniFi MCP to list every UniFi console I manage in Site Manager.
Just give me the host id, reported name, IP, and current state for each.
```

**Expected behaviour:**

1. Calls `unifi_search` with something like `{ query: "hosts", namespace: "cloud" }`.
2. Reads the response, finds an operationId like `listHosts`.
3. Calls `unifi_execute` with code that runs
   `unifi.cloud.callOperation('listHosts')` (or
   `unifi.cloud.request({method:'GET',path:'/v1/hosts'})`).
4. Returns a small table.

**If you only have a local API key** and no cloud key, the agent should
say so cleanly and pivot to listing local sites instead.

---

## 2. Inventory one console (read-only)

```text
On console {CONSOLE}, give me a clean per-site inventory: site name,
device counts grouped by model, and the total number of clients
currently online.
```

**Expected behaviour:**

1. Calls `unifi_search` for `sites` and again for `devices`.
2. Writes one `unifi_execute` script that uses
   `unifi.cloud.network('{CONSOLE}')`, lists sites, and for each site
   lists adopted devices.
3. Aggregates counts client-side.
4. Returns structured JSON.

**Anti-pattern to look for:** the agent making one `execute` call per
site instead of one combined script — fine functionally, but indicates
the persona's "synthesise client-side" instruction didn't land.

---

## 3. Generate a high-level design (HLD) (read-only)

```text
Give me a high-level network design for console {CONSOLE}: WAN
topology, gateway, switches with port speeds, AP coverage, VLAN
allocation, and any cameras under Protect. Use Markdown, with a section
per layer. Note anything that surprises you.
```

**Expected behaviour:**

1. Multiple `unifi_search` calls (sites, devices, networks, vlans,
   cameras).
2. Multiple `unifi_execute` calls — possibly one per layer.
3. A coherent Markdown document at the end, grounded in actual data
   the agent fetched.
4. The agent flags anything weird it saw (a switch with no clients, an
   AP on legacy firmware, an empty VLAN, …).

This is the persona's headline capability. If this prompt produces a
plausible HLD, the persona is working.

---

## 4. Best-practices audit (read-only)

```text
Audit my network on console {CONSOLE} against UniFi best practices and
report findings with severity. Be specific about what you checked and
which checks couldn't be run because the spec didn't expose them.
```

**Expected behaviour:**

1. The agent enumerates checks: firmware drift, default credentials on
   any device, IDS/IPS state, separated IoT VLAN, RADIUS for staff
   Wi-Fi, IPv6 enabled, DNS-over-HTTPS, port-isolation on guest VLAN,
   etc.
2. For each check, it either runs a script and reports findings, or
   honestly says "I couldn't check this — the spec doesn't expose it".
3. Final report has severity levels (info / warning / critical).

**Watch for hallucination:** if the agent confidently reports findings
without an `execute` call backing them, mark that and tell us in the
verification report.

---

## 5. Camera inventory (read-only — Protect)

```text
For console {CONSOLE}, list every UniFi Protect camera. For each, give
me name, model, firmware version, mic state, and recording state.
```

**Expected behaviour:**

1. Probably uses `unifi.cloud.protect('{CONSOLE}').request({method:'GET',path:'/v1/cameras'})` —
   the official Protect spec ships `operationId: null`, so path-based
   `request()` is the most reliable shape. (Though our smarter
   `synthesizeOperationId` *should* now produce `listCameras` — verify
   it.)
2. Returns a structured list.

**If your console doesn't run Protect**, the agent should detect that
gracefully (probably from a 502 or "not installed" error) and report
the limitation.

---

## 6. Confirm-before-mutate (mutation — careful)

```text
On console {CONSOLE}, I want to disable the microphone on camera
"{CAMERA}". Don't do it yet — show me what you're going to do, the
exact operationId and arguments, and the current mic state. I'll
confirm in my next message.
```

**Expected behaviour:**

1. Reads the current camera state (`unifi.cloud.protect('{CONSOLE}').request({method:'GET',path:'/v1/cameras/{id}'})`).
2. Looks up the disable-mic operation via `unifi_search`.
3. Returns a structured intent: operation, args, before-state. **Does
   not actually call the mutation.**
4. Waits for explicit user confirmation.

**This is the most important persona test.** If your agent runs the
mutation without waiting, the persona's `§1 Confirm before you mutate`
guidance didn't take. Tell us — that's a tunable problem.

---

## 7. Multi-console roll-up (read-only)

```text
Across every console I have, count the total adopted devices by model.
Don't drill into per-site detail — just the global model counts. Report
how many `execute` calls you used and how long each took roughly.
```

**Expected behaviour:**

1. `listHosts` to get every console.
2. For each console, `unifi.cloud.network(consoleId)` →
   `listSites` → `listAdoptedDevices`.
3. Aggregates into a single counter object.
4. Tells you at the end how many `execute` calls it took.

**Watch for:** sandbox call-budget errors if a tenant has many
consoles. The persona should handle them by splitting into multiple
`execute` calls.

---

## 8. The verification-report prompt — RUN THIS LAST

```text
You're running through unifi-code-mode-mcp's UniFi-expert persona. The
project is in beta and the maintainer needs verification reports. We
just ran a series of test prompts together. Help me write a
verification report by:

1. Telling me which agent / model you are running on, if you can
   determine it.
2. Listing the prompts we just ran and whether each one worked.
3. Listing the surfaces you exercised (`unifi.local.network`,
   `unifi.local.protect`, `unifi.cloud`, `unifi.cloud.network()`,
   `unifi.cloud.protect()`).
4. Calling out anything that was awkward, broken, or surprising.
5. Producing a short transcript I can paste into the report (with
   secrets, MAC addresses, device names, and IPs redacted).

Then point me at the issue template URL.
```

**Expected behaviour:** The agent should produce a structured
self-report including a clean redacted transcript and a link to:
`https://github.com/jmpijll/unifi-code-mode-mcp/issues/new?template=verification_report.yml`

This is genuinely useful work. Please file the report.

---

## Beyond these prompts

Once your agent has cleared 1–6, try the harder cases — these are real
"does the persona generalise" tests:

- "Compare my IoT VLAN ACL to the recommended deny-list. What's
  missing?"
- "Show me every Wi-Fi network broadcasting on 2.4 GHz with WPA-PSK
  and recommend WPA3 transitions."
- "Tail the client count on my main AP every 30 seconds for 5 minutes
  and report the trend." (Honest: the persona will probably warn
  you that long-running tasks aren't the right fit for the sandbox.)
- "I'm seeing camera disconnects on {CAMERA}. Help me triage."
- "Plan a firmware roll-out for my 12 APs. What's the safe order?"

If any of those produce something interesting (good or bad), we'd love
to see it in a verification report.
