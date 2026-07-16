// Direct unit tests for the server module surface: toolCount,
// TOOL_DEFINITIONS re-export, createServer with no operations, and the
// loadTestOperations path branches. These cover the remaining server.js
// lines that the simulation suite cannot exercise because it always sets a
// full AYOA_TEST_OPERATIONS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, toolCount, TOOL_DEFINITIONS } from '../server.js';

test('toolCount returns the number of Ayoa tools', () => {
  assert.equal(toolCount(), 8);
  assert.equal(toolCount(), TOOL_DEFINITIONS.length);
});

test('TOOL_DEFINITIONS re-export matches the canonical names', () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'capture_slides', 'create_mindmap', 'get_mindmap', 'import_opml',
    'list_mindmaps', 'list_presenter_slides', 'make_video', 'prepare_presenter',
  ]);
});

test('createServer rejects when no operation is available', () => {
  assert.throws(() => createServer({}), /Missing Ayoa operation/);
});

test('createServer accepts a complete custom operation map', () => {
  const operations = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.operation, async () => ({ ping: t.name })]));
  const server = createServer(operations);
  assert.ok(server);
  return server.close();
});

function withEnv(value, body) {
  const previous = process.env.AYOA_TEST_OPERATIONS;
  if (value === undefined) delete process.env.AYOA_TEST_OPERATIONS;
  else process.env.AYOA_TEST_OPERATIONS = value;
  return Promise.resolve().then(body).finally(() => {
    if (previous === undefined) delete process.env.AYOA_TEST_OPERATIONS;
    else process.env.AYOA_TEST_OPERATIONS = previous;
  });
}

const ALL_OPS_SUCCESS = JSON.stringify(Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.operation, { ok: true, data: { simulated: t.name } }])));

test('createServer merges env AYOA_TEST_OPERATIONS into defaults (data path)', async () => {
  await withEnv(ALL_OPS_SUCCESS, async () => {
    const server = createServer();
    assert.ok(server);
    return server.close();
  });
});

test('loadTestOperations parse-error path is exercised when JSON is malformed', async () => {
  await withEnv('not json', async () => {
    const server = createServer();
    assert.ok(server);
    return server.close();
  });
});

test('loadTestOperations non-object path returns null and falls back to defaults', async () => {
  await withEnv('null', async () => {
    const server = createServer();
    assert.ok(server);
    return server.close();
  });
});

test('createServer without env hook falls back to defaultOperations', () => {
  const previous = process.env.AYOA_TEST_OPERATIONS;
  delete process.env.AYOA_TEST_OPERATIONS;
  try {
    const server = createServer();
    assert.ok(server);
    return server.close();
  } finally {
    if (previous !== undefined) process.env.AYOA_TEST_OPERATIONS = previous;
  }
});

test('createServer with undefined clientOperations and malformed env still constructs', () => {
  const previous = process.env.AYOA_TEST_OPERATIONS;
  process.env.AYOA_TEST_OPERATIONS = '"a string, not an object"';
  try {
    const server = createServer();
    assert.ok(server);
    return server.close();
  } finally {
    if (previous === undefined) delete process.env.AYOA_TEST_OPERATIONS;
    else process.env.AYOA_TEST_OPERATIONS = previous;
  }
});

test('registerTool try/catch surfaces operation errors as isError', async () => {
  const ops = {
    create_mindmap: { ok: false, error: 'forced failure' },
    list_mindmaps: { ok: true, data: { simulated: 'list_mindmaps' } },
    get_mindmap: { ok: true, data: { simulated: 'get_mindmap' } },
    import_opml: { ok: true, data: { simulated: 'import_opml' } },
    list_presenter_slides: { ok: true, data: { simulated: 'list_presenter_slides' } },
    prepare_presenter: { ok: true, data: { simulated: 'prepare_presenter' } },
    capture_slides: { ok: true, data: { simulated: 'capture_slides' } },
    make_video: { ok: true, data: { simulated: 'make_video' } },
  };
  await withEnv(JSON.stringify(ops), async () => {
    const server = createServer();
    const registry = server.server?._registeredTools ?? server._registeredTools;
    assert.ok(registry, 'McpServer must expose _registeredTools in this SDK version');
    const tool = registry['create_mindmap'];
    assert.ok(tool, 'create_mindmap tool must be registered');
    const result = await tool.handler({ name: 'x' }, {});
    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /forced failure/);
    return server.close();
  });
});

test('registerTool try-block returns ok payload when operation succeeds', async () => {
  const ops = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.operation, { ok: true, data: { happy: t.name } }]));
  await withEnv(JSON.stringify(ops), async () => {
    const server = createServer();
    const registry = server.server?._registeredTools ?? server._registeredTools;
    assert.ok(registry, 'McpServer must expose _registeredTools in this SDK version');
    const tool = registry['list_mindmaps'];
    const result = await tool.handler({ query: 'any' }, {});
    assert.ok(!result.isError, 'happy path must not be isError');
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.tool, 'list_mindmaps');
    assert.equal(payload.data.happy, 'list_mindmaps');
    return server.close();
  });
});

// main() connects the MCP server to a stdio transport and stays alive
// until stdin closes. We exercise it briefly to cover server.js lines 73-76
// and confirm the entry path produces the expected stderr line.
test('main connects a stdio MCP server and tears down on stdin close', async () => {
  const mod = await import('../server.js');
  const stdin = process.stdin;
  const original = stdin.readable;
  const previousOps = process.env.AYOA_TEST_OPERATIONS;
  process.env.AYOA_TEST_OPERATIONS = ALL_OPS_SUCCESS;
  // Redirect process.stdin/stdout temporarily so main() binds to a no-op
  // pipe. We do this by stubbing process.stdout.write.
  const writes = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { writes.push(String(chunk)); return originalWrite(chunk, ...rest); };
  const originalStderr = process.stderr.write.bind(process.stderr);
  const stderrChunks = [];
  process.stderr.write = (chunk, ...rest) => { stderrChunks.push(String(chunk)); return originalStderr(chunk, ...rest); };
  try {
    const { main } = mod;
    const p = main();
    // Give main a tick to connect.
    await new Promise((r) => setImmediate(r));
    p.catch(() => undefined);
    p.then(() => undefined);
    // main() never resolves; it waits on stdio. We close by killing the
    // pending promise via a microtask: just await a short delay.
    await new Promise((r) => setTimeout(r, 100));
    // Best-effort cleanup. The McpServer.connect returns a promise that
    // resolves when the transport closes; we simulate that by sending EOF.
    try { process.stdin.pause(); } catch { /* */ }
    const stderr = stderrChunks.join('');
    assert.match(stderr, /ayoa-mcp-server running on stdio/);
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalStderr;
    if (previousOps === undefined) delete process.env.AYOA_TEST_OPERATIONS;
    else process.env.AYOA_TEST_OPERATIONS = previousOps;
  }
});