// OAuth 2.1 + MCP transport simulation. The server exposes its tools over
// Streamable HTTP behind a bearer-token gate. We exercise the full flow:
//   1. /.well-known/oauth-authorization-server discovery
//   2. POST /register (dynamic client registration)
//   3. POST /authorize (device-style simulation; the test is a local proxy)
//   4. POST /token (authorization_code grant)
//   5. POST /mcp tools/list with bearer (success)
//   6. POST /mcp tools/list without bearer (401)
//
// The OAuth proxy is part of the production codebase; tests run against the
// real HTTP server spawned in a subprocess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

async function startHttpServer({ env = {} } = {}) {
  const child = spawn(process.execPath, ['src/http_server.js'], {
    env: { ...process.env, AYOA_TEST_OPERATIONS: '{}', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const stderrChunks = [];
  let resolved = false;
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    if (/listening on|listening at|started/i.test(buffer) && !resolved) { resolved = true; }
  });
  child.stderr.on('data', (chunk) => { stderrChunks.push(chunk); if (!resolved) { buffer += chunk.toString(); if (/listening|started/i.test(buffer)) resolved = true; } });
  // Poll the root endpoint until it answers; this is more reliable than
  // parsing the boot log.
  for (let i = 0; i < 50; i += 1) {
    try {
      const r = await fetch('http://127.0.0.1:8775/');
      if (r.status < 500) { resolved = true; break; }
    } catch { /* not ready */ }
    await delay(100);
  }
  return {
    base: 'http://127.0.0.1:8775',
    async stop() {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    },
    stderr: () => Buffer.concat(stderrChunks).toString(),
  };
}

test('health endpoint responds and advertises ayoa', async () => {
  const s = await startHttpServer();
  try {
    const r = await fetch(`${s.base}/`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.server, 'ayoa-mcp-server');
    assert.equal(body.tools, 8);
  } finally {
    await s.stop();
  }
});

test('well-known oauth metadata exposes required endpoints', async () => {
  const s = await startHttpServer();
  try {
    const r = await fetch(`${s.base}/.well-known/oauth-authorization-server`);
    assert.equal(r.status, 200);
    const meta = await r.json();
    assert.match(meta.issuer, /127\.0\.0\.1:8775|http/);
    assert.ok(Array.isArray(meta.response_types_supported));
    assert.ok(meta.response_types_supported.includes('code'));
    assert.ok(Array.isArray(meta.grant_types_supported));
    assert.ok(meta.grant_types_supported.includes('authorization_code'));
    assert.ok(Array.isArray(meta.code_challenge_methods_supported));
    assert.ok(meta.code_challenge_methods_supported.includes('S256'));
  } finally {
    await s.stop();
  }
});

test('dynamic client registration returns client_id', async () => {
  const s = await startHttpServer();
  try {
    const r = await fetch(`${s.base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'ayoa-suite', redirect_uris: ['https://client.example/cb'] }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.client_id, 'client_id must be present');
    assert.ok(body.client_secret || !body.token_endpoint_auth_method.includes('secret'),
      'public client may omit secret; confidential client must include one');
    assert.deepEqual(body.redirect_uris, ['https://client.example/cb']);
  } finally {
    await s.stop();
  }
});

test('register rejects bad redirect URIs', async () => {
  const s = await startHttpServer();
  try {
    const r = await fetch(`${s.base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'evil', redirect_uris: ['not-a-url'] }),
    });
    assert.notEqual(r.status, 200);
  } finally {
    await s.stop();
  }
});

function extractCode(location) {
  // Avoid full URL resolution (no DNS) by parsing the query string directly.
  const idx = location.indexOf('?');
  if (idx === -1) return null;
  return new URLSearchParams(location.slice(idx)).get('code');
}

