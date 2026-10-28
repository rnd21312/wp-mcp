import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, type Env } from './helpers.ts';

describe('local passwordless panel', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv(['alpha'], { localPanel: true }, { owner: false });
  });
  afterAll(() => env.stop());

  const api = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${env.base}/admin/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-wpm-panel': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('needs no password or token', async () => {
    const res = await api('state');
    expect(res.status).toBe(200);
    const state = (await res.json()) as any;
    expect(state.sites[0].name).toBe('alpha');
    expect(state.levels).toEqual(['read', 'draft', 'live', 'admin']);
    expect(JSON.stringify(state)).not.toMatch(/secret|hash/i);
    expect((await fetch(`${env.base}/admin`)).status).toBeLessThan(600);
  });

  it('refuses requests that lack the panel header or come from another origin', async () => {
    expect((await fetch(`${env.base}/admin/api/state`)).status).toBe(403);
    expect((await api('state', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await api('sites/remove', { name: 'alpha' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(env.app.store.site('alpha')).toBeTruthy();
  });

  it('refuses a foreign Host header (DNS rebinding)', async () => {
    const port = (env.server.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/admin/api/state', headers: { host: 'evil.example', 'x-wpm-panel': '1' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.end();
    });
    expect(status).toBe(403);
  });

  it('runs tools with the same level rules as the AI', async () => {
    const ok = (await (await api('run', { tool: 'content', action: 'list', site: 'alpha', level: 'read', args: {} })).json()) as any;
    expect(ok.ok).toBe(true);
    expect(ok.site).toBe('alpha');
    const denied = (await (await api('run', { tool: 'content', action: 'trash', site: 'alpha', level: 'read', args: { id: 1 } })).json()) as any;
    expect(denied.error.code).toBe('level_too_low');
  });

  it('keeps the confirmation step', async () => {
    env.sites.alpha.answers['plugins.delete'] = (args, call) => (call.dry_run ? { will_delete: args.plugin } : { deleted: args.plugin });
    const first = (await (await api('run', { tool: 'plugins', action: 'delete', site: 'alpha', level: 'admin', args: { plugin: 'a/a.php' } })).json()) as any;
    expect(first.needs_confirmation).toBe(true);
    expect(env.sites.alpha.executed('plugins.delete')).toHaveLength(0);
    await api('run', { tool: 'plugins', action: 'delete', site: 'alpha', level: 'admin', args: { plugin: 'a/a.php' }, confirm_token: first.confirm_token });
    expect(env.sites.alpha.executed('plugins.delete')).toHaveLength(1);
  });

  it('manages sites, keys and ceilings', async () => {
    await api('sites/level', { name: 'alpha', level: 'live' });
    expect(env.app.store.site('alpha')!.max_level).toBe('live');
    const created = (await (await api('keys/create', { name: 'laptop', level: 'draft', days: 30, sites: [] })).json()) as any;
    expect(created.token).toMatch(/^wpmk_/);
    expect(((await (await api('state')).json()) as any).keys[0].name).toBe('laptop');
    const bad = (await (await api('sites/add', { url: 'https://nowhere.invalid', code: 'x' })).json()) as any;
    expect(bad.ok).toBe(false);
  });

  it('the panel does not exist when local mode is off', async () => {
    const remote = await createEnv(['alpha']);
    const res = await fetch(`${remote.base}/admin/api/state`, { headers: { 'x-wpm-panel': '1' }, redirect: 'manual' });
    expect(res.status).toBe(303); // login page
    await remote.stop();
  });
});
