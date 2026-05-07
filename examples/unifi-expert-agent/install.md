# Cross-platform install guide

How to wire `unifi-code-mode-mcp` into different agent platforms. Each
section is self-contained.

## Verification legend

- **VERIFIED** — The maintainer has run a real LLM through this client
  and watched it call the MCP tools end-to-end. Configurations below
  are known to work.
- **NOT-VERIFIED** — The configuration follows the platform's documented
  MCP support and *should* work, but we haven't tested it. Please file
  a [verification report](https://github.com/jmpijll/unifi-code-mode-mcp/issues/new?template=verification_report.yml)
  if you do.
- **PROTOCOL-ONLY** — The MCP handshake works, but the platform's
  particular client mode doesn't expose custom tools to the LLM in the
  current release. See notes per platform.

> **Surface verification (independent of agent platform).** Four of the
> five sandbox surfaces are live-verified against a real UDM-Pro
> (`unifi.local.*`, `unifi.local.protect.*`, `unifi.cloud.network()`,
> `unifi.cloud.protect()`). The remaining surface (`unifi.cloud` — Site
> Manager native) is exercised in passing by every cloud-side
> verification. End-to-end *LLM-mediated* invocation is verified
> against the cloud paths through `cursor-agent` (Sonnet 4.6) and
> `opencode` (DeepSeek v4 Flash), and against the **LAN-direct
> Network** path through `opencode` (DeepSeek v4 Flash). The LAN-direct
> Protect path was exercised live via the project's discovery and
> mutation scripts but has not yet been driven by an LLM. See the
> [project status](https://github.com/jmpijll/unifi-code-mode-mcp#project-status)
> callout.

## Prerequisites (every platform)

```bash
git clone https://github.com/jmpijll/unifi-code-mode-mcp.git
cd unifi-code-mode-mcp
npm install
cp .env.example .env
# Set UNIFI_LOCAL_API_KEY and/or UNIFI_CLOUD_API_KEY
npm run build
# Sanity check:
node dist/index.js --help 2>/dev/null || echo "stdio server is fine"
```

The server's stdio entry is `node dist/index.js`. The HTTP transport
entry is the same binary with `MCP_TRANSPORT=http` set.

The full path to use in absolute-path snippets below:

```bash
echo "$(pwd)/dist/index.js"
# e.g. /Users/you/code/unifi-code-mode-mcp/dist/index.js
```

We use `/absolute/path/to/unifi-code-mode-mcp/dist/index.js` as a
placeholder.

---

## Cursor IDE — VERIFIED

Add to `.cursor/mcp.json` at your project root, **or** to the global
config at `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "unifi": {
      "command": "node",
      "args": ["/absolute/path/to/unifi-code-mode-mcp/dist/index.js"],
      "env": {
        "UNIFI_LOCAL_API_KEY": "...",
        "UNIFI_CLOUD_API_KEY": "...",
        "UNIFI_LOCAL_BASE_URL": "https://192.168.1.1"
      }
    }
  }
}
```

**Reload:** Cursor doesn't always hot-reload MCP config. Restart the
IDE or use the Command Palette → *MCP: Restart Server*.

**Loading the persona:** Drop `examples/unifi-expert-agent/AGENTS.md`
into `.cursor/rules/unifi-expert.mdc` (Cursor reads `.mdc` files in
`.cursor/rules/` as rule injections). Or paste it into a chat as a
system message.

**Caveats:**
- The IDE's chat panel hasn't been smoke-tested by us; the verification
  was through `cursor-agent` (next section).

## cursor-agent CLI — VERIFIED

Cursor's headless / interactive CLI uses the same `.cursor/mcp.json`.
Two modes matter:

**Interactive PTY (LLM sees the MCP tools):**

```bash
cursor-agent --model claude-sonnet-4.6
> "Use the unifi MCP to inventory my console abc123."
```

In an interactive session the model can call `mcp_unifi_search` and
`mcp_unifi_execute` directly. This is how we did our headline
verification with Claude Sonnet 4.6.

**Print mode (`--print`):** PROTOCOL-ONLY. As of `cursor-agent`
0.x, `--print` mode does not expose custom MCP tools to the LLM, so
prompts that *require* MCP tool calls won't trigger them. Use
interactive mode for verification.

**Loading the persona:** Same as Cursor IDE — `.cursor/rules/unifi-expert.mdc`.

**See:** [`docs/cursor-skill.md`](../../docs/cursor-skill.md) for the
full set of caveats and a verified transcript.

---

## opencode — VERIFIED (cloud + LAN-direct Network)

Add to `opencode.json` at your project root, **or** `~/.opencode/config.json`.
Pass any combination of credentials through `environment` with
`{env:VAR}` interpolation so a single `opencode run` can drive both the
cloud and LAN-direct surfaces:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "unifi": {
      "type": "local",
      "command": ["node", "/absolute/path/to/unifi-code-mode-mcp/dist/index.js"],
      "enabled": true,
      "environment": {
        "UNIFI_LOCAL_BASE_URL": "{env:UNIFI_LOCAL_BASE_URL}",
        "UNIFI_LOCAL_API_KEY": "{env:UNIFI_LOCAL_API_KEY}",
        "UNIFI_LOCAL_INSECURE": "{env:UNIFI_LOCAL_INSECURE}",
        "UNIFI_CLOUD_API_KEY": "{env:UNIFI_CLOUD_API_KEY}"
      }
    }
  },
  "permission": {
    "unifi_*": "allow"
  }
}
```

Run with whichever creds the prompt needs:

```bash
# Cloud surface only
UNIFI_CLOUD_API_KEY=... opencode --pure run "Use the unifi MCP to list my consoles."

