import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { planBuild } from '../src/mcp/build.ts';
import { createEnv, key, tool, type Env } from './helpers.ts';

const MAP = {
  theme: { scaffold: { base: 'classic-rtl', slug: 'x-shop', name: 'X Shop' } },
  tokens: { colors: { primary: '#0a7f5a' } },
  pages: [
    { key: 'home', title: 'Home', patterns: [{ name: 'hero', text: { headline: 'Hello' } }] },
    { key: 'about', title: 'About', parent: 'home' },
  ],
  menu: {
    name: 'Main',
    location: 'primary',
    items: [
      { title: 'Home', page: 'home' },
      { title: 'Blog', url: '/blog/' },
    ],
  },
  homepage: { front: 'home' },
  options: { blogname: 'X Shop' },
};

describe('planBuild (the site map)', () => {
  it('turns a map into ordered steps', () => {
    const plan = planBuild(MAP);
    expect(plan.errors).toEqual([]);
    expect(plan.steps.map((s) => s.label)).toEqual([
      'build theme x-shop from classic-rtl',
      'set design tokens',
      'page home (Home)',
      'page about (About)',
      'menu Main',
      'home page and blog page',
      'options',
    ]);
  });

  it('refuses a broken map with clear messages', () => {
    const bad = planBuild({
      pages: [
        { key: 'Bad Key', title: 'x' },
        { key: 'a', title: 'A' },
        { key: 'a', title: 'B' },
      ],
      menu: { name: 'M', items: [{ title: 'Ghost', page: 'ghost' }, { title: 'Nowhere' }] },
      homepage: { front: 'ghost' },
      nonsense: 1,
    });
    expect(bad.steps).toEqual([]);
    expect(bad.errors.join(' ')).toMatch(/Unknown map keys: nonsense/);
    expect(bad.errors.join(' ')).toMatch(/Bad Key/);
    expect(bad.errors.join(' ')).toMatch(/"a" is used twice/);
    expect(bad.errors.join(' ')).toMatch(/no page "ghost"/);
    expect(bad.errors.join(' ')).toMatch(/needs page or url/);
    expect(planBuild({}).errors[0]).toMatch(/empty/);
  });
});

describe('site.build through the gateway', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv(['alpha']);
  });
  afterAll(() => env.stop());

  const site = () => env.sites.alpha;
  let nextId = 100;
  beforeEach(() => {
    site().calls.length = 0;
    nextId = 100;
    site().answers['content.save'] = () => ({ id: ++nextId, status: 'draft', url: 'https://x/' });
    site().answers['design.pattern_get'] = (args) => ({ content: `<!-- ${args.name} -->` });
    site().answers['design.menu_save'] = () => ({ menu_id: 7 });
  });
  const build = (k: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    tool(env, k, 'site', { action: 'build', args, ...extra });

  it('a dry run only lists the steps', async () => {
    const r = await build(key(env, 'admin'), { map: MAP }, { dry_run: true });
    expect(r.data.dry_run).toBe(true);
    expect(r.data.steps).toHaveLength(7);
    expect(r.data.needs_level).toBe('admin');
    expect(site().calls).toHaveLength(0);
  });

  it('is confirmed once, then runs in order and links pages into the menu and home page', async () => {
    const k = key(env, 'admin');
    const first = await build(k, { map: MAP });
    expect(first.data.needs_confirmation).toBe(true);
    expect(site().calls).toHaveLength(0);
    const done = await build(k, { map: MAP }, { confirm_token: first.data.confirm_token });
    expect(done.data.ok).toBe(true);
    expect(
      site()
        .executed()
        .map((c) => c.op),
    ).toEqual([
      'design.theme_scaffold',
      'design.tokens_set',
      'design.pattern_get',
      'content.save',
      'content.save',
      'design.menu_save',
      'design.homepage_set',
      'options.set',
    ]);
    const saves = site().executed('content.save');
    expect(saves[0]!.args).toMatchObject({ post_type: 'page', title: 'Home', status: 'draft', content: '<!-- hero -->' });
    expect(saves[1]!.args).toMatchObject({ title: 'About', parent: 101 });
    expect(site().executed('design.menu_save')[0]!.args).toEqual({
      name: 'Main',
      locations: ['primary'],
      items: [
        { title: 'Home', object: 'page', object_id: 101 },
        { title: 'Blog', url: '/blog/' },
      ],
    });
    expect(site().executed('design.homepage_set')[0]!.args).toEqual({ show_on_front: 'page', front_page_id: 101 });
    expect(site().executed('design.theme_scaffold')[0]!.args).toMatchObject({ slug: 'x-shop', activate: true });
    expect(done.data.page_ids).toEqual({ home: 101, about: 102 });
  });

  it('a confirm_token does not work for another map', async () => {
    const k = key(env, 'admin');
    const first = await build(k, { map: MAP });
    const r = await build(k, { map: { ...MAP, options: { blogname: 'Other' } } }, { confirm_token: first.data.confirm_token });
    expect(r.data.error.code).toBe('bad_confirm_token');
  });

  it('needs the level of its steps: pages alone work at live, a theme needs admin', async () => {
    const live = key(env, 'live');
    const pagesOnly = { pages: [{ key: 'home', title: 'Home', content: '<p>x</p>' }] };
    expect((await build(live, { map: pagesOnly })).data.needs_confirmation).toBe(true);
    const denied = await build(live, { map: MAP });
    expect(denied.data.error.code).toBe('level_too_low');
    expect(denied.data.error.needs).toBe('admin');
    expect(site().calls).toHaveLength(0);
  });

  it('stops at the first failure and resumes without repeating the pages', async () => {
    const k = key(env, 'admin');
    const RMAP = { ...MAP, options: { blogname: 'Resume Shop' } }; // another map: the bridge replays an identical earlier step
    let fail = true;
    site().answers['design.menu_save'] = () => {
      if (fail) throw new Error('menu locations missing');
      return { menu_id: 7 };
    };
    const first = await build(k, { map: RMAP });
    const failed = await build(k, { map: RMAP }, { confirm_token: first.data.confirm_token });
    expect(failed.isError).toBe(true);
    expect(failed.data.failed_step).toMatchObject({ step: 5, label: 'menu Main' });
    expect(failed.data.page_ids).toEqual({ home: 101, about: 102 });
    expect(failed.data.done).toHaveLength(4);
    expect(failed.data.resume).toMatch(/from_step: 5/);

    fail = false;
    const resume = { map: RMAP, from_step: 5, page_ids: failed.data.page_ids };
    const again = await build(k, resume);
    const finished = await build(k, resume, { confirm_token: again.data.confirm_token });
    expect(JSON.stringify(finished.data)).toContain('"ok":true');
    expect(site().executed('content.save')).toHaveLength(2); // not repeated
    expect(site().executed('design.menu_save').at(-1)!.args).toMatchObject({ items: [{ object_id: 101 }, {}] });
    expect(site().executed('options.set')).toHaveLength(1);
  });
});
