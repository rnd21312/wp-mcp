import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopAll } from '../src/workspace.ts';
import { createEnv, type Env } from './helpers.ts';

describe('VS Code workspace: pull, edit locally, live sync back', () => {
  let env: Env;
  const dataDir = mkdtempSync(join(tmpdir(), 'wpmcp-ws-'));
  beforeAll(async () => {
    env = await createEnv(['alpha'], { localPanel: true, dataDir }, { owner: false });
    env.sites.alpha.answers['design.theme_files'] = () => ({ theme: 'kid', files: [{ path: 'style.css', bytes: 12 }, { path: 'inc/helpers.php', bytes: 30 }, { path: 'screenshot.png', bytes: 9 }] });
    env.sites.alpha.answers['design.theme_file_read'] = (args) => ({ path: args.path, content: args.path === 'style.css' ? 'body{color:red}' : '<?php // helpers', truncated: false });
  });
  afterAll(async () => {
    stopAll();
    await env.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const api = async (path: string, body?: unknown) => (await (await fetch(`${env.base}/admin/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-wpm-panel': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json()) as any;

  it('pulls the theme text files to a local folder', async () => {
    const r = await api('ws/pull', { site: 'alpha' });
    expect(r).toMatchObject({ ok: true, files: 2, theme: 'kid' });
    expect(readFileSync(join(r.dir, 'style.css'), 'utf8')).toBe('body{color:red}');
    expect(existsSync(join(r.dir, 'inc', 'helpers.php'))).toBe(true);
    expect(existsSync(join(r.dir, 'screenshot.png'))).toBe(false);
    expect((await api('ws/status?site=alpha')).pulled).toBe(true);
  });

  it('pushes saved edits to the site while watching, and only changed files', async () => {
    const dir = (await api('ws/status?site=alpha')).dir;
    const on = await api('ws/watch', { site: 'alpha', on: true });
    expect(on.watching).toBe(true);
    writeFileSync(join(dir, 'style.css'), 'body{color:blue}');
    writeFileSync(join(dir, 'inc', 'helpers.php'), '<?php // helpers'); // unchanged content: must not be pushed
    await new Promise((r) => setTimeout(r, 1500));
    const writes = env.sites.alpha.executed('design.theme_file_write');
    expect(writes).toHaveLength(1);
    expect(writes[0].args).toEqual({ path: 'style.css', content: 'body{color:blue}' });
    expect(writes[0].level).toBe('admin');
    const st = await api('ws/status?site=alpha');
    expect(st.events[0]).toMatchObject({ path: 'style.css', ok: true });
    expect(env.app.store.activity({ limit: 5 }).some((a) => a.summary.includes('live sync style.css'))).toBe(true);
    await api('ws/watch', { site: 'alpha', on: false });
    writeFileSync(join(dir, 'style.css'), 'body{color:green}');
    await new Promise((r) => setTimeout(r, 900));
    expect(env.sites.alpha.executed('design.theme_file_write')).toHaveLength(1);
  });

  it('needs the admin ceiling on the site', async () => {
    env.app.store.setSiteLevel('alpha', 'live');
    const r = await api('ws/pull', { site: 'alpha' });
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/ceiling "admin"/);
  });
});
