# Coupling unifi-code-mode-mcp with opencode

This guide is for users who want the [opencode](https://opencode.ai) AI
agent CLI to drive this MCP server. For a vendor-neutral guide on the
two-tool surface, read [`SKILL.md`](../SKILL.md) first.

## 1. Where MCP servers are configured in opencode

opencode reads MCP server entries from a JSON config file:

| Scope | Path | Wins on name conflict |
|---|---|---|
| **Project** | `<repo>/opencode.json` (or `.jsonc`) | yes |
| **Global** | `~/.config/opencode/opencode.json` (or `.jsonc`) | no |

> Source: <https://opencode.ai/docs/config/> and <https://opencode.ai/docs/mcp-servers/>

## 2. Recommended: project-scoped stdio entry

This repo ships a working `opencode.json` at the root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "unifi": {
      "type": "local",
      "command": ["node", "dist/index.js"],
      "enabled": true
    }
  },
  "permission": {
    "unifi_*": "allow"
  }
}
```

Key differences from Cursor's `mcp.json`:

- Top-level key is `mcp` (not `mcpServers`).
- Per-server: `type: "local"` for stdio, `command` is a single argv array
  (binary + args combined — there is no separate `args` field).
- Environment variables go under `environment` (not `env`).
- The `permission` block at the top level uses the auto-generated
  `<server>_<tool>` names — opencode automatically prefixes every tool
  with the server key, so `search` becomes `unifi_search`.

opencode auto-injects MCP tools into the model's tool list, so there's
nothing to wire up on the prompt side — just ask the model to use
`unifi_search` or `unifi_execute`.

## 3. Multi-tenant credentials

If you want to drive both local and cloud surfaces, set the env vars in
your shell before running opencode (opencode forwards the parent process
environment to the MCP child):

```bash
export UNIFI_LOCAL_API_KEY=…
export UNIFI_LOCAL_BASE_URL=https://192.168.1.1
export UNIFI_LOCAL_INSECURE=true
export UNIFI_CLOUD_API_KEY=…
opencode run --model opencode-go/deepseek-v4-flash "Use unifi_search to..."
```

Or pin them in `opencode.json` for that profile:

```json
{
  "mcp": {
    "unifi": {
      "type": "local",
      "command": ["node", "dist/index.js"],
      "environment": {
        "UNIFI_LOCAL_API_KEY": "…",
        "UNIFI_CLOUD_API_KEY": "…"
      },
      "enabled": true
    }
  }
}
```

## 4. Smoke-test with `opencode mcp list`

Before involving any model, confirm opencode picks up the entry:

```bash
opencode mcp list
```

Expected:

```
●  ✓ unifi connected
       node dist/index.js
└  1 server(s)
```

If it says `failed`, run `opencode mcp list` once more — the first start
spawns the server and discovers tools; the second start will show the
final `connected` state.

## 5. Headless run for verification

```bash
opencode --pure run --model opencode-go/deepseek-v4-flash \
  "Use the unifi_search tool with code='spec.cloud.operations.length'. Reply with only the number."
```

Expected: opencode prints `9` (or whatever the current cloud-fallback
operation count is) — see `out/verification/opencode-deepseek-mcp-call.txt`
for a full reproducer including the SQLite-recorded tool call.

## 6. Known limitations specific to opencode (v1.14.30)

- **`plugin.copilot` Zod-validation crash hangs bootstrap.** The
  bundled GitHub Copilot provider plugin in opencode 1.14.30 fails to
  parse `models.json` from `models.dev` for a handful of capability
  fields. The error is logged but the run hangs in `kevent64` waiting
  for I/O that never arrives. **Workaround**: pass `--pure` (skips
  plugins). All `github-copilot/*` and Anthropic models still work
  this way; only the auto-discovery of new copilot models is
  disabled.
- **Persisted model variants are silent.** opencode keeps per-model
  reasoning-effort overrides in `~/.local/state/opencode/model.json`
  under the `variant` key. If you ever ran a model with a high
  reasoning variant (e.g. via the TUI), every subsequent CLI invocation
  inherits it — and `opencode run` does not echo this. We hit an
  8.5-minute wait on `deepseek-v4-flash` because of a stuck
  `variant: "max"`. To clear: edit the file or run with
  `--variant default` on the next invocation.
- **Permissions allowlist syntax differs from Cursor.** opencode uses
  permission keys like `"unifi_*": "allow"` at the top level
  `permission` block — Cursor uses `"Mcp(unifi:search)"` patterns
  inside `.cursor/cli.json`. They are not interchangeable.
- **`opencode run` is silent until completion** (no streaming progress
  on stdout) — point the watcher at the rolling log file under
  `~/.local/share/opencode/log/` instead.

## 7. Reference

| Item | URL |
|---|---|
| opencode config | <https://opencode.ai/docs/config/> |
| opencode MCP servers | <https://opencode.ai/docs/mcp-servers/> |
| opencode CLI | <https://opencode.ai/docs/cli/> |
| opencode permissions | <https://opencode.ai/docs/permissions/> |
| This server's two-tool surface | [`../SKILL.md`](../SKILL.md) |
| Server installation | [`./usage.md`](./usage.md) |
| Multi-tenant transport details | [`./multi-tenant.md`](./multi-tenant.md) |
