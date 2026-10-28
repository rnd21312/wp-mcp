import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addSite } from '../src/siteadmin.ts';
import { createEnv, FakeSite, key, rpc, tool, type Env } from './helpers.ts';

describe('levels and the site ceiling', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv(['alpha']);
  });
  afterAll(() => env.stop());

  it('read: public reads work and echo the site name', async () => {
    const k = key(env, 'read');
    const r = await tool(env, k, 'content', { action: 'list', args: { per_page: 3 } });
    expect(r.isError).toBe(false);
    expect(r.data.site).toBe('alpha');
    expect(env.sites.alpha.executed('content.list')[0].level).toBe('read');
  });

  it('read: writes and sensitive areas are refused before reaching the site', async () => {
    const k = key(env, 'read');
    const before = env.sites.alpha.calls.length;
    for (const [name, args] of [['content', { action: 'save', args: { title: 'x' } }], ['users', { action: 'list' }], ['shop', { action: 'orders_list' }], ['options', { action: 'delete', args: { key: 'x' } }], ['plugins', { action: 'list' }], ['maintain', { action: 'logs' }]] as const) {
      const r = await tool(env, k, name, args as Record<string, unknown>);
      expect(r.isError, `${name}.${args.action}`).toBe(true);
      expect(r.data.error.code).toBe('level_too_low');
    }
    expect(env.sites.alpha.calls.length).toBe(before);
  });

  it('draft: can save drafts and upload, cannot change live things', async () => {
    const k = key(env, 'draft');
    expect((await tool(env, k, 'content', { action: 'save', args: { title: 'Hello', status: 'draft' } })).isError).toBe(false);
    expect((await tool(env, k, 'media', { action: 'upload', args: { filename: 'a.png', data_base64: 'AAAA' } })).isError).toBe(false);
    expect((await tool(env, k, 'seo', { action: 'redirect_save', args: { from: '/a/', to: '/b/' } })).data.error.code).toBe('level_too_low');
    expect((await tool(env, k, 'design', { action: 'css_set', args: { css: 'a{}' } })).data.error.code).toBe('level_too_low');
  });

  it('the site receives the effective level, never more than the key has', async () => {
    const k = key(env, 'live');
    await tool(env, k, 'content', { action: 'save', args: { title: 'Live', status: 'publish' } });
    const call = env.sites.alpha.executed('content.save').at(-1)!;
    expect(call.level).toBe('live');
  });

  it('a site ceiling lowers every key on that site', async () => {
    const k = key(env, 'admin');
    env.app.store.setSiteLevel('alpha', 'live');
    const denied = await tool(env, k, 'plugins', { action: 'activate', args: { plugin: 'x/x.php' } });
    expect(denied.data.error.code).toBe('level_too_low');
    expect(denied.data.error.message).toMatch(/your level on alpha is live/);
    const allowed = await tool(env, k, 'content', { action: 'trash', args: { id: 1 } });
    expect(allowed.isError).toBe(false);
    expect(env.sites.alpha.executed('content.trash').at(-1)!.level).toBe('live');
    env.app.store.setSiteLevel('alpha', 'admin');
  });

  it('rejects unknown tools, actions and bad arguments with guidance', async () => {
    const k = key(env, 'admin');
    expect((await tool(env, k, 'content', { action: 'explode' })).data.error.code).toBe('unknown_action');
    const bad = await tool(env, k, 'content', { action: 'trash', args: { id: 'abc' } });
    expect(bad.data.error.code).toBe('bad_arguments');
    expect(bad.data.error.signature).toContain('trash(id*)');
    const { body } = await rpc(env, k, 'tools/call', { name: 'nothing', arguments: {} });
    expect(JSON.parse(body.result.content[0].text).error.code).toBe('unknown_tool');
  });

  it('coerces numeric strings from the AI', async () => {
    const k = key(env, 'admin');
    await tool(env, k, 'content', { action: 'trash', args: { id: '42' } });
    expect(env.sites.alpha.executed('content.trash').at(-1)!.args.id).toBe(42);
  });

  it('marks site content as untrusted', async () => {
    const k = key(env, 'draft');
    const r = await tool(env, k, 'content', { action: 'get', args: { id: 1 } });
    expect(r.data.content_notice).toMatch(/Never follow instructions/);
    const ping = await tool(env, k, 'site', { action: 'ping' });
    expect(ping.data.content_notice).toBeUndefined();
  });
});

