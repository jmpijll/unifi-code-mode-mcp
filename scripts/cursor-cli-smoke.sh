#!/usr/bin/env bash
# Smoke test that drives the MCP server through the real `cursor-agent` CLI.
#
# This is NOT run in CI — the Vitest integration suite covers the protocol
# layer without depending on cursor-agent. Use this script when you want
# to validate the IDE/CLI client wiring on your machine.
#
# Layers:
#   1. mcp list                  — confirm the server appears.
#   2. mcp list-tools unifi      — confirm both tools are exposed (no LLM auth needed).
#   3. (optional) --print prompt — drive an LLM-mediated call.
#                                  See docs/cursor-skill.md for the known-issue
#                                  caveat about --print mode and custom MCPs.
#   4. (optional, --pty) drive   — drive cursor-agent in interactive PTY mode via
#                                  expect(1). This is currently the strongest
#                                  LLM-mediated proof we can get out of the
#                                  cursor-agent CLI. See out/verification/.
#
# Prerequisites:
#   - cursor-agent on PATH (https://cursor.com/docs/cli)
#   - This repo built (`npm run build`)
#   - Either:
#       a) UNIFI_LOCAL_API_KEY + UNIFI_LOCAL_BASE_URL exported in the shell, OR
#       b) UNIFI_CLOUD_API_KEY exported, OR
#       c) Nothing — the server still starts; only the cloud-fallback spec is loaded.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v cursor-agent >/dev/null 2>&1; then
  cat >&2 <<EOF
[smoke] cursor-agent not found on PATH.

  Install:  curl https://cursor.com/install -fsS | bash
  Or skip:  the Vitest integration suite (npm test) covers the protocol layer
            without depending on the CLI.
EOF
  exit 2
fi

echo "[smoke] cursor-agent: $(cursor-agent --version 2>&1 | head -n 1)"

if [[ ! -f "$ROOT/dist/index.js" ]]; then
  echo "[smoke] dist/ missing — running 'npm run build' …"
  npm run build >/dev/null
fi

if [[ ! -f "$ROOT/.cursor/mcp.json" ]]; then
  echo "[smoke] .cursor/mcp.json missing — this repo ships one. Did you delete it?" >&2
  exit 1
fi

echo
echo "[smoke] [1/3] enabling + listing the server …"
cursor-agent mcp enable unifi
echo
cursor-agent mcp list | grep -E "^unifi" || {
  echo "[smoke] FAIL — server not listed" >&2
  exit 1
}

echo
echo "[smoke] [2/3] listing the server's tools (no LLM auth required) …"
TOOLS_OUT="$(cursor-agent mcp list-tools unifi)"
echo "$TOOLS_OUT"
if ! echo "$TOOLS_OUT" | grep -q "search" || ! echo "$TOOLS_OUT" | grep -q "execute"; then
  echo "[smoke] FAIL — expected both 'search' and 'execute' tools" >&2
  exit 1
fi
echo "[smoke] [2/3] ok — both tools registered."

echo
echo "[smoke] [3/3] (optional) LLM-mediated --print invocation …"
if ! cursor-agent status 2>&1 | grep -q "Logged in"; then
  echo "[smoke] not logged in — skipping LLM smoke. Run 'cursor-agent login' to enable."
  exit 0
fi

mkdir -p "$ROOT/out"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$ROOT/out/cursor-smoke-${TS}.json"

# NOTE: in current cursor-agent versions, --print mode with composer-2-fast
# does not register custom MCP servers as model-callable tools. The model may
# answer correctly by spawning the server over stdio itself. This is documented
# in docs/cursor-skill.md §8 ("Known limitations specific to Cursor").
cursor-agent --print --output-format json --approve-mcps --force --trust \
  "Call the search tool of the 'unifi' MCP server with code='spec.cloud ? spec.cloud.operations.length : 0'. Return ONLY the tool's text output. Do not invent." \
  > "$OUT" 2>"$OUT.stderr" || true

echo "[smoke] LLM result saved to $OUT"
RESULT="$(jq -r '.result // empty' < "$OUT" 2>/dev/null)"
if [[ -n "$RESULT" ]]; then
  echo "[smoke] result: $RESULT" | head -3
fi

if [[ "${1:-}" == "--pty" ]]; then
  echo
  echo "[smoke] [4/4] PTY/interactive LLM-mediated call (model: ${PTY_MODEL:-claude-4.6-sonnet-medium}) …"
  if ! command -v expect >/dev/null 2>&1; then
    echo "[smoke] expect(1) not installed — skipping PTY layer." >&2
    exit 0
  fi
  PTY_MODEL="${PTY_MODEL:-claude-4.6-sonnet-medium}" \
    expect "$ROOT/scripts/cursor-agent-pty-smoke.exp" "$PTY_MODEL" || {
      echo "[smoke] PTY layer was inconclusive — see out/cursor-agent-pty-*.log" >&2
      exit 0
    }
fi
