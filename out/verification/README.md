# Verification artefacts

This directory contains sanitized transcripts of every live
end-to-end verification we have run against real hardware or real
LLM clients. Each `*.txt` file is a self-contained record of one
verification — what it proves, what it does not prove, the
verbatim command, the actual output, and probe metadata.

## Naming convention

| File | What it records |
|---|---|
| `cloud-protect-live-smoke.txt` | Read-only Protect sweep through `unifi.cloud.protect(consoleId)` |
| `local-network-live-smoke.txt` | Read-only Network sweep through `unifi.local.*` |
| `local-protect-live-smoke.txt` | Read-only Protect sweep through `unifi.local.protect.*` |
| `mutation-live-smoke.txt` | Camera-rename round-trip on Protect (PATCH then revert) |
| `mutation-rtsps-live-smoke.txt` | RTSPS-stream toggle round-trip on Protect (DELETE then POST recreate) |
| `mcp-inspector-live-smoke.txt` | MCP Inspector CLI mode end-to-end |
| `mcp-inspector-ui-live-smoke.txt` | MCP Inspector **UI** (browser) mode end-to-end |
| `mcp-inspector-ui-tools-list.png` | UI screenshot — connected, tools/list populated |
| `mcp-inspector-ui-execute-success.png` | UI screenshot — execute call result |
| `cursor-agent-sonnet-mcp-call.txt` | Sonnet 4.6 driving the cloud surface via cursor-agent |
| `opencode-deepseek-mcp-call.txt` | DeepSeek v4 Flash driving the cloud surface via opencode |
| `opencode-deepseek-local-mcp-call.txt` | DeepSeek v4 Flash driving `unifi.local.*` (Network) |
| `opencode-deepseek-local-protect-mcp-call.txt` | DeepSeek v4 Flash driving `unifi.local.protect.*` |
| `claude-code-cli-mcp-handshake.txt` | Claude Code CLI v2.0.47 MCP register + connect handshake |
| `cf-worker-parity-smoke.txt` | `wrangler dev` parity smoke for the Cloudflare Workers entry |

## What sanitization means here

These transcripts are written to be safe for a public repo while
still being **useful for reproducibility**. Concretely:

### Always redacted

- API keys (`UNIFI_LOCAL_API_KEY`, `UNIFI_CLOUD_API_KEY`,
  `MCP_PROXY_AUTH_TOKEN`, etc.) — replaced with `<redacted>`.
- Absolute home-directory paths (`/Users/<name>/…`) — replaced
  with `/path/to/unifi-code-mode-mcp` so they don't leak the
  maintainer's username.
- 1Password vault references stay intact (they're public references,
  not secrets).

### Intentionally kept

- **`172.27.1.1`** — the maintainer's homelab UDM-Pro at the time
  the verification was run. This is an RFC1918 address (private
  LAN, not routable on the public internet), so it does not
  identify a publicly-reachable host. Keeping the real address
  makes transcripts easier to reason about than scattered
  `<controller>` placeholders. If you need to reproduce the
  verification on your own controller, swap in your own LAN IP.
- Real camera names (`Daisy`, `Cnc`, `Voordeur`, `Tuin`) — the
  maintainer's homelab cameras. No camera names are sensitive.
- Real site name (`Default`).
- RTSPS stream tokens — these rotate on every POST and are
  invalidated as soon as the camera goes through a state change.
  Tokens shown in any transcript are stale by the time you read it.
- Spec version strings (`Network 10.3.58`, `Protect 7.0.107`) —
  publicly known UniFi release identifiers.

### Why this policy

The honest tradeoff is between "transcripts as PR-safe artefacts"
and "transcripts as something a stranger can replicate against
their own hardware". Aggressive blanket redaction (e.g. replacing
every IP with `<x.x.x.x>`) makes the documents harder to read,
especially when several variants of an IP appear in the same
session. RFC1918 IPs reveal nothing exploitable; usernames and
absolute home paths do. We redact the latter and leave the former.

If you find anything in a committed transcript that you think
should not be there, please file a security advisory — see
[SECURITY.md](../../SECURITY.md).
