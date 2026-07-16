// Minimal OAuth 2.1 Authorization Server for the Ayoa MCP HTTP transport.
//
// Implements only what the CI test suite needs:
//   * GET  /.well-known/oauth-authorization-server
//   * POST /register           (dynamic client registration, RFC 7591)
//   * GET  /authorize          (consent bypass, code-only PKCE flow)
//   * POST /token              (authorization_code, PKCE S256 only)
//   * bearer token verification against issued access_token
//
// The proxy is in-process, not a real OAuth server, and the access_token
// is opaque, single-use code-bound. It enforces PKCE S256 and rejects
// non-PKCE requests, replayed codes, and missing client_id.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function sha256B64Url(verifier) {
  return b64url(createHash('sha256').update(verifier).digest());
}
function constantTimeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
function safeRedirectUri(uri) {
  try { const u = new URL(uri); return ['https:', 'http:'].includes(u.protocol) && !!u.host; }
  catch { return false; }
}

export class OAuthProxy {
  constructor() {
    this.clients = new Map();
    this.authCodes = new Map();
    this.accessTokens = new Map();
    this.tokenSecret = randomBytes(32);
  }

  metadata(base) {
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['ayoa:read', 'ayoa:write'],
    };
  }

  register({ client_name, redirect_uris }) {
    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      throw Object.assign(new Error('redirect_uris required'), { status: 400 });
    }
    for (const uri of redirect_uris) if (!safeRedirectUri(uri)) {
      throw Object.assign(new Error(`invalid redirect_uri: ${uri}`), { status: 400 });
    }
    const client = {
      client_id: randomUUID(),
      client_name: client_name || 'ayoa-suite',
      redirect_uris,
      created_at: Date.now(),
    };
    this.clients.set(client.client_id, client);
    return client;
  }

  // Step 1: issue a code. Real OIDC requires a consent screen; in this
  // self-contained proxy we skip consent (no human in the loop) and
  // immediately issue a code bound to the PKCE challenge.
  authorize({ client_id, redirect_uri, code_challenge, code_challenge_method, state }) {
    const client = this.clients.get(client_id);
    if (!client) throw Object.assign(new Error('unknown client_id'), { status: 400 });
    if (!client.redirect_uris.includes(redirect_uri)) {
      throw Object.assign(new Error('redirect_uri mismatch'), { status: 400 });
    }
    if (code_challenge_method !== 'S256' || !code_challenge) {
      throw Object.assign(new Error('PKCE S256 required'), { status: 400 });
    }
    const code = randomBytes(24).toString('hex');
    this.authCodes.set(code, {
      client_id, redirect_uri, code_challenge, expires_at: Date.now() + 60_000, used: false,
    });
    setTimeout(() => { this.authCodes.delete(code); }, 60_000).unref();
    const location = new URL(redirect_uri);
    location.searchParams.set('code', code);
    if (state) location.searchParams.set('state', state);
    return location.toString();
  }

  // Step 2: exchange code + verifier for an opaque access_token.
  exchange({ grant_type, code, client_id, code_verifier, redirect_uri }) {
    if (grant_type !== 'authorization_code') {
      throw Object.assign(new Error('unsupported_grant_type'), { status: 400 });
    }
    const record = this.authCodes.get(code);
    if (!record || record.used) {
      throw Object.assign(new Error('invalid_grant'), { status: 400 });
    }
    if (record.expires_at < Date.now()) {
      this.authCodes.delete(code);
      throw Object.assign(new Error('invalid_grant'), { status: 400 });
    }
    if (record.client_id !== client_id || record.redirect_uri !== redirect_uri) {
      throw Object.assign(new Error('invalid_grant'), { status: 400 });
    }
    const expected = sha256B64Url(code_verifier || '');
    if (!constantTimeEqual(expected, record.code_challenge)) {
      throw Object.assign(new Error('invalid_grant'), { status: 400 });
    }
    record.used = true;
    this.authCodes.delete(code);
    const accessToken = b64url(randomBytes(32));
    this.accessTokens.set(accessToken, {
      client_id, scope: 'ayoa:read ayoa:write', expires_at: Date.now() + 3600_000,
    });
    setTimeout(() => { this.accessTokens.delete(accessToken); }, 3600_000).unref();
    return { access_token: accessToken, token_type: 'Bearer', expires_in: 3600, scope: 'ayoa:read ayoa:write' };
  }

  verify(token) {
    if (!token) return false;
    const record = this.accessTokens.get(token);
    if (!record) return false;
    if (record.expires_at < Date.now()) { this.accessTokens.delete(token); return false; }
    return true;
  }
}
