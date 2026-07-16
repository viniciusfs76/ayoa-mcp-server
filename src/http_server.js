// HTTP transport for the Ayoa MCP server.
//
// Endpoints:
//   GET  /                              health + tool list (no bearer)
//   GET  /.well-known/oauth-authorization-server
//                                   OAuth 2.1 metadata
//   POST /register                      dynamic client registration (RFC 7591)
//   GET  /authorize                     consent-bypass authorization
//   POST /token                         authorization_code grant, PKCE S256
//   POST /mcp                           bearer-gated MCP Streamable HTTP
//
// When AYOA_HTTP_BEARER is set, /mcp additionally requires that static
// bearer (so pre-provisioned clients can call MCP without an OAuth round
// trip). When unset, /mcp accepts only dynamic-client-issued access tokens.
import http from 'node:http';
import { URL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createMcpServer, toolCount } from '../server.js';
import { OAuthProxy } from './oauth_proxy.js';

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text, 'utf8'),
  });
  res.end(text);
}

function parseUrl(req) {
  return new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function buildApp({ oauth = new OAuthProxy(), staticBearer = '', serverFactory = createMcpServer } = {}) {
  const mcpPaths = ['/mcp', '/mcp/'];

  async function handleAuthorize(req, res, base) {
    const u = parseUrl(req);
    const params = Object.fromEntries(u.searchParams);
    try {
      const location = oauth.authorize(params);
      res.writeHead(302, { location });
      res.end();
    } catch (err) {
      sendJson(res, err.status ?? 400, { error: err.message });
    }
  }

  async function handleToken(req, res) {
    const body = await readBody(req).catch((err) => err.message);
    if (typeof body !== 'string') { sendJson(res, 400, { error: body }); return; }
    const params = Object.fromEntries(new URLSearchParams(body));
    try {
      const token = oauth.exchange(params);
      sendJson(res, 200, token);
    } catch (err) {
      sendJson(res, err.status ?? 400, { error: err.message });
    }
  }

  async function handleRegister(req, res) {
    const body = await readBody(req).catch((err) => err.message);
    if (typeof body !== 'string') { sendJson(res, 400, { error: body }); return; }
    let parsed;
    try { parsed = JSON.parse(body); } catch { sendJson(res, 400, { error: 'invalid_json' }); return; }
    try {
      const client = oauth.register(parsed || {});
      sendJson(res, 200, { ...client, token_endpoint_auth_method: 'none' });
    } catch (err) {
      sendJson(res, err.status ?? 400, { error: err.message });
    }
  }

  async function handleMcp(req, res) {
    const auth = req.headers.authorization || '';
    const m = /^Bearer (.+)$/.exec(auth);
    if (staticBearer) {
      if (!m || m[1] !== staticBearer) { sendJson(res, 401, { error: 'unauthorized' }); return; }
    } else {
      if (!m || !oauth.verify(m[1])) { sendJson(res, 401, { error: 'unauthorized' }); return; }
    }
    // Stateless request-scoped: every request gets a fresh MCP server +
    // transport. Clients send `initialize` first as part of the MCP contract;
    // we forward whatever JSON-RPC body arrives to a brand-new MCP server.
    const mcpServer = serverFactory();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await mcpServer.connect(transport);
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      // Surface initialization errors as a JSON-RPC error response so the
      // client gets a meaningful status. Common case: tools/list before
      // initialize on a brand-new transport.
      if (!res.headersSent) {
        sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: `Bad Request: ${err.message || 'transport error'}` }, id: null });
      }
    }
  }

  return async function requestHandler(req, res) {
    const u = parseUrl(req);
    const path = u.pathname;
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      sendJson(res, 200, { status: 'ok', server: 'ayoa-mcp-server', tools: toolCount(), transport: 'streamable-http', auth_required: Boolean(staticBearer) });
      return;
    }
    if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      sendJson(res, 200, oauth.metadata(`${u.protocol}//${u.host}`));
      return;
    }
    if (req.method === 'POST' && path === '/register') return handleRegister(req, res);
    if (req.method === 'GET' && path === '/authorize') return handleAuthorize(req, res);
    if (req.method === 'POST' && path === '/token') return handleToken(req, res);
    if (mcpPaths.includes(path) && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
      return handleMcp(req, res);
    }
    sendJson(res, 404, { error: 'not_found' });
  };
}

export async function startHttpServer({ port = 8775, host = '127.0.0.1', staticBearer = '', oauth } = {}) {
  const handler = await buildApp({ staticBearer, oauth });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    port,
    host,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.AYOA_HTTP_PORT || 8775);
  const host = process.env.AYOA_HTTP_HOST || '127.0.0.1';
  const staticBearer = process.env.AYOA_HTTP_BEARER || '';
  startHttpServer({ port, host, staticBearer }).then(({ port, host }) => {
    console.error(`ayoa-mcp-server HTTP listening on http://${host}:${port} (MCP at /mcp)`);
  });
}