# LAN-direct Network surface (verified 2026-05-07 with DeepSeek v4 Flash):
UNIFI_LOCAL_BASE_URL=https://172.27.1.1 \
UNIFI_LOCAL_API_KEY=... \
UNIFI_LOCAL_INSECURE=true \
  opencode run "Use the unifi MCP to count sites on my local controller."
```

**Loading the persona:** opencode supports per-agent persona files at
`.opencode/agent/<name>.md` (project) or `~/.opencode/agent/<name>.md`
(global). Copy this into `.opencode/agent/unifi-expert.md`:

```markdown
---
description: UniFi network engineering expert
mode: primary
---

<!-- Then paste examples/unifi-expert-agent/AGENTS.md here -->
```

Activate it with `/agent unifi-expert` inside opencode.

**See:** [`docs/opencode-skill.md`](../../docs/opencode-skill.md) for
full setup instructions and the verified transcript.

---

## Claude Code (CLI) — NOT-VERIFIED

Claude Code reads MCP servers from a per-project `.mcp.json` or via the
`claude mcp add` CLI. Add a project-scoped server:

```bash
claude mcp add unifi -- node /absolute/path/to/unifi-code-mode-mcp/dist/index.js
```

Or write `.mcp.json` directly:

```json
{
  "mcpServers": {
    "unifi": {
      "command": "node",
      "args": ["/absolute/path/to/unifi-code-mode-mcp/dist/index.js"],
      "env": {
        "UNIFI_LOCAL_API_KEY": "...",
        "UNIFI_CLOUD_API_KEY": "..."
      }
    }
  }
}
```

**Loading the persona:** Copy `examples/unifi-expert-agent/AGENTS.md`
to `CLAUDE.md` at your project root, or to `~/.claude/CLAUDE.md` for a
user-level persona. Claude Code reads these automatically.

**Verify with:** Ask Claude "what MCP tools do you have access to?" and
look for `mcp__unifi__search` / `mcp__unifi__execute`.

**Please file a verification report** with model + outcome.

---

## Claude Desktop — NOT-VERIFIED

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "unifi": {
      "command": "node",
      "args": ["/absolute/path/to/unifi-code-mode-mcp/dist/index.js"],
      "env": {
        "UNIFI_LOCAL_API_KEY": "...",
        "UNIFI_CLOUD_API_KEY": "..."
      }
    }
  }
}
```

Fully quit and relaunch Claude Desktop after saving. Tools appear
under the hammer icon.

