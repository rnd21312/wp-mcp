import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stdioLevel, stdioPrincipal } from '../src/auth.ts';
import { callTool } from '../src/mcp/tools.ts';
import { createEnv, type Env } from './helpers.ts';

describe('stdio connection level', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv(['alpha'], { localPanel: true }, { owner: false });
  });
  afterAll(() => env.stop());

  const api = (path: string, body?: unknown) =>
    fetch(`${env.base}/admin/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-wpm-panel': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as Promise<any>);

  it('defaults to live, or to WPMCP_STDIO_LEVEL when set', () => {
    expect(stdioLevel(env.app, {})).toBe('live');
    expect(stdioLevel(env.app, { WPMCP_STDIO_LEVEL: 'draft' })).toBe('draft');
    expect(stdioLevel(env.app, { WPMCP_STDIO_LEVEL: 'nonsense' })).toBe('live');
  });

  it('is changed from the panel and applies to the very next call without a restart', async () => {
    const principal = stdioPrincipal(env.app); // the long-lived object a stdio process keeps
    expect((await api('state')).stdio).toMatchObject({ from: 'default' });

    expect((await api('stdio/level', { level: 'read' })).ok).toBe(true);
    expect(principal.level).toBe('read');
    expect((await api('state')).stdio).toEqual({ level: 'read', from: 'panel' });
    const denied = JSON.parse((await callTool(env.app, principal, 'content', { site: 'alpha', action: 'trash', args: { id: 1 } })).content[0].text);
    expect(denied.error.code).toBe('level_too_low');

    expect((await api('stdio/level', { level: 'admin' })).ok).toBe(true);
    expect(principal.level).toBe('admin');

    expect((await api('stdio/level', { level: 'superuser' })).ok).toBe(false);
    expect(principal.level).toBe('admin'); // an invalid value changes nothing

    expect((await api('stdio/level', { level: 'default' })).ok).toBe(true);
    expect(principal.level).toBe(stdioLevel(env.app));
    expect((await api('state')).stdio.from).toBe('default');
  });

  it('cannot be changed by a page on another origin', async () => {
    const res = await fetch(`${env.base}/admin/api/stdio/level`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wpm-panel': '1', origin: 'https://evil.example' }, body: JSON.stringify({ level: 'admin' }) });
    expect(res.status).toBe(403);
  });
});