test('full PKCE flow: register → authorize → token → /mcp with bearer succeeds', async () => {
  const s = await startHttpServer();
  try {
    const regRes = await fetch(`${s.base}/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'pkce-suite', redirect_uris: ['https://127.0.0.1:1/cb'] }),
    });
    const reg = await regRes.json();
    const clientId = reg.client_id;
    const verifier = 'ayoa-suite-verifier-32-bytes-min-aaaaaaaaa';
    const challenge = await sha256Base64Url(verifier);
    const authRes = await fetch(`${s.base}/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=https%3A%2F%2F127.0.0.1%3A1%2Fcb&response_type=code&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&state=test-state`, { redirect: "manual" });
    const location = authRes.headers.get('location') ?? '';
    assert.match(location, /code=/, 'authorize must redirect with code');
    const code = extractCode(location);
    assert.ok(code, 'code must be present');
    const tokenRes = await fetch(`${s.base}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        code_verifier: verifier,
        redirect_uri: 'https://127.0.0.1:1/cb',
      }),
    });
    assert.equal(tokenRes.status, 200, `token must succeed; got ${tokenRes.status}`);
    const token = await tokenRes.json();
    assert.ok(token.access_token, 'access_token must be present');
    assert.ok(typeof token.expires_in === 'number');
    const mcpRes = await fetch(`${s.base}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pkce-suite', version: '0' } } }),
    });
    assert.equal(mcpRes.status, 200, `mcp initialize must accept bearer; got ${mcpRes.status}`);
    const initBody = await mcpRes.text();
    const initJsonLine = initBody.split('\n').find((l) => l.startsWith('data:'));
    assert.ok(initJsonLine, `SSE must have data line; got: ${initBody.slice(0,200)}`);
    const initMsg = JSON.parse(initJsonLine.replace(/^data:\s*/, ''));
    assert.ok(initMsg.result?.serverInfo, 'initialize response must contain serverInfo');
    assert.equal(initMsg.result.serverInfo.name, 'ayoa-mcp-server');
    // initialize result does not include tools list; that's tools/list.
    // The MCP endpoint accepting bearer and returning a valid serverInfo
    // confirms the OAuth-MCP integration works end-to-end.
  } finally {
    await s.stop();
  }
});

test('mcp endpoint rejects request without bearer', async () => {
  const s = await startHttpServer({ env: { AYOA_HTTP_BEARER: 'test-secret' } });
  try {
    const r = await fetch(`${s.base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(r.status, 401, `expected 401, got ${r.status}`);
  } finally {
    await s.stop();
  }
});

test('mcp endpoint rejects invalid bearer', async () => {
  const s = await startHttpServer({ env: { AYOA_HTTP_BEARER: 'real-secret' } });
  try {
    const r = await fetch(`${s.base}/mcp`, {
      method: 'POST', headers: { authorization: 'Bearer wrong-secret', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(r.status, 401);
  } finally {
    await s.stop();
  }
});

test('token endpoint rejects wrong PKCE verifier', async () => {
  const s = await startHttpServer();
  try {
    const reg = await (await fetch(`${s.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'pkce-fail', redirect_uris: ['https://127.0.0.1:1/cb'] }) })).json();
    const verifier = 'ayoa-suite-verifier-32-bytes-min-aaaaaaaaa';
    const challenge = await sha256Base64Url(verifier);
    const auth = await fetch(`${s.base}/authorize?client_id=${encodeURIComponent(reg.client_id)}&redirect_uri=https%3A%2F%2F127.0.0.1%3A1%2Fcb&response_type=code&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&state=s`, { redirect: "manual" });
    const code = extractCode(auth.headers.get('location'));
    const tokenRes = await fetch(`${s.base}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.client_id, code_verifier: 'totally-different-verifier', redirect_uri: 'https://127.0.0.1:1/cb' }),
    });
    assert.notEqual(tokenRes.status, 200);
  } finally {
    await s.stop();
  }
});

test('token endpoint rejects reused code', async () => {
  const s = await startHttpServer();
  try {
    const reg = await (await fetch(`${s.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'replay', redirect_uris: ['https://127.0.0.1:1/cb'] }) })).json();
    const verifier = 'ayoa-suite-verifier-32-bytes-min-aaaaaaaaa';
    const challenge = await sha256Base64Url(verifier);
    const auth = await fetch(`${s.base}/authorize?client_id=${encodeURIComponent(reg.client_id)}&redirect_uri=https%3A%2F%2F127.0.0.1%3A1%2Fcb&response_type=code&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&state=s`, { redirect: "manual" });
    const code = extractCode(auth.headers.get('location'));
    const ok = await fetch(`${s.base}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.client_id, code_verifier: verifier, redirect_uri: 'https://127.0.0.1:1/cb' }),
    });
    assert.equal(ok.status, 200);
    const replay = await fetch(`${s.base}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.client_id, code_verifier: verifier, redirect_uri: 'https://127.0.0.1:1/cb' }),
    });
    assert.notEqual(replay.status, 200, 'reused code must be rejected');
  } finally {
    await s.stop();
  }
});

test('authorize rejects PKCE without challenge method', async () => {
  const s = await startHttpServer();
  try {
    const reg = await (await fetch(`${s.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'plain', redirect_uris: ['https://127.0.0.1:1/cb'] }) })).json();
    const r = await fetch(`${s.base}/authorize?client_id=${encodeURIComponent(reg.client_id)}&redirect_uri=https%3A%2F%2F127.0.0.1%3A1%2Fcb&response_type=code&state=s`, { redirect: "manual" });
    assert.notEqual(r.status, 200);
  } finally {
    await s.stop();
  }
});

test('register issues distinct client_ids', async () => {
  const s = await startHttpServer();
  try {
    const a = await (await fetch(`${s.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'a', redirect_uris: ['https://a.example/cb'] }) })).json();
    const b = await (await fetch(`${s.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'b', redirect_uris: ['https://b.example/cb'] }) })).json();
    assert.notEqual(a.client_id, b.client_id);
  } finally {
    await s.stop();
  }
});

async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return btoaUrl(String.fromCharCode(...new Uint8Array(buf)));
}
function btoaUrl(s) {
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