**Loading the persona:** Claude Desktop has no project-scoped persona
file. Paste `AGENTS.md` content into the very first message of a
conversation, or use a Project (Pro/Team) and put it in the project
instructions.

**Please file a verification report** — Claude Desktop is one of the
most commonly requested platforms.

---

## VS Code + GitHub Copilot Chat — NOT-VERIFIED

VS Code 1.95+ supports MCP through Copilot Chat (agent mode). Add to
`.vscode/mcp.json` at your workspace root:

```json
{
  "servers": {
    "unifi": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/../unifi-code-mode-mcp/dist/index.js"],
      "env": {
        "UNIFI_LOCAL_API_KEY": "${input:unifi_local_key}",
        "UNIFI_CLOUD_API_KEY": "${input:unifi_cloud_key}"
      }
    }
  },
  "inputs": [
    { "id": "unifi_local_key", "type": "promptString", "description": "UniFi local API key", "password": true },
    { "id": "unifi_cloud_key", "type": "promptString", "description": "UniFi cloud API key", "password": true }
  ]
}
```

Then in the Copilot Chat panel, switch to **Agent** mode (the dropdown
near the model picker), open the *Tools* picker, and enable the unifi
tools.

**Loading the persona:** VS Code reads `.github/copilot-instructions.md`
as a project-scoped persona. Copy `AGENTS.md` content there.

**Please file a verification report** — note the model picker (GPT-4.1,
Claude Sonnet 4.6, Gemini, etc.) and outcome.

---

## Codex CLI (OpenAI) — NOT-VERIFIED

Codex reads MCP servers from `~/.codex/config.toml` (or project-scoped
`.codex/config.toml`). The correct key is `[mcp_servers.<name>]`,
**not** `[mcp.servers]`:

```toml
[mcp_servers.unifi]
command = "node"
args = ["/absolute/path/to/unifi-code-mode-mcp/dist/index.js"]
env = { UNIFI_LOCAL_API_KEY = "...", UNIFI_CLOUD_API_KEY = "..." }
startup_timeout_sec = 30
```

Or use the CLI shortcut:

```bash
codex mcp add unifi -- node /absolute/path/to/unifi-code-mode-mcp/dist/index.js
```

**Loading the persona:** Codex reads `AGENTS.md` from the project root.
Copy `examples/unifi-expert-agent/AGENTS.md` to `AGENTS.md` at the root
of whichever directory you `cd` into when running Codex.

**Please file a verification report.**

---

## Continue (`continue.dev`) — NOT-VERIFIED

