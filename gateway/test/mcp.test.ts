import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addSite } from '../src/siteadmin.ts';
import { prepareSetup } from '../src/admin.ts';
import { createEnv, FakeSite, key, OWNER_PASSWORD, rpc, tool, type Env } from './helpers.ts';

describe('MCP protocol (stateless Streamable HTTP)', () => {
  let env: Env;
  let admin: string;
  let read: string;
  beforeAll(async () => {
    env = await createEnv(['alpha']);
    admin = key(env, 'admin');
    read = key(env, 'read');
  });
  afterAll(() => env.stop());

  it('initialize carries instructions that teach the workflow', async () => {
    const { body } = await rpc(env, read, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.capabilities).toMatchObject({ tools: {}, resources: {}, prompts: {} });
    const text = body.result.instructions as string;
    for (const needle of ['site {action:"sites"}', 'confirm_token', 'untrusted', 'idempotency_key', 'activity.undo', 'read < draft < live < admin']) expect(text).toContain(needle);
  });

  it('negotiates down to a version it knows', async () => {
    expect((await rpc(env, read, 'initialize', { protocolVersion: '2024-11-05' })).body.result.protocolVersion).toBe('2024-11-05');
    expect((await rpc(env, read, 'initialize', { protocolVersion: '2099-01-01' })).body.result.protocolVersion).toBe('2025-06-18');
  });

  it('lists 18 tools whose actions follow the connection level', async () => {
    const full = (await rpc(env, admin, 'tools/list')).body.result.tools as { name: string; description: string; inputSchema: any; annotations: any }[];
    expect(full.map((t) => t.name)).toEqual(['site', 'content', 'design', 'media', 'seo', 'inspect', 'maintain', 'plugins', 'users', 'options', 'rest', 'shop', 'forms', 'files', 'transfer', 'activity', 'studio', 'search_console']);
    const narrow = (await rpc(env, read, 'tools/list')).body.result.tools as typeof full;
    const content = narrow.find((t) => t.name === 'content')!;
    expect(content.inputSchema.properties.action.enum).toContain('list');
    expect(content.inputSchema.properties.action.enum).not.toContain('save');
    expect(content.inputSchema.properties.action.enum).not.toContain('delete');
    expect(content.description).toMatch(/Needs a higher level than yours \(read\)/);
    expect(content.annotations.readOnlyHint).toBe(true);
    expect(full.find((t) => t.name === 'content')!.annotations.destructiveHint).toBe(true);
    expect(full.find((t) => t.name === 'content')!.inputSchema.properties.action.enum).toContain('delete');
    for (const t of full) {
      expect(t.inputSchema.required).toEqual(['action']);
      expect(t.description.length).toBeGreaterThan(100);
    }
  });

  it('tool descriptions show the argument signature of every action', async () => {
    const tools = (await rpc(env, admin, 'tools/list')).body.result.tools as { name: string; description: string }[];
    const content = tools.find((t) => t.name === 'content')!;
    expect(content.description).toContain('save(id,post_type,title,content');
    expect(content.description).toContain('trash(id*)');
    expect(content.description).toContain('[draft>live]');
  });

  it('site.describe returns the exact schema and levels', async () => {
    const r = await tool(env, read, 'site', { action: 'describe', args: { tool: 'content', action: 'save' } });
    expect(r.data.level).toBe('draft');
    expect(r.data.escalates_to).toBe('live');
    expect(r.data.arguments.properties.title.type).toBe('string');
    const all = await tool(env, read, 'site', { action: 'describe', args: { tool: 'plugins' } });
    expect(all.data.actions.find((a: any) => a.action === 'delete')).toMatchObject({ level: 'admin', confirm: true, usable: false });
    const whoami = await tool(env, read, 'site', { action: 'whoami' });
    expect(whoami.data.level).toBe('read');
    expect(whoami.data.level_meaning).toMatch(/non-sensitive/);
  });

  it('serves guide resources, a sites resource and templates', async () => {
    const list = (await rpc(env, read, 'resources/list')).body.result.resources as { uri: string }[];
    const uris = list.map((r) => r.uri);
    for (const u of ['wpmcp://guide/overview', 'wpmcp://guide/levels', 'wpmcp://guide/multisite', 'wpmcp://guide/safety', 'wpmcp://sites', 'wpmcp://ops', 'wpmcp://activity']) expect(uris).toContain(u);
    const levels = (await rpc(env, read, 'resources/read', { uri: 'wpmcp://guide/levels' })).body.result.contents[0].text as string;
    expect(levels).toContain('**admin**');
    const sites = JSON.parse((await rpc(env, read, 'resources/read', { uri: 'wpmcp://sites' })).body.result.contents[0].text);
    expect(sites.sites[0].name).toBe('alpha');
    expect((await rpc(env, read, 'resources/read', { uri: 'wpmcp://nope' })).body.error.code).toBe(-32002);
    expect((await rpc(env, read, 'resources/templates/list')).body.result.resourceTemplates[0].uriTemplate).toContain('{site}');
    const ops = (await rpc(env, read, 'resources/read', { uri: 'wpmcp://ops' })).body.result.contents[0].text as string;
    expect(ops).toContain('content');
  });

  it('activity resource only shows sites the connection may use', async () => {
    const scoped = key(env, 'read', []);
    expect((await rpc(env, scoped, 'resources/read', { uri: 'wpmcp://site/alpha/activity' })).body.error.code).toBe(-32002);
  });

  it('offers ready-made prompts', async () => {
    const prompts = (await rpc(env, read, 'prompts/list')).body.result.prompts as { name: string }[];
    expect(prompts.map((p) => p.name)).toEqual(expect.arrayContaining(['build_site', 'seo_audit', 'maintenance_check', 'publish_post', 'redesign_page']));
    const got = (await rpc(env, read, 'prompts/get', { name: 'seo_audit', arguments: { site: 'alpha', apply: 'no' } })).body.result;
    expect(got.messages[0].content.text).toContain('alpha');
    expect(got.messages[0].content.text).toContain('Do not change anything');
    expect((await rpc(env, read, 'prompts/get', { name: 'zzz' })).body.error.code).toBe(-32602);
  });

  it('handles notifications, batches, ping and unknown methods', async () => {
    const note = await fetch(`${env.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${read}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(note.status).toBe(202);
    const batch = await fetch(`${env.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${read}` }, body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/cancelled' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]) });
    const out = (await batch.json()) as { id: number }[];
    expect(out.map((r) => r.id)).toEqual([1, 2]);
    expect((await rpc(env, read, 'nope/method')).body.error.code).toBe(-32601);
  });

  it('is stateless: no session id is needed or issued', async () => {
    const first = await rpc(env, read, 'tools/list');
    expect(first.headers.get('mcp-session-id')).toBeNull();
    const again = await rpc(env, read, 'tools/list');
    expect(again.status).toBe(200);
  });

  it('rejects GET/DELETE on /mcp and malformed JSON', async () => {
    expect((await fetch(`${env.base}/mcp`, { headers: { authorization: `Bearer ${read}` } })).status).toBe(405);
    expect((await fetch(`${env.base}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${read}` } })).status).toBe(405);
    const bad = await fetch(`${env.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${read}` }, body: '{nope' });
    expect(bad.status).toBe(400);
  });

  it('answers CORS preflight for browser clients', async () => {
    const res = await fetch(`${env.base}/mcp`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('truncates huge results instead of flooding the model', async () => {
    env.sites.alpha.answers['content.list'] = () => ({ blob: 'x'.repeat(300000) });
    const r = await tool(env, read, 'content', { action: 'list' });
    expect(r.data.truncated).toBe(true);
    expect(r.data.hint).toMatch(/Narrow it/);
    delete env.sites.alpha.answers['content.list'];
  });
});

describe('owner admin panel', () => {
  let env: Env;
  let cookie = '';
  let csrf = '';
  beforeAll(async () => {
    env = await createEnv(['alpha'], {}, { owner: false });
  });
  afterAll(() => env.stop());

  const form = (path: string, data: Record<string, string | string[]>, headers: Record<string, string> = {}) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(data)) for (const item of Array.isArray(v) ? v : [v]) body.append(k, item);
    return fetch(`${env.base}${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
  };

  it('first run: only the setup token holder can claim the gateway', async () => {
    expect((await fetch(`${env.base}/admin`, { redirect: 'manual' })).headers.get('location')).toBe('/admin/setup');
    const setupToken = prepareSetup(env.app)!;
    expect(setupToken.length).toBeGreaterThan(8);
    expect(await (await form('/admin/setup', { token: 'guess', password: 'a very long password' })).text()).toContain('Wrong setup token');
    expect(await (await form('/admin/setup', { token: setupToken, password: 'short' })).text()).toContain('at least 12');
    const ok = await form('/admin/setup', { token: setupToken, password: OWNER_PASSWORD });
    expect(ok.status).toBe(303);
    cookie = ok.headers.getSetCookie()[0].split(';')[0];
    // The token is single-use.
    expect(env.app.store.ownerHash()).toBeTruthy();
    expect((await fetch(`${env.base}/admin/setup`, { redirect: 'manual' })).headers.get('location')).toBe('/admin');
  });

  it('session cookie is HttpOnly and SameSite', async () => {
    const res = await form('/admin/login', { password: OWNER_PASSWORD });
    const set = res.headers.getSetCookie()[0];
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
  });

  it('dashboard needs login and sends hardening headers', async () => {
    const anon = await fetch(`${env.base}/admin`, { redirect: 'manual' });
    expect(anon.status).toBe(303);
    const res = await fetch(`${env.base}/admin`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('/mcp');
    expect(html).toContain('alpha');
    csrf = /name="_csrf" value="([^"]+)"/.exec(html)![1];
  });

  it('every state change needs the CSRF token', async () => {
    expect((await form('/admin/keys/create', { name: 'x', level: 'admin' }, { cookie })).status).toBe(403);
    expect((await form('/admin/sites/remove', { name: 'alpha' }, { cookie })).status).toBe(403);
    expect(env.app.store.site('alpha')).toBeTruthy();
  });

  it('creates a key shown once, usable immediately, revocable', async () => {
    const res = await form('/admin/keys/create', { _csrf: csrf, name: 'Laptop', level: 'draft', days: '30', sites: ['alpha'] }, { cookie });
    const html = await res.text();
    const secret = /(wpmk_[A-Za-z0-9_-]+)/.exec(html)![1];
    expect((await rpc(env, secret, 'tools/list')).status).toBe(200);
    expect(env.app.store.keys()[0].expires).toBeGreaterThan(0);
    const dash = await (await fetch(`${env.base}/admin`, { headers: { cookie } })).text();
    expect(dash).not.toContain(secret);
    await form('/admin/keys/revoke', { _csrf: csrf, id: env.app.store.keys()[0].id }, { cookie });
    expect((await rpc(env, secret, 'tools/list')).status).toBe(401);
  });

  it('connects another site with a pairing code and rejects bad ones', async () => {
    const fake = await new FakeSite('Second').start();
    const bad = await (await form('/admin/sites/add', { _csrf: csrf, url: fake.url, code: 'nope', name: 'second' }, { cookie })).text();
    expect(bad).toContain('pairing code is wrong');
    const ok = await (await form('/admin/sites/add', { _csrf: csrf, url: fake.url, code: 'WPMP-AAAA-BBBB-CCCC-DDDD', name: 'second', max_level: 'live' }, { cookie })).text();
    expect(ok).toContain('Connected &quot;second&quot;');
    expect(env.app.store.site('second')!.max_level).toBe('live');
    await form('/admin/sites/level', { _csrf: csrf, name: 'second', level: 'read' }, { cookie });
    expect(env.app.store.site('second')!.max_level).toBe('read');
    await form('/admin/sites/remove', { _csrf: csrf, name: 'second' }, { cookie });
    expect(env.app.store.site('second')).toBeUndefined();
    await fake.stop();
    void addSite;
  });

  it('throttles password guessing', async () => {
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await form('/admin/login', { password: 'wrong password ' + i })).status);
    expect(codes.at(-1)).toBe(429);
  });

  it('only follows safe "next" targets after login', async () => {
    const env2 = await createEnv([], { limits: { clientPerMin: 240, writePerMin: 60, sitePerMin: 400, tokenPerMin: 30, registerPerHour: 10, loginPer10Min: 100 } });
    const res = await fetch(`${env2.base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: OWNER_PASSWORD, next: '//evil.example/steal' }) });
    expect(res.headers.get('location')).toBe('/admin');
    await env2.stop();
  });
});
