#!/usr/bin/env bash
set -euo pipefail

# CI contract: inspect the MCP server without Ayoa credentials or side effects.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

output="$(npx --no-install @modelcontextprotocol/inspector --cli node server.js --method tools/list)"

printf '%s\n' "$output" | node --input-type=module -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const payload = JSON.parse(input);
  const names = (payload.tools || []).map(tool => tool.name);
  const required = ["create_mindmap", "list_mindmaps", "get_mindmap", "import_opml", "list_presenter_slides", "prepare_presenter", "capture_slides", "make_video"];
  const missing = required.filter(name => !names.includes(name));
  if (missing.length || names.some(name => name.startsWith("nlm_"))) {
    console.error(JSON.stringify({ names, missing }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ tool_count: names.length, tools: names }, null, 2));
});
'