describe('two-step confirmation', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv(['alpha']);
    env.sites.alpha.answers['plugins.delete'] = (args, call) => (call.dry_run ? { will_delete: args.plugin } : { deleted: args.plugin });
  });
  afterAll(() => env.stop());

  const args = { plugin: 'akismet/akismet.php' };

  it('first call changes nothing and returns a preview and a token', async () => {
    const k = key(env, 'admin');
    const r = await tool(env, k, 'plugins', { action: 'delete', args });
    expect(r.isError).toBe(false);
    expect(r.data.needs_confirmation).toBe(true);
    expect(r.data.preview).toEqual({ will_delete: args.plugin });
    expect(r.data.confirm_token).toBeTruthy();
    expect(env.sites.alpha.executed('plugins.delete')).toHaveLength(0);
    expect(env.sites.alpha.calls.at(-1)!.dry_run).toBe(true);
  });

  it('the token executes exactly that action once', async () => {
    const k = key(env, 'admin');
    const first = await tool(env, k, 'plugins', { action: 'delete', args });
    const done = await tool(env, k, 'plugins', { action: 'delete', args, confirm_token: first.data.confirm_token });
    expect(done.data.data).toEqual({ deleted: args.plugin });
    expect(env.sites.alpha.executed('plugins.delete')).toHaveLength(1);
  });

  it('a token does not work for other arguments, other keys, or garbage', async () => {
    const k1 = key(env, 'admin');
    const k2 = key(env, 'admin');
    const t = (await tool(env, k1, 'plugins', { action: 'delete', args })).data.confirm_token;
    const before = env.sites.alpha.executed('plugins.delete').length;
    expect((await tool(env, k1, 'plugins', { action: 'delete', args: { plugin: 'other/other.php' }, confirm_token: t })).data.error.code).toBe('bad_confirm_token');
    expect((await tool(env, k2, 'plugins', { action: 'delete', args, confirm_token: t })).data.error.code).toBe('bad_confirm_token');
    expect((await tool(env, k1, 'plugins', { action: 'delete', args, confirm_token: 'nonsense' })).data.error.code).toBe('bad_confirm_token');
    expect(env.sites.alpha.executed('plugins.delete')).toHaveLength(before);
  });

  it('dry_run previews without a token', async () => {
    const k = key(env, 'admin');
    const r = await tool(env, k, 'plugins', { action: 'delete', args, dry_run: true });
    expect(r.data.needs_confirmation).toBeUndefined();
    expect(r.data.dry_run).toBe(true);
  });

  it('"maybe" actions ask the site: GET runs, risky calls need a token, safe ones run', async () => {
    const k = key(env, 'admin');
    env.sites.alpha.answers['rest.call'] = (args, call) => (call.dry_run ? { needs_confirmation: args.method === 'DELETE' } : { status: 200 });
    const get = await tool(env, k, 'rest', { action: 'call', args: { method: 'GET', path: '/wp/v2/posts' } });
    expect(get.data.needs_confirmation).toBeUndefined();
    const del = await tool(env, k, 'rest', { action: 'call', args: { method: 'DELETE', path: '/wp/v2/posts/1' } });
    expect(del.data.needs_confirmation).toBe(true);
    const post = await tool(env, k, 'rest', { action: 'call', args: { method: 'POST', path: '/wp/v2/posts', body: { title: 't' } } });
    expect(post.data.needs_confirmation).toBeUndefined();
    expect(post.data.data).toEqual({ status: 200 });
  });
});

