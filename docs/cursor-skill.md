# Coupling unifi-code-mode-mcp with Cursor

This guide is for users who want a Cursor IDE or Cursor CLI agent to drive
this MCP server. For a vendor-neutral guide on the server's two tools and
the JavaScript surface, read [`SKILL.md`](../SKILL.md) first.

## 1. Where MCP servers are configured in Cursor

Cursor reads MCP server entries from a JSON file called `mcp.json`:

| Scope | Path | Wins on name conflict |
|---|---|---|
| **Project** | `<repo>/.cursor/mcp.json` | yes |
| **Global (macOS / Linux)** | `~/.cursor/mcp.json` | no |

The same file is read by both Cursor IDE and the `cursor-agent` CLI. If
you add a project-scoped entry with the same name as a global one, the
project entry wins.

> Source: <https://cursor.com/docs/mcp.md>

## 2. Recommended: stdio entry (single tenant, IDE)

Most users want a single deployment per Cursor profile. This repo ships a
working project-scoped `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "unifi": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "UNIFI_LOCAL_API_KEY": "${env:UNIFI_LOCAL_API_KEY}",
        "UNIFI_LOCAL_BASE_URL": "${env:UNIFI_LOCAL_BASE_URL}",
        "UNIFI_LOCAL_INSECURE": "${env:UNIFI_LOCAL_INSECURE}",
        "UNIFI_CLOUD_API_KEY": "${env:UNIFI_CLOUD_API_KEY}",
        "UNIFI_CLOUD_BASE_URL": "${env:UNIFI_CLOUD_BASE_URL}"
      }
    }
  }
}
```

> **Path note**: We use a workspace-relative path (`dist/index.js`) rather
> than `${workspaceFolder}/dist/index.js`. The
> `cursor-agent mcp list-tools <name>` subcommand does not expand
> `${workspaceFolder}`, which causes it to spawn `node /dist/index.js`
> and fail with `Connection closed`. Relative paths work in both the
> IDE and all `cursor-agent` subcommands.

Or, if you `npm link` the server globally so the binary is on `PATH`:

```json
{
  "mcpServers": {
    "unifi": {
      "command": "unifi-code-mode-mcp",
      "env": {
        "UNIFI_CLOUD_API_KEY": "${env:UNIFI_CLOUD_API_KEY}",
        "UNIFI_LOCAL_API_KEY": "${env:UNIFI_LOCAL_API_KEY}",
        "UNIFI_LOCAL_BASE_URL": "${env:UNIFI_LOCAL_BASE_URL}"
      }
    }
  }
}
```