Continue reads MCP servers from `~/.continue/config.json`:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "node",
          "args": ["/absolute/path/to/unifi-code-mode-mcp/dist/index.js"],
          "env": {
            "UNIFI_LOCAL_API_KEY": "...",
            "UNIFI_CLOUD_API_KEY": "..."
          }
        }
      }
    ]
  }
}
```

**Loading the persona:** Continue supports custom system messages per
model in `~/.continue/config.json`. Inline the AGENTS.md content into
the model's `systemMessage`.

**Please file a verification report.**

---

## Cline (VS Code extension) — NOT-VERIFIED

Cline manages MCP servers through its UI: click the MCP icon in the
Cline panel → *MCP Servers* → *Edit MCP Settings*. Then add:

```json
{
  "mcpServers": {
    "unifi": {
      "command": "node",
      "args": ["/absolute/path/to/unifi-code-mode-mcp/dist/index.js"],
      "env": {
        "UNIFI_LOCAL_API_KEY": "...",
        "UNIFI_CLOUD_API_KEY": "..."
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

(Don't auto-approve `unifi_execute` — the persona's whole point is to
ask before mutations.)

**Loading the persona:** Cline reads `.clinerules` files from the
project root. Copy `AGENTS.md` content to `.clinerules` (no extension)
or to a `.clinerules/` directory with multiple files.

**Please file a verification report.**

---

## MCP Inspector — ✅ VERIFIED (CLI mode v0.20.0, 2026-05-07)

The official [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
is the fastest way to verify the protocol layer of any MCP server
without involving an LLM. We've live-verified the CLI mode against a
real UDM-Pro running Network 10.3.58 — all four phases pass
(`tools/list`, `tools/call execute` without creds, `tools/call search`
with creds, `tools/call execute` with creds returning live site
count). Sanitized transcript at
[`out/verification/mcp-inspector-live-smoke.txt`](../../out/verification/mcp-inspector-live-smoke.txt).

### CLI mode (best for headless verification)

```bash
# Pin to v0.20.0 — the current latest (0.21.2) has a missing-`commander`
# dependency error on Node.js v25. Tracking issue:
#   https://github.com/modelcontextprotocol/inspector
npx @modelcontextprotocol/inspector@0.20.0 --cli --transport stdio \
    -e "UNIFI_LOCAL_BASE_URL=https://<your-controller>" \
    -e "UNIFI_LOCAL_API_KEY=<your-local-key>" \
    -e "UNIFI_LOCAL_INSECURE=true" \
    -- node /absolute/path/to/unifi-code-mode-mcp/dist/index.js \
    --method tools/list

# Or call a tool directly:
... \
    --method tools/call --tool-name search \
    --tool-arg "code=searchOperations('local', 'site', 3)"
```

### UI mode (browser-based debugger)

```bash
npx @modelcontextprotocol/inspector@0.20.0 \
    -- node /absolute/path/to/unifi-code-mode-mcp/dist/index.js
```

This opens a browser UI where you can call `search` and `execute`
manually. **The UI mode itself is NOT-VERIFIED yet** — only the CLI
mode has been driven end-to-end. Useful for:

- Confirming the server starts and registers tools
- Calling `search` against your real catalogue
- Running specific JS through `execute` to debug a script before you
  hand it to an LLM

There's no LLM involved, so there's no persona to load — but it's the
gold-standard "did the server load my OpenAPI specs" smoke test, and
the easiest way to debug a `search`/`execute` round-trip in
isolation.

**Please file a verification report** if you find a regression in the
UI mode, or with non-stdio transports (HTTP / SSE) — those paths are
still unverified.

---

## Aider — NOT-VERIFIED

Aider added experimental MCP support recently. The current invocation
is via `--mcp-server`:

```bash
aider --mcp-server "node /absolute/path/to/unifi-code-mode-mcp/dist/index.js"
```

This is moving territory; please consult Aider's current docs and file
a verification report with the version you used.

---

## Zed — NOT-VERIFIED

Zed's assistant supports MCP via the `context_servers` settings key in
`~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "unifi": {
      "command": {
        "path": "node",
        "args": ["/absolute/path/to/unifi-code-mode-mcp/dist/index.js"],
        "env": {
          "UNIFI_LOCAL_API_KEY": "...",
          "UNIFI_CLOUD_API_KEY": "..."
        }
      }
    }
  }
}
```

**Please file a verification report.**

---

## A custom MCP client — NOT-VERIFIED, but well-defined

The server speaks the standard MCP protocol over either:

- **stdio** — `node dist/index.js`. Default. Use this from any client
  that spawns an MCP server as a subprocess.
- **Streamable HTTP** — `MCP_TRANSPORT=http MCP_HTTP_PORT=8765 node dist/index.js`.
  Multi-tenant: pass per-request headers `X-Unifi-Local-Api-Key`,
  `X-Unifi-Cloud-Api-Key`, `X-Unifi-Local-Base-Url`, etc. See
  [`docs/multi-tenant.md`](../../docs/multi-tenant.md).

For the wire format and tool schemas, run:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js
```

---

## What we want from you

If you got an agent platform working that we marked **NOT-VERIFIED**:
[file a verification report](https://github.com/jmpijll/unifi-code-mode-mcp/issues/new?template=verification_report.yml)
with the snippet you used, your agent + model, and a sanitized transcript.

If you got it working with **modifications** to the snippets above
(different config path, different env-var convention, …): file a
verification report and we'll update this guide.

If you tried and failed: file a [bug report](https://github.com/jmpijll/unifi-code-mode-mcp/issues/new?template=bug_report.yml).
"It didn't work" is useful data.