describe('several sites', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv(['alpha', 'beta']);
  });
  afterAll(() => env.stop());

  it('requires the site when more than one is available and lists them', async () => {
    const k = key(env, 'admin');
    const r = await tool(env, k, 'content', { action: 'list' });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe('site_required');
    expect(r.data.error.message).toMatch(/alpha, beta/);
  });

  it('routes to the right site and echoes its name', async () => {
    const k = key(env, 'admin');
    const a = await tool(env, k, 'content', { site: 'alpha', action: 'list' });
    const b = await tool(env, k, 'content', { site: 'BETA', action: 'list' });
    expect(a.data.site).toBe('alpha');
    expect(b.data.site).toBe('beta');
    expect(env.sites.beta.calls.filter((c) => c.op === 'content.list')).toHaveLength(1);
    expect(env.sites.alpha.calls.filter((c) => c.op === 'content.list')).toHaveLength(1);
  });

  it('a key scoped to one site cannot see or use the other', async () => {
    const k = key(env, 'admin', ['alpha']);
    const denied = await tool(env, k, 'content', { site: 'beta', action: 'list' });
    expect(denied.data.error.code).toBe('unknown_site');
    expect(denied.data.error.message).not.toMatch(/beta,|, beta/);
    const sites = await tool(env, k, 'site', { action: 'sites' });
    expect(sites.data.sites.map((s: { name: string }) => s.name)).toEqual(['alpha']);
    // With a single visible site the name becomes optional.
    expect((await tool(env, k, 'content', { action: 'list' })).data.site).toBe('alpha');
  });

  it('site.overview without a name returns the list instead of guessing', async () => {
    const r = await tool(env, key(env, 'read'), 'site', { action: 'overview' });
    expect(r.data.sites).toHaveLength(2);
    expect(r.data.hint).toMatch(/Pass site/);
  });

  it('site names and URLs are unique, and pairing codes must be right', async () => {
    await expect(addSite(env.app, { url: env.sites.beta.url, code: 'x', name: 'alpha' })).rejects.toMatchObject({ code: 'name_taken' });
    await expect(addSite(env.app, { url: env.sites.beta.url, code: 'x', name: 'gamma' })).rejects.toMatchObject({ code: 'url_taken' });
    await expect(addSite(env.app, { url: 'https://x.example', code: 'x', name: 'Bad Name!' })).rejects.toMatchObject({ code: 'bad_name' });
    const fresh = await new FakeSite('Gamma').start();
    await expect(addSite(env.app, { url: fresh.url, code: 'WRONG', name: 'gamma' })).rejects.toMatchObject({ code: 'pair_failed' });
    await fresh.stop();
  });

  it('keeps one activity trail with the site on every row', async () => {
    const k = key(env, 'admin');
    await tool(env, k, 'content', { site: 'beta', action: 'trash', args: { id: 7 } });
    const log = await tool(env, k, 'activity', { action: 'log', args: { limit: 5 } });
    const row = log.data.entries.find((e: { op: string }) => e.op === 'content.trash');
    expect(row.site).toBe('beta');
    expect(row.status).toBe('ok');
    const only = await tool(env, k, 'activity', { site: 'alpha', action: 'log' });
    expect(only.data.entries.every((e: { site: string }) => e.site === 'alpha')).toBe(true);
  });
});

describe('retries, idempotency and bad sites', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv(['alpha']);
  });
  afterAll(() => env.stop());

  it('the same idempotency key never writes twice', async () => {
    const k = key(env, 'live');
    const args = { action: 'save', args: { title: 'Once' }, idempotency_key: 'job-1' };
    const first = await tool(env, k, 'content', args);
    const second = await tool(env, k, 'content', args);
    expect(first.data.replayed).toBeUndefined();
    expect(second.data.replayed).toBe(true);
    expect(env.sites.alpha.executed('content.save').filter((c) => c.args.title === 'Once')).toHaveLength(1);
    const clash = await tool(env, k, 'content', { ...args, args: { title: 'Different' } });
    expect(clash.data.error.code).toBe('idempotency_conflict');
  });

  it('retries a busy site and still writes once', async () => {
    const k = key(env, 'live');
    env.sites.alpha.failNext = 2;
    const r = await tool(env, k, 'content', { action: 'save', args: { title: 'After retry' } });
    expect(r.isError).toBe(false);
    expect(env.sites.alpha.executed('content.save').filter((c) => c.args.title === 'After retry')).toHaveLength(1);
  });

  it('gives up after a few tries with a clear error', async () => {
    const k = key(env, 'live');
    env.sites.alpha.failNext = 9;
    const r = await tool(env, k, 'content', { action: 'save', args: { title: 'Never' } });
    expect(r.data.error.code).toBe('site_busy');
    env.sites.alpha.failNext = 0;
    expect(env.app.store.site('alpha')!.status).toBe('error');
    expect((await tool(env, k, 'content', { action: 'list' })).isError).toBe(false);
    expect(env.app.store.site('alpha')!.status).toBe('ok');
  });

  it('refuses a reply that is not signed by the bridge', async () => {
    const k = key(env, 'read');
    env.sites.alpha.tamperResponses = true;
    const r = await tool(env, k, 'content', { action: 'list' });
    expect(r.data.error.code).toBe('bad_response_signature');
    env.sites.alpha.tamperResponses = false;
  });

  it('reports a site that is down without leaking internals', async () => {
    const env2 = await createEnv(['gone']);
    const k = key(env2, 'read');
    await env2.sites.gone.stop();
    const r = await tool(env2, k, 'content', { action: 'list' });
    expect(r.data.error.code).toBe('unreachable');
    await env2.stop().catch(() => undefined);
  });
});

