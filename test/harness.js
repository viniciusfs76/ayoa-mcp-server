// Helper: open the MCP server as a real subprocess over stdio and talk JSON-RPC to it.
//
// MCP SDK 1.28+ uses NDJSON over stdio (one JSON-RPC message per line, no
// Content-Length framing). This harness speaks the wire format the SDK
// itself produces.
import { spawn } from 'node:child_process';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'ayoa-mcp-suite', version: '0.0.0' };

function serializeMessage(message) {
  return JSON.stringify(message) + '\n';
}

export async function startServer({ env = {}, cwd = process.cwd() } = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  const stderrChunks = [];
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
  child.on('error', () => undefined);

  const ready = new Promise((resolve, reject) => {
    let resolved = false;
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (typeof message?.id === 'number' && pending.has(message.id)) {
          const { resolve: r, reject: rj } = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) rj(new Error(JSON.stringify(message.error)));
          else r(message);
        } else if (typeof message?.id === 'number' && message.id === 0 && !resolved) {
          resolved = true;
          resolve(message);
        }
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      if (!resolved) reject(new Error(`server exited (code=${code}) before responding`));
    });
    child.once('error', reject);
  });

  function writeRequest(method, params) {
    const id = nextId++;
    const payload = { jsonrpc: '2.0', id, method, params: params ?? {} };
    child.stdin.write(serializeMessage(payload));
    return id;
  }

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = writeRequest(method, params);
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`call timeout: ${method}`));
        }
      }, 8000);
    });
  }

  function notify(method, params) {
    child.stdin.write(serializeMessage({ jsonrpc: '2.0', method, params: params ?? {} }));
  }

  const initPayload = {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { sampling: {}, roots: { listChanged: true } },
    clientInfo: CLIENT_INFO,
  };
  child.stdin.write(serializeMessage({ jsonrpc: '2.0', id: 0, method: 'initialize', params: initPayload }));
  const initResult = await ready;
  notify('notifications/initialized', {});

  return {
    call,
    notify,
    serverInfo: initResult.result?.serverInfo ?? null,
    protocolVersion: initResult.result?.protocolVersion ?? null,
    capabilities: initResult.result?.capabilities ?? {},
    stderr: () => Buffer.concat(stderrChunks).toString('utf8'),
    async close() {
      if (!child.killed) {
        try { child.stdin.end(); } catch { /* ignore */ }
        child.kill();
      }
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}
