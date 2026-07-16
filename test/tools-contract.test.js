import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS, toolNames } from '../tools.js';

const REQUIRED = [
  'create_mindmap',
  'list_mindmaps',
  'get_mindmap',
  'import_opml',
  'list_presenter_slides',
  'prepare_presenter',
  'capture_slides',
  'make_video',
];

test('registry exposes the Ayoa mindmapping tools', () => {
  const names = toolNames();
  for (const name of REQUIRED) assert.ok(names.includes(name), `missing ${name}`);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every(name => !name.startsWith('nlm_')));
});

test('create_mindmap has a self-contained input schema', () => {
  const tool = TOOL_DEFINITIONS.find(item => item.name === 'create_mindmap');
  assert.deepEqual(Object.keys(tool.inputSchema).sort(), ['cookies_file', 'name']);
  assert.equal(typeof tool.inputSchema.name.parse, 'function');
});

test('list_mindmaps is read-only and accepts an optional query', () => {
  const tool = TOOL_DEFINITIONS.find(item => item.name === 'list_mindmaps');
  assert.match(tool.description, /list/i);
  assert.equal(typeof tool.inputSchema.query.parse, 'function');
  assert.equal(typeof tool.inputSchema.cookies_file.parse, 'function');
});

test('destructive operations are not silently exposed', () => {
  const destructive = TOOL_DEFINITIONS.filter(item => /delete|remove/i.test(item.name));
  assert.deepEqual(destructive, []);
});