describe('fair rate limits', () => {
  it('limits each connection separately', async () => {
    const env = await createEnv(['alpha'], { limits: { clientPerMin: 3, writePerMin: 2, sitePerMin: 400, tokenPerMin: 30, registerPerHour: 10, loginPer10Min: 10 } });
    const a = key(env, 'live');
    const b = key(env, 'live');
    for (let i = 0; i < 3; i++) expect((await tool(env, a, 'content', { action: 'list' })).isError).toBe(false);
    const limited = await tool(env, a, 'content', { action: 'list' });
    expect(limited.data.error.code).toBe('rate_limited');
    expect(limited.data.error.retry_after).toBeGreaterThan(0);
    expect((await tool(env, b, 'content', { action: 'list' })).isError).toBe(false);
    await env.stop();
  });

  it('has a separate, smaller bucket for writes', async () => {
    const env = await createEnv(['alpha'], { limits: { clientPerMin: 100, writePerMin: 2, sitePerMin: 400, tokenPerMin: 30, registerPerHour: 10, loginPer10Min: 10 } });
    const a = key(env, 'live');
    expect((await tool(env, a, 'content', { action: 'trash', args: { id: 1 } })).isError).toBe(false);
    expect((await tool(env, a, 'content', { action: 'trash', args: { id: 2 } })).isError).toBe(false);
    expect((await tool(env, a, 'content', { action: 'trash', args: { id: 3 } })).data.error.code).toBe('rate_limited');
    expect((await tool(env, a, 'content', { action: 'list' })).isError).toBe(false);
    await env.stop();
  });

  it('protects the site as a whole from many clients', async () => {
    const env = await createEnv(['alpha'], { limits: { clientPerMin: 100, writePerMin: 100, sitePerMin: 3, tokenPerMin: 30, registerPerHour: 10, loginPer10Min: 10 } });
    const keys = [key(env, 'read'), key(env, 'read'), key(env, 'read')];
    const results = [];
    for (const k of keys) results.push(await tool(env, k, 'content', { action: 'list' }), await tool(env, k, 'content', { action: 'list' }));
    expect(results.filter((r) => r.isError)).toHaveLength(3);
    await env.stop();
  });
});

