#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOL_DEFINITIONS } from './tools.js';
import { operations } from './ayoa-client.js';

export function createServer(clientOperations = operations) {
  const server = new McpServer({ name: 'ayoa-mcp-server', version: '0.2.0' });

  for (const tool of TOOL_DEFINITIONS) {
    const operation = clientOperations[tool.operation];
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
