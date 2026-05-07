# UniFi expert agent — example persona

A drop-in persona + skill bundle that turns any MCP-capable AI agent into
a senior UniFi network engineer driving the
[`unifi-code-mode-mcp`](../..) server. Designed for **testers** who want
to wire this MCP into their preferred client and report back what works.

## Status

This persona is **beta**, alongside the server itself. We've smoke-
tested the persona instructions with Claude Sonnet 4.6 (Cursor) and
DeepSeek v4 Flash (opencode); we haven't tested it with most other
models. If you do — even just once with three sample prompts — file a
[verification report](../../.github/ISSUE_TEMPLATE/verification_report.yml).
Both successes and failures are useful.

## What's in this directory

| File | What it does | When to copy / link it |
|---|---|---|
| [`AGENTS.md`](AGENTS.md) | The persona itself: who the agent is, how it operates, what guardrails it follows. Designed to be loaded as a system prompt or as the agent's `AGENTS.md`. | Always — this is the headline file. |
| [`SKILL.md`](SKILL.md) | A condensed, recipe-driven companion to the root [`SKILL.md`](../../SKILL.md). Explains the 2-tool / 5-surface pattern in the persona's terms and links to recipes. | When your agent has a separate "skill" or "instructions" slot, or you're feeding both files into a single combined system prompt. |
| [`install.md`](install.md) | Cross-platform install snippets (Cursor IDE, cursor-agent, opencode, Claude Code, Claude Desktop, VS Code + Copilot, Codex CLI, Continue, Cline, MCP Inspector). | Whenever you want to wire the server up. Each platform is clearly marked **VERIFIED** or **NOT-VERIFIED**. |
| [`SAMPLE_PROMPTS.md`](SAMPLE_PROMPTS.md) | Prompts to test the persona with — HLD generation, security audit, change tracking, troubleshooting, and one prompt designed to elicit a verification report. | Whenever you've installed the server and want to validate the bundle. |

## Quick start

1. **Install the MCP server.** From the repo root:

   ```bash
   git clone https://github.com/jmpijll/unifi-code-mode-mcp.git
   cd unifi-code-mode-mcp
   npm install
   cp .env.example .env
   # set UNIFI_LOCAL_API_KEY and/or UNIFI_CLOUD_API_KEY
   npm run build
   ```

2. **Wire it into your agent.** Pick your platform from
   [`install.md`](install.md) and follow the snippet. For most platforms,
   it's a one-line stdio entry pointing at `node dist/index.js`.

3. **Adopt the persona.** Either:
   - Set [`AGENTS.md`](AGENTS.md) as the agent's system prompt, **or**
   - Copy `AGENTS.md` into your agent's persona / instructions slot
     (`.cursor/rules/`, `.claude/CLAUDE.md`, `AGENTS.md` for Codex,
     `.opencode/agent/<name>.md`, etc. — see install.md for paths).

4. **Run a sample prompt.** Try one from
   [`SAMPLE_PROMPTS.md`](SAMPLE_PROMPTS.md). The first one ("Inventory my
   network") is read-only and works against any console you have a key
   for.

5. **File a verification report.** Tell us what worked and what didn't:
   [verification report template](../../.github/ISSUE_TEMPLATE/verification_report.yml).

## Why a separate persona?

The root `AGENTS.md` is for **contributors editing the server**. The
root `SKILL.md` is for **any** MCP client driving the server, vendor-
neutral and exhaustive. This directory adds a third layer: an opinionated
**expert persona** with a fixed mental model, default workflow, and
specific guardrails (read-only by default, ask before mutations,
escalation paths for unverified surfaces).

Other agents and projects we drew tone from for this layout:

- [`modelcontextprotocol/servers`](https://github.com/modelcontextprotocol/servers) — per-server READMEs with install snippets
- [`cline/cline`](https://github.com/cline/cline) — the `.clinerules/`
  pattern for capability scoping
- Anthropic's [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) — `CLAUDE.md` as a project-scoped persona
- [`sst/opencode`](https://github.com/sst/opencode) — `.opencode/agent/`
  per-persona files

## Honest expectations

- This persona will be wrong sometimes. It is a beta on a beta.
- The server itself is honest about what's verified — see the [Project
  status](../../README.md#project-status) callout. The persona inherits
  those caveats and refuses to confidently mutate things on unverified
  surfaces without asking you first.
- If you build on this persona and ship it elsewhere, please link back
  here so the next tester can find their way to the verification
  reports.

## License

MIT, same as the rest of the repo. Copy, modify, ship — file an issue if
you find a way to make it better.