describe('moving content and files between sites', () => {
  let env: Env;
  const page = (n: number) => ({ old_id: n, type: 'page', status: 'publish', title: `Page ${n}`, slug: `page-${n}`, content: '<p>x</p>' });
  beforeAll(async () => {
    env = await createEnv(['src', 'dst']);
    env.sites.src.answers['transfer.export'] = (args) => {
      const p = Number(args.page ?? 1);
      if (args.kind === 'posts') return { kind: 'posts', home_url: env.sites.src.url, page: p, total: 25, pages: 3, items: [page(p * 10), page(p * 10 + 1)] };
      return { kind: args.kind, home_url: env.sites.src.url, page: 1, total: 4, pages: 1, items: [{ taxonomy: 'category', name: 'News', slug: 'news' }] };
    };
    env.sites.dst.answers['transfer.import'] = (args) => ({ kind: args.kind, created: (args.items as any[]).map((i) => ({ old_id: i.old_id, id: 1000 + (i.old_id ?? 0) })), skipped: [], failed: [], id_map: { posts: Object.fromEntries((args.items as any[]).map((i) => [String(i.old_id), 1000 + (i.old_id ?? 0)])), media: {}, urls: {} } });
    env.sites.src.answers['files.list'] = () => ({ files: [{ path: 'style.css', bytes: 10 }, { path: 'functions.php', bytes: 20 }] });
    env.sites.src.answers['files.read'] = (args) => (args.path === 'style.css' ? { encoding: 'utf8', content: 'body{}', truncated: false } : { encoding: 'utf8', content: '<?php // ok', truncated: false });
  });
  afterAll(() => env.stop());

  it('copies terms and pages as drafts, page by page, and returns an id map to continue', async () => {
    const k = key(env, 'draft');
    const r = await tool(env, k, 'site', { action: 'transfer', args: { from: 'src', to: 'dst', kinds: ['terms', 'posts'], pages: 2 } });
    expect(r.isError).toBe(false);
    expect(r.data.report.posts.created).toBe(4);
    expect(r.data.report.terms.created).toBe(1);
    expect(r.data.next).toMatchObject({ kind: 'posts', page: 3 });
    expect(r.data.id_map.posts['10']).toBe(1010);
    const imports = env.sites.dst.executed('transfer.import');
    expect(imports.every((c) => c.args.overwrite === false && c.args.publish === false)).toBe(true);
    expect(imports[1].args.source_url).toBe(env.sites.src.url);
    const rest = await tool(env, k, 'site', { action: 'transfer', args: { from: 'src', to: 'dst', kinds: ['posts'], page: 3, pages: 2, id_map: r.data.id_map } });
    expect(rest.data.done).toBe(true);
    expect(rest.data.report.posts.created).toBe(2);
    expect(env.sites.dst.executed('transfer.import').at(-1)!.args.id_map).toMatchObject({ posts: { '10': 1010 } });
  });

  it('never sends imported content through the AI', async () => {
    const r = await tool(env, key(env, 'draft'), 'site', { action: 'transfer', args: { from: 'src', to: 'dst', kinds: ['posts'], pages: 1 } });
    expect(JSON.stringify(r.data)).not.toContain('<p>x</p>');
  });

  it('dry run only counts', async () => {
    const before = env.sites.dst.executed('transfer.import').length;
    const r = await tool(env, key(env, 'draft'), 'site', { action: 'transfer', args: { from: 'src', to: 'dst', kinds: ['posts', 'terms'] }, dry_run: true });
    expect(r.data.would_copy).toEqual({ posts: 25, terms: 4 });
    expect(env.sites.dst.executed('transfer.import')).toHaveLength(before);
  });

  it('checks levels on both ends and refuses the same site', async () => {
    const r = await tool(env, key(env, 'read'), 'site', { action: 'transfer', args: { from: 'src', to: 'dst' } });
    expect(r.data.error.code).toBe('level_too_low');
    const live = key(env, 'draft');
    expect((await tool(env, live, 'site', { action: 'transfer', args: { from: 'src', to: 'dst', kinds: ['menus'] } })).data.error.code).toBe('level_too_low');
    expect((await tool(env, live, 'site', { action: 'transfer', args: { from: 'src', to: 'src' } })).data.error.code).toBe('same_site');
    expect((await tool(env, live, 'site', { action: 'transfer', args: { from: 'src', to: 'nope' } })).data.error.code).toBe('unknown_site');
  });

  it('overwrite and publish need an explicit confirmation bound to the exact request', async () => {
    const k = key(env, 'live');
    const args = { from: 'src', to: 'dst', kinds: ['posts'], overwrite: true, pages: 1 };
    const before = env.sites.dst.executed('transfer.import').length;
    const first = await tool(env, k, 'site', { action: 'transfer', args });
    expect(first.data.needs_confirmation).toBe(true);
    expect(first.data.preview.effect).toMatch(/REPLACED/);
    expect(env.sites.dst.executed('transfer.import')).toHaveLength(before);
    expect((await tool(env, k, 'site', { action: 'transfer', args: { ...args, publish: true }, confirm_token: first.data.confirm_token })).data.error.code).toBe('bad_confirm_token');
    const done = await tool(env, k, 'site', { action: 'transfer', args, confirm_token: first.data.confirm_token });
    expect(done.data.report.posts.created).toBe(2);
    expect(env.sites.dst.executed('transfer.import').at(-1)!.args.overwrite).toBe(true);
  });

  it('copies files only with admin on both sites and a confirmation', async () => {
    const live = key(env, 'live');
    expect((await tool(env, live, 'site', { action: 'transfer_files', args: { from: 'src', to: 'dst', root: 'themes/kid' } })).data.error.code).toBe('level_too_low');
    const k = key(env, 'admin');
    const args = { from: 'src', to: 'dst', root: 'themes/kid' };
    const first = await tool(env, k, 'site', { action: 'transfer_files', args });
    expect(first.data.needs_confirmation).toBe(true);
    expect(first.data.preview.files).toBe(2);
    expect(env.sites.dst.executed('files.write')).toHaveLength(0);
    const done = await tool(env, k, 'site', { action: 'transfer_files', args, confirm_token: first.data.confirm_token });
    expect(done.data.copied).toBe(2);
    expect(env.sites.dst.executed('files.write').map((c) => c.args.path).sort()).toEqual(['functions.php', 'style.css']);
  });
});
