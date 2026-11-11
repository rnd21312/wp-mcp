import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addSite } from '../src/sites/siteadmin.ts';
import { createEnv, key, tool, type Env } from './helpers.ts';

/**
 * Runs the real gateway against a real WordPress with the bridge installed (see the "wordpress" job in .github/workflows/ci.yml).
 * Skipped unless WPMCP_LIVE_WP_URL and WPMCP_LIVE_WP_CODE (a fresh pairing code) are set, so a normal `npm test` never needs WordPress.
 */
const URL_ = process.env.WPMCP_LIVE_WP_URL ?? '';
const CODE = process.env.WPMCP_LIVE_WP_CODE ?? '';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe.skipIf(!URL_ || !CODE)('real WordPress with the bridge', () => {
  let env: Env;
  let admin: string;

  /** One call; a call that needs confirmation is confirmed with its token, like a person agreeing. */
  const go = async (name: string, action: string, args: Record<string, unknown> = {}) => {
    let r = await tool(env, admin, name, { site: 'live', action, args });
    if (r.data?.needs_confirmation) r = await tool(env, admin, name, { site: 'live', action, confirm_token: r.data.confirm_token });
    expect(r.isError, `${name}.${action}: ${JSON.stringify(r.data).slice(0, 400)}`).toBe(false);
    return r.data;
  };

  beforeAll(async () => {
    env = await createEnv([], { dataDir: process.env.RUNNER_TEMP ?? process.env.TEMP ?? '.' });
    await addSite(env.app, { url: URL_, code: CODE, name: 'live' });
    admin = key(env, 'admin');
  }, 60000);
  afterAll(() => env?.stop());

  it('pairs and answers the overview', async () => {
    const d = await go('site', 'overview');
    expect(d.data.bridge.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(d.data.wordpress).toMatch(/^\d/);
  });

  it('writes, reads and patches a theme file', async () => {
    await go('files', 'write', {
      root: 'themes/live-test',
      path: 'style.css',
      content: '/*\nTheme Name: Live Test\n*/\nbody{color:#111}\n',
    });
    expect((await go('files', 'read', { root: 'themes/live-test', path: 'style.css' })).data.content).toContain('color:#111');
    await go('files', 'patch', { root: 'themes/live-test', path: 'style.css', edits: [{ old: '#111', new: '#222' }] });
    expect((await go('files', 'read', { root: 'themes/live-test', path: 'style.css' })).data.content).toContain('color:#222');
    const found = await go('files', 'search', { root: 'themes/live-test', query: '#222' });
    expect(JSON.stringify(found.data)).toContain('style.css');
  });

  it('rejects PHP with a syntax error and leaves the site answering', async () => {
    const r = await tool(env, admin, 'files', {
      site: 'live',
      action: 'write',
      args: { root: 'themes/live-test', path: 'broken.php', content: '<?php $a = ;' },
    });
    const token = r.data.confirm_token as string | undefined;
    const done = token ? await tool(env, admin, 'files', { site: 'live', action: 'write', confirm_token: token }) : r;
    expect(JSON.stringify(done.data)).toContain('syntax_error');
    expect((await go('inspect', 'page', { path: '/' })).data.status).toBeLessThan(500);
  });

  it('sets a wp-config constant and the site still answers', async () => {
    await go('maintain', 'config_set', { name: 'WP_POST_REVISIONS', value: 7 });
    expect(JSON.stringify((await go('maintain', 'config_get', { names: ['WP_POST_REVISIONS'] })).data)).toContain('7');
    expect((await go('inspect', 'page', { path: '/' })).data.status).toBeLessThan(500);
  });

  it('uploads an image', async () => {
    const d = await go('media', 'upload', { filename: 'dot.png', data_base64: PNG, alt: 'A dot' });
    expect(d.data.id).toBeGreaterThan(0);
  });

  it('saves a page and reads it back; a stale page template does not block saving', async () => {
    const saved = await go('content', 'save', { post_type: 'page', title: 'CI Page', content: '<p>Hello</p>', status: 'draft' });
    const id = saved.data.id as number;
    expect((await go('content', 'get', { id })).data.title).toBe('CI Page');
    await go('content', 'meta_set', { object: 'post', id, key: '_wp_page_template', value: 'templates/gone.php' });
    const again = await go('content', 'save', { id, title: 'CI Page 2', template: '' });
    expect(again.data.id).toBe(id);
  });

  it('builds a theme and a plugin from scaffolds', async () => {
    await go('design', 'theme_scaffold', { base: 'classic-rtl', slug: 'ci-theme', name: 'CI Theme' });
    expect(JSON.stringify((await go('design', 'themes_list')).data)).toContain('ci-theme');
    await go('plugins', 'scaffold', { slug: 'ci-plugin', name: 'CI Plugin', features: ['shortcode', 'rest'], install: true });
    expect(JSON.stringify((await go('plugins', 'list')).data)).toContain('ci-plugin');
    expect((await go('inspect', 'page', { path: '/' })).data.status).toBeLessThan(500);
  });

  it('builds pages, a menu and a home page from one map', async () => {
    const d = await go('site', 'build', {
      map: {
        pages: [
          { key: 'home', title: 'Home', patterns: [{ name: 'hero' }] },
          { key: 'about', title: 'About', content: '<p>About</p>' },
        ],
        menu: {
          name: 'CI Menu',
          items: [
            { title: 'Home', page: 'home' },
            { title: 'About', page: 'about' },
          ],
        },
        homepage: { front: 'home' },
      },
    });
    expect(d.ok).toBe(true);
    expect(Object.keys(d.page_ids)).toEqual(['home', 'about']);
  });

  it('checks the core files, IndexNow and links', async () => {
    const core = await go('maintain', 'core_verify');
    expect(core.data.counts.modified).toBe(0);
    await go('seo', 'indexnow_setup');
    expect((await go('seo', 'indexnow_status')).data.key_file_reachable).toBe(true);
    const links = await go('seo', 'links_check', { recent: 3 });
    expect(links.data.links_checked).toBeGreaterThanOrEqual(0);
    expect((await go('design', 'pattern_get', { name: 'hero' })).data.content).toContain('wp:heading');
    expect((await go('design', 'tokens_audit')).data.summary).toBeTruthy();
  });
});
