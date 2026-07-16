#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOL_DEFINITIONS } from './tools.js';
import { operations as defaultOperations } from './ayoa-client.js';

// Test hook: when AYOA_TEST_OPERATIONS is set to a JSON map, the server
// uses the injected responses instead of launching Puppeteer. This lets the
// CI pipeline exercise every tool without credentials or a real Ayoa
// account. Format: { "<operation_name>": { "ok": true|false, ...payload } }.
//
// Injected operations merge with the default ones: the missing keys fall
// back to a generic "test operation" that records the input. This keeps
// every tool reachable in the test harness even when the test only needs
// to exercise a subset of operations.
function loadTestOperations(defaults) {
  const raw = process.env.AYOA_TEST_OPERATIONS;
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) {
    console.error(`[ayoa-mcp] failed to parse AYOA_TEST_OPERATIONS: ${err.message}`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const merged = { ...(defaults || {}) };
  for (const [name, value] of Object.entries(parsed)) {
    merged[name] = async (args) => {
      if (value && value.ok === false) {
        const err = new Error(value.error || 'simulated failure');
        err.simulated = value;
        throw err;
      }
      if (value && value.data !== undefined) return value.data;
      if (value && value.simulated) return { simulated: value.simulated, args };
      return value;
    };
  }
  return merged;
}

export function toolCount() {
  return TOOL_DEFINITIONS.length;
}

export { TOOL_DEFINITIONS } from './tools.js';

export function createServer(clientOperations) {
  const injected = clientOperations ?? loadTestOperations(defaultOperations);
  const operations = injected ?? defaultOperations;
  const server = new McpServer({ name: 'ayoa-mcp-server', version: '0.2.0' });

  for (const tool of TOOL_DEFINITIONS) {
    const operation = operations[tool.operation];
    if (typeof operation !== 'function') throw new Error(`Missing Ayoa operation: ${tool.operation}`);
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: ['list_mindmaps', 'get_mindmap', 'list_presenter_slides'].includes(tool.name), destructiveHint: false, openWorldHint: true },
    }, async (args) => {
      try {
        const result = await operation(args || {});
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: tool.name, data: result }, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, tool: tool.name, error: error instanceof Error ? error.message : String(error) }, null, 2) }] };
      }
    });
  }

  return server;
}

export async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error('ayoa-mcp-server running on stdio');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
