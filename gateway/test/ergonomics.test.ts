import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, key, tool, type Env } from './helpers.ts';

/* What AI clients actually sent in real sessions: guessed names, misplaced tokens, full paths. */

describe('names the AI guesses', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv(['alpha']);
  });
  afterAll(() => env.stop());

  const last = (op: string) => env.sites.alpha.calls.filter((c) => c.op === op).at(-1)!;

  it('maps common argument names to the real ones', async () => {
    const k = key(env, 'admin');
    await tool(env, k, 'content', { action: 'list', args: { type: 'page', limit: 5 } });
    expect(last('content.list').args).toEqual({ post_type: 'page', per_page: 5 });
    await tool(env, k, 'options', { action: 'get', args: { name: 'blogname' } });
    expect(last('options.get').args).toEqual({ keys: ['blogname'] });
    await tool(env, k, 'rest', { action: 'call', args: { method: 'GET', route: '/wp/v2/posts', params: { per_page: 3 } } });
    expect(last('rest.call').args).toEqual({ method: 'GET', path: '/wp/v2/posts', query: { per_page: 3 } });
  });

  it('downloads several files with one confirmation (fetch_many), also when the list is called files', async () => {
    const k = key(env, 'admin');
    const items = [
      { url: 'https://fonts.example/a.woff2', path: 'assets/a.woff2' },
      { url: 'https://img.example/b.png', path: 'assets/b.png' },
    ];
    const first = await tool(env, k, 'files', { action: 'fetch_many', args: { root: 'themes/x', files: items } });
    expect(first.data.needs_confirmation).toBe(true);
    await tool(env, k, 'files', { action: 'fetch_many', confirm_token: first.data.confirm_token });
    expect(last('files.fetch_many').args).toEqual({ root: 'themes/x', items });
  });

  it('snippets: reads need admin, an active save is confirmed, desc and snippet_id are understood', async () => {
    expect((await tool(env, key(env, 'live'), 'snippets', { action: 'list' })).data.error.code).toBe('level_too_low');
    const k = key(env, 'admin');
    await tool(env, k, 'snippets', { action: 'get', args: { snippet_id: '12' } });
    expect(last('snippets.get').args).toEqual({ id: 12 });
    env.sites.alpha.answers['snippets.save'] = (_args, c) => (c.dry_run ? { needs_confirmation: true } : { id: 5 });
    const first = await tool(env, k, 'snippets', {
      action: 'save',
      args: { name: 'Hide bar', code: 'add_filter("show_admin_bar","__return_false");', desc: 'x', active: true },
    });
    expect(first.data.needs_confirmation).toBe(true);
    expect(last('snippets.save').dry_run).toBe(true);
    await tool(env, k, 'snippets', { action: 'save', confirm_token: first.data.confirm_token });
    expect(last('snippets.save').dry_run).toBeFalsy();
    expect(last('snippets.save').args).toMatchObject({ name: 'Hide bar', description: 'x', active: true });
    const gate = await tool(env, k, 'snippets', { action: 'activate', args: { id: 3 } });
    expect(gate.data.needs_confirmation).toBe(true);
  });

  it('turns {name, value} into one option', async () => {
    const k = key(env, 'admin');
    await tool(env, k, 'options', { action: 'set', args: { name: 'blogname', value: 'Shop' }, dry_run: true });
    expect(last('options.set').args).toEqual({ values: { blogname: 'Shop' } });
  });

  it('accepts a number where a list of codes is expected', async () => {
    const k = key(env, 'admin');
    const r = await tool(env, k, 'seo', { action: 'redirect_save', args: { from: '/old/', to: '/new/', code: 301 } });
    expect(r.isError).toBe(false);
    expect(last('seo.redirect_save').args.code).toBe('301');
  });

  it('accepts args sent as a JSON string', async () => {
    const k = key(env, 'admin');
    await tool(env, k, 'content', { action: 'trash', args: JSON.stringify({ id: 7 }) });
    expect(last('content.trash').args).toEqual({ id: 7 });
  });

  it('maps guessed action names, and still rejects unknown ones', async () => {
    const k = key(env, 'admin');
    await tool(env, k, 'content', { action: 'create', args: { title: 'Hello', status: 'draft' } });
    expect(last('content.save').args.title).toBe('Hello');
    await tool(env, k, 'maintain', { action: 'purge_cache' });
    expect(last('maintain.cache_flush')).toBeTruthy();
    await tool(env, k, 'shop', { action: 'orders', args: { per_page: 2 } });
    expect(last('shop.orders_list').args).toEqual({ per_page: 2 });
    expect((await tool(env, k, 'content', { action: 'explode' })).data.error.code).toBe('unknown_action');
  });

  it('answers "describe" on any tool with that tool\'s actions', async () => {
    const k = key(env, 'read');
    const all = await tool(env, k, 'design', { action: 'describe' });
    expect(all.data.tool).toBe('design');
    expect(all.data.actions.some((a: { action: string }) => a.action === 'css_set')).toBe(true);
    const one = await tool(env, k, 'files', { action: 'help', args: { action: 'write' } });
    expect(one.data.id).toBe('files.write');
  });
});

