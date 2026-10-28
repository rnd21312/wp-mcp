import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, OWNER_PASSWORD, type Env } from './helpers.ts';

describe('local web panel', () => {
  let env: Env;
  let cookie = '';
  let csrf = '';
  beforeAll(async () => {
    env = await createEnv(['alpha']);
    const login = await fetch(`${env.base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: OWNER_PASSWORD }) });
    cookie = login.headers.getSetCookie()[0].split(';')[0];
    const html = await (await fetch(`${env.base}/admin/workbench`, { headers: { cookie } })).text();
    csrf = /name="_csrf" value="([^"]+)"/.exec(html)![1];
  });
  afterAll(() => env.stop());

  const run = (data: Record<string, string>, extraCookie = '') =>
    fetch(`${env.base}/admin/workbench/run`, { method: 'POST', redirect: 'manual', headers: { cookie: cookie + extraCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...data }) });

  it('is Persian and right-to-left by default, and switches to English', async () => {
    const fa = await (await fetch(`${env.base}/admin`, { headers: { cookie } })).text();
    expect(fa).toContain('dir="rtl"');
    expect(fa).toContain('اتصال یک سایت');
    const en = await (await fetch(`${env.base}/admin`, { headers: { cookie: `${cookie}; wpm_lang=en` } })).text();
    expect(en).toContain('Connect a site');
    expect(en).not.toContain('dir="rtl"');
    const sw = await fetch(`${env.base}/admin/lang?l=en`, { redirect: 'manual', headers: { cookie } });
    expect(sw.headers.getSetCookie()[0]).toContain('wpm_lang=en');
  });

  it('serves the workbench with a nonce-based CSP and the action catalogue', async () => {
    const res = await fetch(`${env.base}/admin/workbench`, { headers: { cookie: `${cookie}; wpm_lang=en` } });
    const csp = res.headers.get('content-security-policy')!;
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
    const html = await res.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain('"name":"transfer"');
    expect(html).toContain('"action":"audit"');
    expect(csp).not.toContain('unsafe-eval');
    expect(await (await fetch(`${env.base}/admin/workbench`, { redirect: 'manual' })).status).toBe(303);
  });

  it('runs an action as the chosen level and shows the answer', async () => {
    const res = await run({ tool: 'content', action: 'list', site: 'alpha', level: 'read', args: '{"per_page":2}' }, '; wpm_lang=en');
    const html = await res.text();
    expect(html).toContain('Result');
    expect(html).toContain('&quot;site&quot;: &quot;alpha&quot;');
    expect(env.sites.alpha.executed('content.list').at(-1)!.level).toBe('read');
  });

  it('respects levels like the AI does', async () => {
    const html = await (await run({ tool: 'content', action: 'trash', site: 'alpha', level: 'read', args: '{"id":1}' })).text();
    expect(html).toContain('level_too_low');
  });

  it('shows a confirmation step that really runs only after you confirm', async () => {
    env.sites.alpha.answers['plugins.delete'] = (args, call) => (call.dry_run ? { will_delete: args.plugin } : { deleted: args.plugin });
    const data = { tool: 'plugins', action: 'delete', site: 'alpha', level: 'admin', args: '{"plugin":"akismet/akismet.php"}' };
    const first = await (await run(data, '; wpm_lang=en')).text();
    expect(first).toContain('Confirm and run');
    expect(env.sites.alpha.executed('plugins.delete')).toHaveLength(0);
    const token = /name="confirm_token" value="([^"]+)"/.exec(first.slice(first.indexOf('Confirm and run') - 600))![1];
    await run({ ...data, confirm_token: token });
    expect(env.sites.alpha.executed('plugins.delete')).toHaveLength(1);
  });

  it('rejects bad JSON and missing CSRF', async () => {
    expect(await (await run({ tool: 'content', action: 'list', level: 'read', args: '{nope' })).text()).toContain('not valid JSON');
    const bad = await fetch(`${env.base}/admin/workbench/run`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ tool: 'content', action: 'list' }) });
    expect(bad.status).toBe(403);
  });

  it('prints ready-to-copy connection commands for this installation', async () => {
    const html = await (await fetch(`${env.base}/admin/connect`, { headers: { cookie } })).text();
    expect(html).toContain('claude mcp add wp');
    expect(html).toContain('stdio');
    expect(html).toContain(`${env.base}/mcp`);
    expect(html).toContain('WPMCP_DATA_DIR');
  });
});