Cursor resolves `${env:NAME}` at config-load time against the **shell
environment that launched Cursor**. On macOS, that means setting them in
`~/.zshenv` (or letting them flow from 1Password's CLI shim) — env vars
set only in `.zshrc` may not be seen by GUI Cursor.

> "MCP servers use environment variables for authentication. Pass API
> keys and tokens through the config." — <https://cursor.com/docs/mcp.md>

> "`envFile` is only available for STDIO servers. Remote servers
> (HTTP/SSE) do not support `envFile`. For remote servers, use config
> interpolation with environment variables set in your shell profile or
> system environment instead." — <https://cursor.com/docs/mcp.md>

## 3. Streamable HTTP entry (remote / shared deployment)

If you run the server as a service (e.g. on a homelab box), point Cursor
at the HTTP endpoint:

```json
{
  "mcpServers": {
    "unifi": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:UNIFI_MCP_TOKEN}",
        "X-Unifi-Cloud-Api-Key": "${env:UNIFI_CLOUD_API_KEY}",
        "X-Unifi-Local-Api-Key": "${env:UNIFI_LOCAL_API_KEY}",
        "X-Unifi-Local-Base-Url": "${env:UNIFI_LOCAL_BASE_URL}"
      }
    }
  }
}
```

`${env:VAR}` interpolation is supported in `url` and `headers`.

## 4. Multi-tenant: register one entry per tenant

Cursor's MCP configuration schema only documents a static `headers` map
per remote server entry; values are resolved at config load via
`${env:…}` interpolation. The docs describe **no mechanism for
per-request or per-tenant header injection at the protocol layer**.

That means: if you operate two UniFi tenants from a single Cursor session,
register two MCP servers — one per tenant — each with its own headers:

```json
{
  "mcpServers": {
    "unifi-home": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "X-Unifi-Cloud-Api-Key": "${env:UNIFI_HOME_CLOUD_KEY}"
      }
    },
    "unifi-customer-acme": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "X-Unifi-Cloud-Api-Key": "${env:UNIFI_ACME_CLOUD_KEY}"
      }
    }
  }
}
```

The agent then picks the right server by name (`unifi-home` vs
`unifi-customer-acme`). The two entries hit the same backend; only the
headers differ.

## 5. Headless / CI invocation with cursor-agent

Run the agent non-interactively with auto-approval of MCP tool calls and
JSON output suitable for parsing:

```bash
cursor-agent \
  --workspace "$PWD" \
  --print \
  --output-format json \
  --approve-mcps \
  --force \
  "Use unifi to list every site and its device count, then return a markdown table."
```

There is **no `--mcp-config` flag** — the agent reads `.cursor/mcp.json`
in the workspace it was launched against. To use a different config,
either swap files or set the workspace.

> Sources: <https://cursor.com/docs/cli/headless.md>,
> <https://cursor.com/docs/cli/reference/parameters.md>

## 6. Coupling the agent with the SKILL

Cursor auto-discovers `SKILL.md` files in:

- `~/.cursor/skills/<name>/SKILL.md` (personal)
- `<repo>/.cursor/skills/<name>/SKILL.md` (project)

This repo's [`SKILL.md`](../SKILL.md) sits at the **repo root** so it ships
with the source. To make the agent pick it up automatically when working
in another project, copy or symlink it into a skills directory:

```bash
mkdir -p ~/.cursor/skills/unifi-code-mode-mcp
ln -s "$PWD/SKILL.md" ~/.cursor/skills/unifi-code-mode-mcp/SKILL.md
```

The skill's frontmatter omits `disable-model-invocation`, so the agent
will reach for it whenever it sees UniFi-shaped queries.

If you'd rather keep things explicit, point the agent at the skill in
your prompt:

```bash
cursor-agent --print "Use the unifi-code-mode-mcp skill to give me an HLD of my home network."
```

## 7. End-to-end smoke test

A single command to verify the wiring:

```bash
cursor-agent --print --output-format json --approve-mcps --force \
  "Use unifi to call search('site') and execute one operation that lists my sites. Return the operationId you used and the count of sites." \
  | tee out/cursor-smoke.json
```

For a more thorough run (three prompts: HLD sweep, single-fact lookup,
intentionally-impossible) use the helper script in this repo:

```bash
./scripts/cursor-cli-smoke.sh
```

It builds the server, generates a temporary `.cursor/mcp.json`, drives
the three prompts, and writes JSON transcripts to `out/cursor-smoke-*.json`.
The script no-ops gracefully if `cursor-agent` is not on `PATH`.

If you only need to verify the protocol-level behaviour (not the IDE
client), the project's Vitest integration suite does exactly that
without depending on the CLI:

```bash
npm test -- src/__tests__/integration
```

It spins up the real `createMcpServer` factory against a mock UniFi
controller and exercises both `InMemoryTransport` (stdio-equivalent) and
Streamable HTTP transports.

Expected JSON output (shape, not values):

```json
{
  "messages": [
    {
      "role": "assistant",
      "tool_calls": [
        { "tool": "unifi.search", "args": { "query": "site" } },
        { "tool": "unifi.execute", "args": { "code": "..." } }
      ]
    }
  ],
  "result": "Used getSiteOverviewPage; found 1 site."
}
```

If the smoke fails, check in this order:

1. Is the server actually registered? Run `cursor-agent --list-mcps` (or
   the IDE's *MCP* settings panel) and confirm `unifi` appears.
2. Are credentials reaching the server? Hit `/health` if you're on the
   HTTP transport, or run `npm run dev` directly and tail logs.
3. Does the spec cache exist? `ls src/spec/cache/`. If not, the first
   call will populate it — give it 5 s.
4. Is the controller version supported? The loader falls back to a
   known spec, but a controller older than `v10.1.x` may report
   operations the cached spec doesn't know about.

## 8. Known limitations specific to Cursor

- **No per-request headers.** Confirmed via the docs (see §4 above).
  Workaround: one MCP entry per tenant.
- **`envFile` doesn't apply to remote servers.** All credentials for an
  HTTP entry must come from `${env:…}` or be hard-coded in `headers`.
- **Cursor IDE caches MCP server connections.** After editing
  `mcp.json`, reload the window (`Cmd+Shift+P → Developer: Reload Window`)
  or the new headers won't take effect.
- **`cursor-agent --force` bypasses the per-tool approval prompt.** Use
  it in CI; avoid it in interactive sessions where you want a human
  approval gate on mutating UniFi calls.
- **`${workspaceFolder}` is not always interpolated.** The
  `cursor-agent mcp list-tools <name>` subcommand specifically does not
  expand it (the server fails to spawn with `Connection closed`). Use a
  workspace-relative path like `"args": ["dist/index.js"]` instead — it
  works for both the IDE and the CLI subcommands. Verified against
  cursor-agent v2026.05.05.
- **`cursor-agent --print` mode + custom MCPs.** With the default
  `composer-2-fast` model, custom MCP servers configured in
  `.cursor/mcp.json` are *not* registered as model-callable tools in
  the headless `--print` session, even when
  `cursor-agent mcp list` shows the server as `ready` and
  `--approve-mcps --force --trust` are all set. The model knows the
  server exists (it can see `dist/index.js` in the workspace) but its
  tool list contains only `codebase_search`, `run_terminal_cmd`,
  `grep`, `read_file`, etc. — no `mcp__<server>__<tool>` entry. The
  model often works around this by spawning the MCP server over stdio
  and driving JSON-RPC manually via `run_terminal_cmd`, which produces
  correct results but is unreliable and consumes call budget. Verified
  against cursor-agent v2026.05.05.

  **Reliable smoke**: use `cursor-agent mcp list-tools <name>` to
  confirm protocol-level wiring (no LLM session needed). For
  functional behaviour use the project's Vitest integration suite —
  it speaks the same MCP wire protocol via `InMemoryTransport` /
  `StreamableHTTPClientTransport`.

  **Permissions tip** (for interactive `cursor-agent` sessions, where
  custom MCPs *do* register): if the global
  `~/.cursor/cli-config.json` uses `"approvalMode": "allowlist"`,
  add a project-scoped `.cursor/cli.json` to pre-allow this server's
  tools without prompting:

  ```json
  {
    "permissions": {
      "allow": [
        "Mcp(unifi:search)",
        "Mcp(unifi:execute)"
      ]
    }
  }
  ```

  This file is checked into the repo for reference.

## 9. Reference

| Item | URL |
|---|---|
| Cursor MCP configuration | <https://cursor.com/docs/mcp.md> |
| `cursor-agent` headless mode | <https://cursor.com/docs/cli/headless.md> |
| `cursor-agent` parameters | <https://cursor.com/docs/cli/reference/parameters.md> |
| This server's two-tool surface | [`../SKILL.md`](../SKILL.md) |
| Server installation | [`./usage.md`](./usage.md) |
| Multi-tenant transport details | [`./multi-tenant.md`](./multi-tenant.md) |
