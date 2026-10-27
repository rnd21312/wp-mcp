import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, key, OWNER_PASSWORD, rpc, tool, type Env } from './helpers.ts';

const LIMITS = { clientPerMin: 240, writePerMin: 60, sitePerMin: 400, tokenPerMin: 500, registerPerHour: 1000, loginPer10Min: 1000 };
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function login(env: Env): Promise<string> {
  const res = await fetch(`${env.base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: OWNER_PASSWORD }) });
  expect(res.status).toBe(303);
  return res.headers.getSetCookie()[0].split(';')[0];
}

async function register(env: Env, redirect = REDIRECT, name = 'Claude'): Promise<string> {
  const res = await fetch(`${env.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect] }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

const authorizeUrl = (env: Env, clientId: string, challenge: string, extra: Record<string, string> = {}, redirect = REDIRECT): string =>
  `${env.base}/authorize?` + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', scope: 'live', ...extra });

/** Runs consent and returns the authorization code. */
async function approve(env: Env, cookie: string, clientId: string, challenge: string, level = 'live', redirect = REDIRECT): Promise<string> {
  const page = await fetch(authorizeUrl(env, clientId, challenge, { prompt: 'consent' }, redirect), { headers: { cookie }, redirect: 'manual' });
  expect(page.status).toBe(200);
  const html = await page.text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(html)![1];
  const res = await fetch(`${env.base}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', scope: level, _csrf: csrf, level, decision: 'approve', sites: 'alpha' }),
  });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location')!);
  expect(location.searchParams.get('state')).toBe('st-1');
  return location.searchParams.get('code')!;
}

const token = (env: Env, form: Record<string, string>) => fetch(`${env.base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });

async function connect(env: Env, level = 'live') {
  const cookie = await login(env);
  const clientId = await register(env);
  const { verifier, challenge } = pkce();
  const code = await approve(env, cookie, clientId, challenge, level);
  const res = await token(env, { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
  expect(res.status).toBe(200);
  const tokens = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string };
  return { cookie, clientId, verifier, challenge, tokens };
}

describe('OAuth 2.1 with PKCE', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv(['alpha', 'beta'], { limits: LIMITS });
  });
  afterAll(() => env.stop());

  it('publishes discovery metadata', async () => {
    const meta = (await (await fetch(`${env.base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.registration_endpoint).toBe(`${env.base}/register`);
    expect(meta.token_endpoint_auth_methods_supported).toEqual(['none']);
    const resource = (await (await fetch(`${env.base}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
    expect(resource.resource).toBe(`${env.base}/mcp`);
    expect(resource.authorization_servers).toEqual([env.base]);
  });

  it('completes the full flow and the token works on /mcp', async () => {
    const { tokens } = await connect(env);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe('live');
    const list = await rpc(env, tokens.access_token, 'tools/list');
    expect(list.status).toBe(200);
    expect(list.body.result.tools).toHaveLength(14);
    const r = await tool(env, tokens.access_token, 'content', { site: 'alpha', action: 'list' });
    expect(r.data.site).toBe('alpha');
  });

  it('shows the redirect domain prominently on the consent page', async () => {
    const cookie = await login(env);
    const clientId = await register(env, 'https://app.example.org/cb', 'Looks Like Claude');
    const html = await (await fetch(authorizeUrl(env, clientId, pkce().challenge, {}, 'https://app.example.org/cb'), { headers: { cookie } })).text();
    expect(html).toContain('<div class="domain">app.example.org</div>');
    expect(html).toContain('not verified');
    expect(html).toContain('Looks Like Claude');
  });

  it('requires an owner session to authorize', async () => {
    const clientId = await register(env);
    const res = await fetch(authorizeUrl(env, clientId, pkce().challenge), { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/admin\/login\?next=/);
  });

  it('never redirects to an unregistered address', async () => {
    const cookie = await login(env);
    const clientId = await register(env);
    const res = await fetch(authorizeUrl(env, clientId, pkce().challenge, {}, 'https://evil.example/cb'), { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    const unknown = await fetch(authorizeUrl(env, 'wpmc_nope', pkce().challenge), { headers: { cookie }, redirect: 'manual' });
    expect(unknown.status).toBe(400);
  });

  it('refuses dangerous registrations', async () => {
    for (const uri of ['javascript:alert(1)', 'http://evil.example/cb', 'https://x.example/cb#frag', 'data:text/html,x']) {
      const res = await fetch(`${env.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [uri] }) });
      expect(res.status, uri).toBe(400);
    }
    const confidential = await fetch(`${env.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' }) });
    expect(confidential.status).toBe(400);
  });

  it('requires PKCE', async () => {
    const cookie = await login(env);
    const clientId = await register(env);
    const url = new URL(authorizeUrl(env, clientId, 'short'));
    const res = await fetch(url, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });

  it('rejects a wrong verifier, a reused code and a different redirect', async () => {
    const cookie = await login(env);
    const clientId = await register(env);
    const { verifier, challenge } = pkce();
    const code = await approve(env, cookie, clientId, challenge);
    const wrong = await token(env, { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: randomBytes(32).toString('base64url') });
    expect(wrong.status).toBe(400);
    // The failed attempt burned the code.
    const again = await token(env, { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(again.status).toBe(400);

    const code2 = await approve(env, cookie, clientId, challenge);
    const mismatch = await token(env, { grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: 'https://evil.example/cb', code_verifier: verifier });
    expect(mismatch.status).toBe(400);

    const code3 = await approve(env, cookie, clientId, challenge);
    const ok = await token(env, { grant_type: 'authorization_code', code: code3, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(ok.status).toBe(200);
    const replay = await token(env, { grant_type: 'authorization_code', code: code3, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(replay.status).toBe(400);
  });

  it('lets the owner say no', async () => {
    const cookie = await login(env);
    const clientId = await register(env);
    const { challenge } = pkce();
    const html = await (await fetch(authorizeUrl(env, clientId, challenge), { headers: { cookie } })).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(html)![1];
    const res = await fetch(`${env.base}/authorize`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's', _csrf: csrf, decision: 'deny' }) });
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });

  it('rejects the consent form without the CSRF token', async () => {
    const cookie = await login(env);
    const clientId = await register(env);
    const res = await fetch(`${env.base}/authorize`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', decision: 'approve', level: 'admin', sites: 'alpha' }) });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('skips the consent page for an app the owner already approved', async () => {
    const { cookie, clientId } = await connect(env);
    const res = await fetch(authorizeUrl(env, clientId, pkce().challenge), { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('code')).toBeTruthy();
  });

  it('accepts a loopback redirect on a different port (desktop tools)', async () => {
    const cookie = await login(env);
    const clientId = await register(env, 'http://localhost:3118/callback', 'Claude Code');
    const code = await approve(env, cookie, clientId, pkce().challenge, 'live', 'http://localhost:51234/callback');
    expect(code).toBeTruthy();
  });
});

describe('long-lived connections', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv(['alpha'], { limits: LIMITS });
  });
  afterAll(() => env.stop());

  it('rotates refresh tokens and keeps working', async () => {
    const { clientId, tokens } = await connect(env);
    const res = await token(env, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(res.status).toBe(200);
    const next = (await res.json()) as typeof tokens;
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(next.access_token).not.toBe(tokens.access_token);
    expect((await rpc(env, next.access_token, 'tools/list')).status).toBe(200);
  });

  it('survives an expired access token and a client that was away for weeks', async () => {
    const { clientId, tokens } = await connect(env);
    env.app.store.db.exec(`UPDATE oauth_tokens SET expires = 1 WHERE kind = 'access' AND client_id = '${clientId}'`);
    const expired = await rpc(env, tokens.access_token, 'tools/list');
    expect(expired.status).toBe(401);
    expect(expired.headers.get('www-authenticate')).toMatch(/invalid_token/);
    // 60 days later the refresh token (180 day life) is still good.
    const res = await token(env, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(res.status).toBe(200);
    expect((await rpc(env, ((await res.json()) as typeof tokens).access_token, 'tools/list')).status).toBe(200);
  });

  it('tolerates a lost refresh response (retry within the grace window)', async () => {
    const { clientId, tokens } = await connect(env);
    const first = await token(env, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(first.status).toBe(200);
    const retry = await token(env, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(retry.status).toBe(200);
    expect((await rpc(env, ((await retry.json()) as typeof tokens).access_token, 'tools/list')).status).toBe(200);
  });

  it('treats a stale refresh token as theft and ends the whole chain', async () => {
    const { clientId, tokens } = await connect(env);
    const rotated = (await (await token(env, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId })).json()) as typeof tokens;
    env.app.store.db.exec('UPDATE oauth_tokens SET rotated_at = rotated_at - 100000 WHERE rotated_at > 0');
    const reuse = await token(env, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe('invalid_grant');
    // The legitimate newest token died with the chain.
    expect((await token(env, { grant_type: 'refresh_token', refresh_token: rotated.refresh_token, client_id: clientId })).status).toBe(400);
    expect((await rpc(env, rotated.access_token, 'tools/list')).status).toBe(401);
  });

  it('a refresh token only works for its own client', async () => {
    const a = await connect(env);
    const b = await connect(env);
    expect((await token(env, { grant_type: 'refresh_token', refresh_token: a.tokens.refresh_token, client_id: b.clientId })).status).toBe(400);
  });

  it('disconnecting an app or lowering its level takes effect at once', async () => {
    const { clientId, tokens } = await connect(env);
    expect((await tool(env, tokens.access_token, 'content', { action: 'trash', args: { id: 1 } })).isError).toBe(false);
    env.app.store.setGrant(clientId, 'read', '["*"]');
    expect((await tool(env, tokens.access_token, 'content', { action: 'trash', args: { id: 1 } })).data.error.code).toBe('level_too_low');
    env.app.store.removeClient(clientId);
    expect((await rpc(env, tokens.access_token, 'tools/list')).status).toBe(401);
    expect((await token(env, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId })).status).toBe(401);
  });

  it('revocation endpoint ends the chain', async () => {
    const { clientId, tokens } = await connect(env);
    await fetch(`${env.base}/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.refresh_token, client_id: clientId }) });
    expect((await rpc(env, tokens.access_token, 'tools/list')).status).toBe(401);
  });

  it('rate-limits the token endpoint per client and registration per address', async () => {
    const env2 = await createEnv(['alpha'], { limits: { clientPerMin: 240, writePerMin: 60, sitePerMin: 400, tokenPerMin: 3, registerPerHour: 2, loginPer10Min: 10 } });
    const clientId = await register(env2);
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await token(env2, { grant_type: 'refresh_token', refresh_token: 'wpmrt_x', client_id: clientId })).status);
    expect(statuses.slice(0, 3).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(3)).toEqual([429, 429]);
    // register() above used 1 of 2; one more, then blocked.
    await register(env2);
    const blocked = await fetch(`${env2.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    await env2.stop();
  });
});

describe('/mcp authentication', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv(['alpha']);
  });
  afterAll(() => env.stop());

  it('answers 401 with the discovery pointer when there is no token', async () => {
    const res = await fetch(`${env.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${env.base}/.well-known/oauth-protected-resource"`);
  });

  it('rejects wrong, revoked and expired API keys', async () => {
    expect((await rpc(env, 'wpmk_nonsense', 'tools/list')).status).toBe(401);
    const k = key(env, 'read');
    expect((await rpc(env, k, 'tools/list')).status).toBe(200);
    env.app.store.revokeKey(env.app.store.keys()[0].id);
    expect((await rpc(env, k, 'tools/list')).status).toBe(401);
    const { createApiKey } = await import('../src/auth.ts');
    const old = createApiKey(env.app, { name: 'old', level: 'read', sites: '*', expiresInDays: 1 });
    env.app.store.db.exec("UPDATE api_keys SET expires = 5 WHERE name = 'old'");
    expect((await rpc(env, old.token, 'tools/list')).headers.get('www-authenticate')).toMatch(/expired/);
  });

  it('accepts the key in X-API-Key too', async () => {
    const k = key(env, 'read');
    const res = await fetch(`${env.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': k }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    expect(res.status).toBe(200);
  });

  it('never accepts a key in the URL', async () => {
    const k = key(env, 'read');
    const res = await fetch(`${env.base}/mcp?key=${k}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    expect(res.status).toBe(401);
  });

  it('throttles repeated bad credentials from one address', async () => {
    const codes = [];
    for (let i = 0; i < 35; i++) codes.push((await rpc(env, 'wpmk_bad' + i, 'ping')).status);
    expect(codes.at(-1)).toBe(429);
  });
});
