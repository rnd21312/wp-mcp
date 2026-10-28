import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/auth.ts';
import { authUrl, gscStatus, handleCallback, saveClient } from '../src/gsc.ts';
import { callTool, listTools } from '../src/mcp/tools.ts';
import { createEnv, type Env } from './helpers.ts';

const who = (sites: Principal['sites'] = '*'): Principal => ({ id: 't', kind: 'api_key', name: 'test', level: 'read', sites });
const idToken = `x.${Buffer.from(JSON.stringify({ email: 'owner@example.com' })).toString('base64url')}.y`;

/** A fake Google: token endpoint plus the few Search Console endpoints the tool calls. */
function fakeGoogle(calls: { url: string; body?: any }[]): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const url = String(input);
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return ok(body.grant_type === 'refresh_token' ? { access_token: 'AT2', expires_in: 3600 } : { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, id_token: idToken });
    if (url.endsWith('/webmasters/v3/sites')) return ok({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] });
    if (url.includes('/searchAnalytics/query')) return ok(body.dimensions ? { rows: [{ keys: ['poker chips'], clicks: 6, impressions: 204, ctr: 0.0294, position: 7.66 }] } : { rows: [{ clicks: 68, impressions: 1400, ctr: 0.0486, position: 6.9 }] });
    return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
  }) as typeof fetch;
}

describe('Google Search Console', () => {
  let env: Env;
  const calls: { url: string; body?: any }[] = [];
  beforeAll(async () => { env = await createEnv([], {}, { owner: false }); });
  afterAll(() => env.stop());
  afterEach(() => vi.unstubAllGlobals());

  const connect = async (): Promise<void> => {
    saveClient(env.app, '123.apps.googleusercontent.com', 'GOCSPX-secret-value');
    const state = new URL(authUrl(env.app)).searchParams.get('state')!;
    vi.stubGlobal('fetch', fakeGoogle(calls));
    const page = await handleCallback(env.app, new URLSearchParams({ code: 'abc', state }));
    expect(page.status).toBe(200);
  };

  it('starts disconnected and checks the client id shape', () => {
    expect(gscStatus(env.app)).toMatchObject({ configured: false, connected: false });
    expect(() => saveClient(env.app, 'nope', 'GOCSPX-secret-value')).toThrow(/apps.googleusercontent.com/);
    expect(() => authUrl(env.app)).toThrow(/client ID and secret/);
  });

  it('builds a sign-in URL with read-only scope, PKCE and a signed state', () => {
    saveClient(env.app, '123.apps.googleusercontent.com', 'GOCSPX-secret-value');
    const u = new URL(authUrl(env.app));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')).toContain('webmasters.readonly');
    expect(u.searchParams.get('scope')).not.toMatch(/webmasters(?!\.readonly)(\s|$)/);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${env.config.port}/admin/gsc/callback`);
  });

  it('refuses a callback whose state was not issued here', async () => {
    const page = await handleCallback(env.app, new URLSearchParams({ code: 'abc', state: 'forged.value' }));
    expect(page.status).toBe(400);
    expect(gscStatus(env.app)).toMatchObject({ connected: false });
  });

  it('stores the tokens after sign-in and never exposes them in status', async () => {
    await connect();
    const status = JSON.stringify(gscStatus(env.app));
    expect(status).toContain('owner@example.com');
    expect(status).not.toContain('RT1');
    expect(status).not.toContain('GOCSPX');
    expect(env.app.store.setting('gsc_tokens')).not.toContain('RT1');
  });

  it('is offered only to connections that may use every site, and works through callTool', async () => {
    expect(listTools(who()).some((t) => t.name === 'search_console')).toBe(true);
    expect(listTools(who(['alpha'])).some((t) => t.name === 'search_console')).toBe(false);
    vi.stubGlobal('fetch', fakeGoogle(calls));
    const r = await callTool(env.app, who(), 'search_console', { action: 'queries', args: { days: 28, limit: 5 } });
    const data = JSON.parse(r.content[0].text);
    expect(data.ok).toBe(true);
    expect(data.site).toBe('sc-domain:example.com');
    expect(data.rows[0]).toMatchObject({ query: 'poker chips', clicks: 6, impressions: 204, ctr_pct: 2.94, position: 7.7 });
    expect(data.totals).toMatchObject({ clicks: 68, impressions: 1400 });
    const query = calls.filter((c) => c.url.includes('searchAnalytics')).at(-2)!.body;
    expect(query).toMatchObject({ type: 'web', rowLimit: 5, dimensions: ['query'] });
    expect(query.startDate < query.endDate).toBe(true);
  });

  it('rejects unknown actions and bad dimensions, and is blocked for site-limited keys', async () => {
    expect(JSON.parse((await callTool(env.app, who(), 'search_console', { action: 'delete' })).content[0].text).error.code).toBe('unknown_action');
    vi.stubGlobal('fetch', fakeGoogle(calls));
    expect(JSON.parse((await callTool(env.app, who(), 'search_console', { action: 'performance', args: { dimensions: ['bogus'] } })).content[0].text).error.code).toBe('bad_arguments');
    expect(JSON.parse((await callTool(env.app, who(['alpha']), 'search_console', { action: 'status' })).content[0].text).error.code).toBe('not_allowed');
  });
});
