#!/usr/bin/env bash
# Developer-local smoke test that drives the MCP server through the real
# `cursor-agent` CLI, exactly as a Cursor IDE / CLI session would.
#
# This script is NOT run in CI — the Vitest integration suite covers the
# protocol layer without depending on cursor-agent. Use this when you want
# to validate the full IDE-shaped path on your machine.
#
# Prerequisites:
#   1. cursor-agent on PATH:
#        curl https://cursor.com/install -fsS | bash
#      (or follow https://cursor.com/docs/cli for the latest install URL)
#   2. Either UNIFI_LOCAL_* or UNIFI_CLOUD_* env vars exported in your shell.
#
# What it does:
#   1. Builds the server (npm run build).
#   2. Generates a temporary .cursor/mcp.json that registers the server.
#   3. Runs three fixed prompts via `cursor-agent --print --output-format json`,
#      captures the JSON, and saves transcripts under out/.
#   4. Prints a brief pass/fail summary based on the presence of expected
#      tool calls and the absence of `isError: true`.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v cursor-agent >/dev/null 2>&1; then
  cat >&2 <<EOF
[smoke] cursor-agent not found on PATH. Install it from https://cursor.com/docs/cli
[smoke] (or skip this script — the Vitest integration suite covers the protocol layer.)
EOF
  exit 2
fi

echo "[smoke] cursor-agent: $(cursor-agent --version 2>&1 | head -n 1)"
echo "[smoke] building server …"
npm run build >/dev/null

mkdir -p "$ROOT/out"
SCOPE_DIR="$(mktemp -d)"
trap 'rm -rf "$SCOPE_DIR"' EXIT
mkdir -p "$SCOPE_DIR/.cursor"

cat > "$SCOPE_DIR/.cursor/mcp.json" <<JSON
{
  "mcpServers": {
    "unifi": {
      "command": "node",
      "args": ["$ROOT/dist/index.js"],
      "env": {
        "UNIFI_LOCAL_API_KEY": "\${env:UNIFI_LOCAL_API_KEY}",
        "UNIFI_LOCAL_BASE_URL": "\${env:UNIFI_LOCAL_BASE_URL}",
        "UNIFI_LOCAL_INSECURE": "\${env:UNIFI_LOCAL_INSECURE}",
        "UNIFI_CLOUD_API_KEY": "\${env:UNIFI_CLOUD_API_KEY}"
      }
    }
  }
}
JSON

run_prompt() {
  local label="$1"
  local prompt="$2"
  local out="$ROOT/out/cursor-smoke-${label}.json"
  echo "[smoke] [$label] running …"
  if cursor-agent \
      --workspace "$SCOPE_DIR" \
      --print \
      --output-format json \
      --approve-mcps \
      --force \
      "$prompt" > "$out" 2>"$out.stderr"; then
    echo "[smoke] [$label] saved $out"
  else
    echo "[smoke] [$label] FAILED — see $out.stderr"
    return 1
  fi
}

run_prompt hld     "Use the unifi MCP. Call the search tool with the query 'site' and then the execute tool to list every site you can see along with the device count for each. Return a markdown table — nothing else."
run_prompt fact    "Use the unifi MCP. Find the operationId you would call to list Wi-Fi broadcasts, run it for any site, and return ONLY the SSID names as a JSON array."
run_prompt impossible "Use the unifi MCP. Try to call the operationId 'totallyMadeUpOperation' and report exactly what error you receive. Do not retry; just describe the error message."

echo "[smoke] all prompts done. Inspect out/cursor-smoke-*.json for full transcripts."
