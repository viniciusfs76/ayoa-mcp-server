// Simulate every Ayoa tool through the MCP stdio transport with a mocked
// ayoa-client. The harness spawns the real server but server.js accepts an
// injected client via AYOA_TEST_OPERATIONS env var (a JSON map name->JSON
// response or JSON error). When the env var is set, server.js should use
// the injected response instead of launching Chromium.
//
// This is the regression contract: every tool must be reachable, every
// schema must be enforced, every result must round-trip, and every failure
// path must surface as isError.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const TOOL_NAMES = [
  'create_mindmap', 'list_mindmaps', 'get_mindmap', 'import_opml',
  'list_presenter_slides', 'prepare_presenter', 'capture_slides', 'make_video',
];

const REQUIRED_ARGS = {
  create_mindmap: { name: 'Mapa de Teste' },
  get_mindmap: { mindmap_id: '00000000-0000-0000-0000-000000000000' },
  import_opml: { opml_file: '/tmp/test.opml' },
  list_presenter_slides: { target: 'https://app.ayoa.com/mindmaps/00000000-0000-0000-0000-000000000000' },
  prepare_presenter: { target: 'https://app.ayoa.com/mindmaps/00000000-0000-0000-0000-000000000000' },
  capture_slides: { target: 'https://app.ayoa.com/mindmaps/00000000-0000-0000-0000-000000000000' },
  make_video: { input_dir: '/tmp/slides' },
};
async function startWithOperations(operations) {
  const child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      AYOA_TEST_OPERATIONS: JSON.stringify(operations),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const pending = new Map();
  let nextId = 1;
  let killed = false;
  let resolveInit, rejectInit;
  const initPromise = new Promise((resolve, reject) => { resolveInit = resolve; rejectInit = reject; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (typeof message?.id === 'number' && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message);
      } else if (typeof message?.id === 'number' && message.id === 0 && resolveInit) {
        resolveInit(message);
        resolveInit = null;
        rejectInit = null;
      }
    }
  });
  child.stderr.on('data', () => undefined);
  child.once('error', (err) => { if (rejectInit) rejectInit(err); });
  child.once('exit', () => { if (rejectInit) rejectInit(new Error('subprocess exited early')); });
  setTimeout(() => { if (rejectInit) rejectInit(new Error('init timeout')); }, 5000);
  const initPayload = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sim', version: '0' } };
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: initPayload }) + '\n');
  await initPromise;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  return {
    call(method, params) {
      if (killed) return Promise.reject(new Error('subprocess killed'));
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`call timeout: ${method}`)); } }, 4000);
      });
    },
    async close() {
      killed = true;
      if (!child.killed) {
        try { child.stdin.end(); } catch { /* */ }
        child.kill();
      }
      for (const [, { reject }] of pending) reject(new Error('subprocess closed'));
      pending.clear();
      await new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', r); });
    },
  };
}

const RESPONSE = (tool) => ({ ok: true, tool, data: { simulated: tool } });
const ERROR = (tool, msg) => ({ ok: false, tool, error: msg });

for (const tool of TOOL_NAMES) {
  test(`${tool}: call with required args returns the operation result`, async () => {
    const operations = {};
    for (const t of TOOL_NAMES) operations[t] = RESPONSE(t);
    operations[tool] = RESPONSE(tool);
    const server = await startWithOperations(operations);
    try {
      const result = await server.call('tools/call', {
        name: tool,
        arguments: REQUIRED_ARGS[tool] ?? {},
      });
      assert.equal(result.error, undefined, `${tool} must not produce JSON-RPC error`);
      const text = result.result?.content?.[0]?.text;
      const payload = JSON.parse(text);
      assert.equal(payload.ok, true);
      assert.equal(payload.tool, tool);
      assert.equal(payload.data.simulated, tool);
    } finally {
      await server.close();
    }
  });

  test(`${tool}: missing required input returns InvalidParams`, async () => {
    // Tools with strictly optional args (e.g. list_mindmaps) accept `{}`.
    const optional = new Set(['list_mindmaps']);
    const operations = {};
    for (const t of TOOL_NAMES) operations[t] = RESPONSE(t);
    operations[tool] = RESPONSE(tool);
    const server = await startWithOperations(operations);
    try {
      const result = await server.call('tools/call', { name: tool, arguments: {} });
      if (optional.has(tool)) {
        assert.equal(result.error, undefined, `${tool} accepts empty args (all optional)`);
        const payload = JSON.parse(result.result?.content?.[0]?.text ?? '{}');
        assert.equal(payload.ok, true);
        return;
      }
      if (result.error) {
        assert.equal(result.error.code, -32602);
        return;
      }
      const text = result.result?.content?.[0]?.text ?? '';
      assert.ok(result.result?.isError || /required|missing|Invalid|expected/i.test(text),
        `${tool}: missing arg should be rejected; got: ${text.slice(0,200)}`);
    } finally {
      await server.close();
    }
  });

  test(`${tool}: operation error becomes isError result`, async () => {
    const operations = {};
    for (const t of TOOL_NAMES) operations[t] = RESPONSE(t);
    operations[tool] = ERROR(tool, 'simulated failure');
    const server = await startWithOperations(operations);
    try {
      const result = await server.call('tools/call', {
        name: tool,
        arguments: REQUIRED_ARGS[tool] ?? {},
      });
      assert.equal(result.error, undefined, 'operation error should not produce JSON-RPC error');
      const payload = JSON.parse(result.result?.content?.[0]?.text ?? '{}');
      assert.equal(payload.ok, false);
      assert.equal(payload.error, 'simulated failure');
      assert.equal(result.result?.isError, true);
    } finally {
      await server.close();
    }
  });
}

test('tools/list contains no nlm_ or notebooklm tools', async () => {
  const server = await startWithOperations({});
  try {
    const result = await server.call('tools/list', {});
    const names = (result.result?.tools ?? []).map((t) => t.name);
    assert.ok(names.every((n) => !n.startsWith('nlm_')));
    assert.ok(names.every((n) => !n.includes('notebooklm')));
  } finally {
    await server.close();
  }
});
