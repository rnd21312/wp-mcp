import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/auth/auth.ts';
import { authUrl, gscStatus, handleCallback, saveClient } from '../src/seo/gsc.ts';
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
    if (url.startsWith('https://oauth2.googleapis.com/token'))
      return ok(
        body.grant_type === 'refresh_token'
          ? { access_token: 'AT2', expires_in: 3600 }
          : {
              access_token: 'AT1',
              refresh_token: 'RT1',
              expires_in: 3600,
              id_token: idToken,
              scope:
                body.code === 'i'
                  ? 'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/indexing openid email'
                  : body.code === 'w'
                    ? 'https://www.googleapis.com/auth/webmasters openid email'
                    : 'https://www.googleapis.com/auth/webmasters.readonly openid email',
            },
      );
    if (url.startsWith('https://indexing.googleapis.com/v3/urlNotifications:publish'))
      return ok({ urlNotificationMetadata: { url: body.url, latestUpdate: { type: body.type } } });
    if (url.includes('/sitemaps/') && ['PUT', 'DELETE'].includes(init.method)) return ok({});
    if (url.endsWith('/webmasters/v3/sites'))
      return ok({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] });
    if (url.includes('/searchAnalytics/query'))
      return ok(
        body.dimensions
          ? { rows: [{ keys: ['poker chips'], clicks: 6, impressions: 204, ctr: 0.0294, position: 7.66 }] }
          : { rows: [{ clicks: 68, impressions: 1400, ctr: 0.0486, position: 6.9 }] },
      );
    return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
  }) as typeof fetch;
}

