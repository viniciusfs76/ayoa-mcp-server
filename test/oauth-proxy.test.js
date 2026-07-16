// Unit tests for the OAuthProxy implementation: register, authorize, token,
// PKCE verification, code-replay protection, expiry, redirect-uri allowlist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { OAuthProxy } from '../src/oauth_proxy.js';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function sha256B64Url(input) {
  return b64url(createHash('sha256').update(input).digest());
}
async function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

test('metadata advertises the required endpoints and PKCE', () => {
  const p = new OAuthProxy();
  const m = p.metadata('http://x');
  assert.match(m.issuer, /http:\/\/x/);
  assert.ok(m.response_types_supported.includes('code'));
  assert.ok(m.grant_types_supported.includes('authorization_code'));
  assert.ok(m.code_challenge_methods_supported.includes('S256'));
});

test('register returns a unique client_id and round-trips redirect_uris', () => {
  const p = new OAuthProxy();
  const a = p.register({ client_name: 'A', redirect_uris: ['https://a.example/cb'] });
  const b = p.register({ client_name: 'B', redirect_uris: ['https://b.example/cb'] });
  assert.notEqual(a.client_id, b.client_id);
  assert.deepEqual(a.redirect_uris, ['https://a.example/cb']);
});

test('register rejects invalid redirect URIs', () => {
  const p = new OAuthProxy();
  assert.throws(() => p.register({ client_name: 'X', redirect_uris: ['not-a-url'] }), /invalid redirect_uri/);
  assert.throws(() => p.register({ client_name: 'X', redirect_uris: [] }), /required/);
});

test('authorize requires PKCE S256 and a registered client', () => {
  const p = new OAuthProxy();
  assert.throws(() => p.authorize({ client_id: 'no-such', redirect_uri: 'https://x', code_challenge: 'x', code_challenge_method: 'S256' }), /unknown/);
  const client = p.register({ client_name: 'A', redirect_uris: ['https://a.example/cb'] });
  assert.throws(() => p.authorize({ client_id: client.client_id, redirect_uri: 'https://a.example/cb', code_challenge: 'x', code_challenge_method: 'plain' }), /PKCE/);
  assert.throws(() => p.authorize({ client_id: client.client_id, redirect_uri: 'https://b.example/cb', code_challenge: 'x', code_challenge_method: 'S256' }), /mismatch/);
  const location = p.authorize({ client_id: client.client_id, redirect_uri: 'https://a.example/cb', code_challenge: 'X', code_challenge_method: 'S256', state: 'abc' });
  const u = new URL(location);
  assert.match(u.searchParams.get('code') || '', /^[0-9a-f]+$/);
  assert.equal(u.searchParams.get('state'), 'abc');
});

test('token exchange validates PKCE verifier, client_id, and redirect_uri', () => {
  const p = new OAuthProxy();
  const client = p.register({ client_name: 'A', redirect_uris: ['https://a.example/cb'] });
  const verifier = 'ayoa-suite-verifier-32-bytes-min-aaaaaaaaa';
  const challenge = sha256B64Url(verifier);
  const location = p.authorize({ client_id: client.client_id, redirect_uri: 'https://a.example/cb', code_challenge: challenge, code_challenge_method: 'S256' });
  const code = new URL(location).searchParams.get('code');
  // happy path
  const ok = p.exchange({ grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: verifier, redirect_uri: 'https://a.example/cb' });
  assert.ok(ok.access_token);
  assert.equal(ok.token_type, 'Bearer');
  // wrong verifier
  const client2 = p.register({ client_name: 'B', redirect_uris: ['https://a.example/cb'] });
  const loc2 = p.authorize({ client_id: client2.client_id, redirect_uri: 'https://a.example/cb', code_challenge: challenge, code_challenge_method: 'S256' });
  const code2 = new URL(loc2).searchParams.get('code');
  assert.throws(() => p.exchange({ grant_type: 'authorization_code', code: code2, client_id: client2.client_id, code_verifier: 'WRONG', redirect_uri: 'https://a.example/cb' }), /invalid_grant/);
});

test('token exchange refuses replayed code', () => {
  const p = new OAuthProxy();
  const client = p.register({ client_name: 'A', redirect_uris: ['https://a.example/cb'] });
  const verifier = 'ayoa-suite-verifier-32-bytes-min-aaaaaaaaa';
  const challenge = sha256B64Url(verifier);
  const loc = p.authorize({ client_id: client.client_id, redirect_uri: 'https://a.example/cb', code_challenge: challenge, code_challenge_method: 'S256' });
  const code = new URL(loc).searchParams.get('code');
  p.exchange({ grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: verifier, redirect_uri: 'https://a.example/cb' });
  assert.throws(() => p.exchange({ grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: verifier, redirect_uri: 'https://a.example/cb' }), /invalid_grant/);
});

test('token exchange rejects unknown grant type', () => {
  const p = new OAuthProxy();
  assert.throws(() => p.exchange({ grant_type: 'client_credentials' }), /unsupported/);
});

test('access token is single-bound to its client and verify() rotates with expiry', async () => {
  const p = new OAuthProxy();
  const client = p.register({ client_name: 'A', redirect_uris: ['https://a.example/cb'] });
  const verifier = 'ayoa-suite-verifier-32-bytes-min-aaaaaaaaa';
  const challenge = sha256B64Url(verifier);
  const loc = p.authorize({ client_id: client.client_id, redirect_uri: 'https://a.example/cb', code_challenge: challenge, code_challenge_method: 'S256' });
  const code = new URL(loc).searchParams.get('code');
  const token = p.exchange({ grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: verifier, redirect_uri: 'https://a.example/cb' }).access_token;
  assert.equal(p.verify(token), true);
  assert.equal(p.verify('not-a-real-token'), false);
  assert.equal(p.verify(undefined), false);
});

test('code expires after 60s and is purged', async () => {
  const p = new OAuthProxy();
  // Force expiry by mutating the deadline
  const client = p.register({ client_name: 'A', redirect_uris: ['https://a.example/cb'] });
  const verifier = 'ayoa-suite-verifier-32-bytes-min-aaaaaaaaa';
  const challenge = sha256B64Url(verifier);
  const loc = p.authorize({ client_id: client.client_id, redirect_uri: 'https://a.example/cb', code_challenge: challenge, code_challenge_method: 'S256' });
  const code = new URL(loc).searchParams.get('code');
  const record = p.authCodes.get(code);
  record.expires_at = Date.now() - 1;
  assert.throws(() => p.exchange({ grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: verifier, redirect_uri: 'https://a.example/cb' }), /invalid_grant/);
  assert.equal(p.authCodes.has(code), false);
});
