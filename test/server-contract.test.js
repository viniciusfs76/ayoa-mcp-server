import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';

const operations = Object.fromEntries([
  'create_mindmap', 'list_mindmaps', 'get_mindmap', 'import_opml',
  'list_presenter_slides', 'prepare_presenter', 'capture_slides', 'make_video',
].map((name) => [name, async () => ({ operation: name })]));

test('MCP server creates without live Ayoa credentials', async () => {
  const server = createServer(operations);
  assert.ok(server);
  await server.close();
});