describe('Google Search Console', () => {
  let env: Env;
  const calls: { url: string; body?: any }[] = [];
  beforeAll(async () => {
    env = await createEnv([], {}, { owner: false });
  });
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
    expect(data.cols).toEqual(['query', 'clicks', 'impressions', 'ctr_pct', 'position']);
    expect(data.data[0]).toEqual(['poker chips', 6, 204, 2.94, 7.7]);
    expect(data.rows).toBeUndefined();
    expect(data.totals).toMatchObject({ clicks: 68, impressions: 1400 });
    const query = calls.filter((c) => c.url.includes('searchAnalytics')).at(-2)!.body;
    expect(query).toMatchObject({ type: 'web', rowLimit: 5, dimensions: ['query'] });
    expect(query.startDate < query.endDate).toBe(true);
  });

  it('overview and opportunities answer in one call with compact tables', async () => {
    vi.stubGlobal('fetch', fakeGoogle(calls));
    const o = JSON.parse((await callTool(env.app, who(), 'search_console', { action: 'overview' })).content[0].text);
    expect(o.ok).toBe(true);
    expect(o.totals).toMatchObject({ clicks: 68 });
    expect(o.queries.data[0][0]).toBe('poker chips');
    const w = JSON.parse(
      (await callTool(env.app, who(), 'search_console', { action: 'opportunities', args: { min_impressions: 10 } })).content[0].text,
    );
    expect(w.ok).toBe(true);
    expect(w.cols).toContain('potential_clicks');
    expect(w.data[0][w.cols.indexOf('position')]).toBe(7.7);
  });

  it('rejects unknown actions and bad dimensions, and is blocked for site-limited keys', async () => {
    expect(JSON.parse((await callTool(env.app, who(), 'search_console', { action: 'delete' })).content[0].text).error.code).toBe(
      'unknown_action',
    );
    vi.stubGlobal('fetch', fakeGoogle(calls));
    expect(
      JSON.parse(
        (await callTool(env.app, who(), 'search_console', { action: 'performance', args: { dimensions: ['bogus'] } })).content[0].text,
      ).error.code,
    ).toBe('bad_arguments');
    expect(JSON.parse((await callTool(env.app, who(['alpha']), 'search_console', { action: 'status' })).content[0].text).error.code).toBe(
      'not_allowed',
    );
  });

  it('sitemap_submit: needs level live, a confirmation, and a connection that allows changes', async () => {
    const asLevel = (level: Principal['level']): Principal => ({ ...who(), id: 'w-' + level, level });
    const call = async (p: Principal, action: string, args: Record<string, unknown>, confirm_token?: string) =>
      JSON.parse((await callTool(env.app, p, 'search_console', { action, args, confirm_token })).content[0].text);
    const args = { url: 'https://example.com/sitemap.xml' };
    expect(listTools(asLevel('draft')).find((t) => t.name === 'search_console')!.description).not.toContain('sitemap_submit(');
    expect(listTools(asLevel('live')).find((t) => t.name === 'search_console')!.description).toContain('sitemap_submit(');
    expect((await call(asLevel('draft'), 'sitemap_submit', args)).error.code).toBe('level_too_low');

    vi.stubGlobal('fetch', fakeGoogle(calls));
    const first = await call(asLevel('live'), 'sitemap_submit', args);
    expect(first.needs_confirmation).toBe(true);
    expect(
      (await call(asLevel('live'), 'sitemap_submit', { url: 'https://other.example/sitemap.xml' }, first.confirm_token)).error.code,
    ).toBe('bad_confirm_token');
    // the connection made earlier asked for read access only
    expect(gscStatus(env.app)).toMatchObject({ write_access: false });
    expect((await call(asLevel('live'), 'sitemap_submit', args, first.confirm_token)).error.code).toBe('read_only_connection');

    // reconnect with change access
    const url = new URL(authUrl(env.app, true));
    expect(url.searchParams.get('scope')).toMatch(/auth\/webmasters(\s|$)/);
    await handleCallback(env.app, new URLSearchParams({ code: 'w', state: url.searchParams.get('state')! }));
    expect(gscStatus(env.app)).toMatchObject({ write_access: true });
    const done = await call(asLevel('live'), 'sitemap_submit', args, first.confirm_token);
    expect(done.ok).toBe(true);
    const put = calls.filter((c) => c.url.includes('/sitemaps/')).at(-1)!;
    expect(put.url).toBe(
      'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml',
    );
    const second = await call(asLevel('live'), 'sitemap_delete', args);
    expect((await call(asLevel('live'), 'sitemap_delete', args, second.confirm_token)).deleted).toBe(true);
  });

  it('a sitemap must belong to the property', async () => {
    const { sitemapUrlProblem } = await import('../src/seo/gsc.ts');
    expect(sitemapUrlProblem('sc-domain:example.com', 'https://example.com/s.xml')).toBeNull();
    expect(sitemapUrlProblem('sc-domain:example.com', 'https://blog.example.com/s.xml')).toBeNull();
    expect(sitemapUrlProblem('sc-domain:example.com', 'https://evilexample.com/s.xml')).toMatch(/must be on/);
    expect(sitemapUrlProblem('https://example.com/', 'https://example.com/a/s.xml')).toBeNull();
    expect(sitemapUrlProblem('https://example.com/', 'https://example.org/s.xml')).toMatch(/must start with/);
    expect(sitemapUrlProblem('sc-domain:example.com', 'ftp://example.com/s.xml')).toMatch(/https/);
    expect(sitemapUrlProblem('sc-domain:example.com', 'nope')).toMatch(/full sitemap/);
  });

  it('indexing_publish: opt-in connection, acknowledged restriction, URL inside the property, confirmed, counted', async () => {
    const live: Principal = { ...who(), id: 'i-live', level: 'live' };
    const call = async (action: string, args: Record<string, unknown>, confirm_token?: string) =>
      JSON.parse((await callTool(env.app, live, 'search_console', { action, args, confirm_token })).content[0].text);
    vi.stubGlobal('fetch', fakeGoogle(calls));
    const args = { url: 'https://example.com/jobs/1/', acknowledge_restriction: true };

    // a connection without Indexing API access is refused, after the confirmation step
    await handleCallback(env.app, new URLSearchParams({ code: 'r', state: new URL(authUrl(env.app)).searchParams.get('state')! }));
    expect(gscStatus(env.app)).toMatchObject({ write_access: false, indexing_access: false });
    const t0 = await call('indexing_publish', args);
    expect(t0.needs_confirmation).toBe(true);
    expect(t0.preview.warning).toMatch(/JobPosting or BroadcastEvent/);
    expect((await call('indexing_publish', args, t0.confirm_token)).error.code).toBe('no_indexing_access');

    const u = new URL(authUrl(env.app, false, true));
    expect(u.searchParams.get('scope')).toContain('auth/indexing');
    expect(u.searchParams.get('scope')).not.toContain('include_granted');
    expect(u.searchParams.has('include_granted_scopes')).toBe(false);
    await handleCallback(env.app, new URLSearchParams({ code: 'i', state: u.searchParams.get('state')! }));
    expect(gscStatus(env.app)).toMatchObject({ indexing_access: true, write_access: false });

    const noAck = { url: args.url };
    const t1 = await call('indexing_publish', noAck);
    expect((await call('indexing_publish', noAck, t1.confirm_token)).error.code).toBe('acknowledge_restriction');
    const t2 = await call('indexing_publish', { ...args, url: 'https://elsewhere.test/x' });
    expect((await call('indexing_publish', { ...args, url: 'https://elsewhere.test/x' }, t2.confirm_token)).error.code).toBe(
      'bad_arguments',
    );

    const t3 = await call('indexing_publish', args);
    const done = await call('indexing_publish', args, t3.confirm_token);
    expect(done).toMatchObject({ ok: true, type: 'URL_UPDATED', left_today: 199 });
    const post = calls.filter((c) => c.url.includes('urlNotifications:publish')).at(-1)!;
    expect(post.body).toEqual({ url: args.url, type: 'URL_UPDATED' });
  });

  it('the daily Indexing API counter resets by Pacific day', async () => {
    const { indexingQuota } = await import('../src/seo/gsc.ts');
    const noon = new Date('2026-03-10T20:00:00Z');
    expect(indexingQuota(null, noon)).toEqual({ day: '2026-03-10', used: 0, left: 200 });
    expect(indexingQuota({ day: '2026-03-10', n: 199 }, noon).left).toBe(1);
    expect(indexingQuota({ day: '2026-03-10', n: 250 }, noon).left).toBe(0);
    expect(indexingQuota({ day: '2026-03-09', n: 200 }, noon).used).toBe(0);
  });
});