describe('file roots as the AI writes them', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv(['alpha']);
  });
  afterAll(() => env.stop());

  const last = (op: string) => env.sites.alpha.calls.filter((c) => c.op === op).at(-1)!;

  it('moves the folder from the path into the root', async () => {
    const k = key(env, 'admin');
    await tool(env, k, 'files', { action: 'read', args: { root: 'themes', path: 'child/inc/assets.php' } });
    expect(last('files.read').args).toEqual({ root: 'themes/child', path: 'inc/assets.php' });
  });

  it('reads the root out of a full wp-content path', async () => {
    const k = key(env, 'admin');
    await tool(env, k, 'files', { action: 'list', args: { path: 'wp-content/plugins/my-plugin/includes' } });
    expect(last('files.list').args).toEqual({ root: 'plugins/my-plugin', path: 'includes' });
    await tool(env, k, 'files', { action: 'list', args: { path: 'wp-content/mu-plugins' } });
    expect(last('files.list').args).toEqual({ root: 'mu-plugins' });
  });

  it('keeps a bare "themes" root for listing folders, and leaves good roots alone', async () => {
    const k = key(env, 'admin');
    await tool(env, k, 'files', { action: 'list', args: { root: 'themes' } });
    expect(last('files.list').args).toEqual({ root: 'themes' });
    await tool(env, k, 'files', { action: 'read', args: { root: 'themes/child', path: 'style.css' } });
    expect(last('files.read').args).toEqual({ root: 'themes/child', path: 'style.css' });
  });

  it('renames inside one folder when both ends name it', async () => {
    const k = key(env, 'admin');
    await tool(env, k, 'files', { action: 'move', args: { root: 'plugins', from: 'shop/a.php', to: 'shop/inc/a.php' }, dry_run: true });
    expect(last('files.move').args).toEqual({ root: 'plugins/shop', from: 'a.php', to: 'inc/a.php' });
  });
});

describe('confirming without sending the work twice', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv(['alpha']);
    env.sites.alpha.answers['files.write'] = (args, call) =>
      call.dry_run ? { will_write: args.path } : { path: args.path, bytes: String(args.content).length };
  });
  afterAll(() => env.stop());

  const args = { root: 'themes/child', path: 'functions.php', content: '<?php // ' + 'x'.repeat(5000) };
  const writes = () => env.sites.alpha.executed('files.write');

  it('the token alone runs the remembered call, once', async () => {
    const k = key(env, 'admin');
    const first = await tool(env, k, 'files', { action: 'write', args });
    expect(first.data.needs_confirmation).toBe(true);
    const before = writes().length;
    const done = await tool(env, k, 'files', { action: 'write', confirm_token: first.data.confirm_token });
    expect(done.data.data).toEqual({ path: 'functions.php', bytes: args.content.length });
    expect(writes().at(-1)!.args).toEqual(args);
    const again = await tool(env, k, 'files', { action: 'write', confirm_token: first.data.confirm_token });
    expect(again.data.error.code).toBe('bad_confirm_token');
    expect(writes()).toHaveLength(before + 1);
  });

  it('finds the token inside args, with or without the arguments', async () => {
    const k = key(env, 'admin');
    const a = await tool(env, k, 'files', { action: 'write', args });
    expect((await tool(env, k, 'files', { action: 'write', args: { confirm: a.data.confirm_token } })).data.data.path).toBe(
      'functions.php',
    );
    const b = await tool(env, k, 'files', { action: 'write', args });
    expect((await tool(env, k, 'files', { action: 'write', args: { ...args, confirm_token: b.data.confirm_token } })).data.data.path).toBe(
      'functions.php',
    );
  });

  it('a remembered call belongs to its key and its action', async () => {
    const k1 = key(env, 'admin');
    const k2 = key(env, 'admin');
    const t = (await tool(env, k1, 'files', { action: 'write', args })).data.confirm_token;
    const before = writes().length;
    expect((await tool(env, k2, 'files', { action: 'write', confirm_token: t })).data.error.code).toBe('bad_confirm_token');
    expect((await tool(env, k1, 'files', { action: 'delete', confirm_token: t })).isError).toBe(true);
    expect((await tool(env, k1, 'files', { action: 'write', confirm_token: 'nonsense' })).data.error.code).toBe('bad_confirm_token');
    expect(writes()).toHaveLength(before);
  });
});

describe('results every client can take in one piece', () => {
  let env: Env;
  const file = 'خط فارسی و English.\n'.repeat(4000);
  beforeAll(async () => {
    env = await createEnv(['alpha']);
    env.sites.alpha.answers['files.read'] = (args) => {
      const bytes = Buffer.from(file, 'utf8');
      return {
        path: args.path,
        bytes: bytes.length,
        encoding: 'utf8',
        truncated: false,
        content: bytes.subarray(Number(args.offset ?? 0)).toString('utf8'),
      };
    };
    env.sites.alpha.answers['inspect.page'] = (args) => ({ max: args.max_bytes });
  });
  afterAll(() => env.stop());

  it('hands a long file over in windows that join back exactly', async () => {
    const k = key(env, 'admin');
    let offset = 0;
    let joined = '';
    for (let i = 0; i < 20; i++) {
      const r = await tool(env, k, 'files', { action: 'read', args: { root: 'themes/child', path: 'big.txt', offset } });
      expect(Buffer.byteLength(r.data.data.content, 'utf8')).toBeLessThanOrEqual(32000);
      joined += r.data.data.content;
      if (!r.data.data.next_offset) break;
      expect(r.data.data.truncated).toBe(true);
      offset = r.data.data.next_offset;
    }
    expect(joined).toBe(file);
  });

  it('asks the site for a page window by default and respects an explicit size', async () => {
    const k = key(env, 'read');
    expect((await tool(env, k, 'inspect', { action: 'page', args: { path: '/' } })).data.data.max).toBe(32000);
    expect((await tool(env, k, 'inspect', { action: 'page', args: { path: '/', max_bytes: 5000 } })).data.data.max).toBe(5000);
  });
});
