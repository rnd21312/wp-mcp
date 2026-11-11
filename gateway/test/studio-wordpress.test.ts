import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/auth/auth.ts';
import { encrypt } from '../src/core/crypto.ts';
import type { Level } from '../src/core/levels.ts';
import { callTool, listTools } from '../src/mcp/tools.ts';
import { createEnv, type Env } from './helpers.ts';

const installs: Record<string, any>[] = [];

vi.mock('../src/studio/wordpress.ts', async (original) => {
  const real = await original<typeof import('../src/studio/wordpress.ts')>();
  return {
    ...real,
    createWordPress: async (_app: unknown, input: Record<string, any>) => {
      installs.push(input);
      return {
        site: { name: 'new-shop' },
        url: 'https://h.test/new-shop/',
        admin_user: 'admin-ab12',
        admin_password: 'S3cret-generated-password',
        wp_version: '6.8',
      };
    },
  };
});

const who = (level: Level, sites: Principal['sites'] = '*'): Principal => ({
  id: `t-${level}`,
  kind: 'api_key',
  name: `test ${level}`,
  level,
  sites,
});

describe('studio.wordpress_install', () => {
  let env: Env;
  let dir: string;
  const run = async (level: Level, action: string, args: Record<string, unknown> = {}, confirm?: string) => {
    const r = await callTool(env.app, who(level), 'studio', { action, args, confirm_token: confirm });
    return { ...JSON.parse(r.content[0]!.text), isError: !!r.isError };
  };
  const args = { host: 'h', title: 'New Shop', admin_email: 'me@example.com', db_profile: 'main', name: 'new-shop' };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpm-wp-'));
    env = await createEnv([], { dataDir: dir }, { owner: false });
    env.app.store.addHost({
      name: 'h',
      url: 'https://h.test/wpm-agent/',
      key_id: 'k',
      secret_enc: encrypt(env.config.masterKey, 'x'),
      level: 'admin',
    });
    env.app.store.hostHealth('h', true, '', { version: '2.0.0', caps: { php: { version: '8.3.0' } } });
    mkdirSync(join(dir, 'db-profiles'));
    writeFileSync(
      join(dir, 'db-profiles', 'main.json'),
      JSON.stringify({ method: 'mysql_root', host: 'localhost', root_pass: 'ROOT-DB-SECRET' }),
    );
    writeFileSync(join(dir, 'db-profiles', 'broken.json'), '{ nope');
  });
  afterAll(() => env.stop());

  it('is for admin only and lists profile names, never their contents', async () => {
    const actions = (level: Level) =>
      (listTools(who(level)).find((t) => t.name === 'studio')!.inputSchema as any).properties.action.enum as string[];
    expect(actions('live')).not.toContain('wordpress_install');
    expect(actions('admin')).toEqual(expect.arrayContaining(['wordpress_install', 'db_profiles']));
    const r = await run('admin', 'db_profiles');
    expect(r.profiles).toEqual([{ name: 'main', method: 'mysql_root' }]); // an unreadable profile is not offered
    expect(JSON.stringify(r)).not.toContain('ROOT-DB-SECRET');
  });

  it('refuses credentials in the arguments and unknown profiles', async () => {
    expect((await run('admin', 'wordpress_install', { ...args, db: { method: 'manual', pass: 'x' } })).error.code).toBe('not_allowed');
    expect((await run('admin', 'wordpress_install', { ...args, admin_password: 'x' })).error.code).toBe('not_allowed');
    expect((await run('admin', 'wordpress_install', { ...args, db_profile: 'nope' })).error.code).toBe('no_db_profile');
    expect((await run('admin', 'wordpress_install', { ...args, db_profile: '../main' })).error.code).toBe('bad_db_profile');
    expect((await run('admin', 'wordpress_install', { ...args, db_profile: 'broken' })).error.code).toBe('bad_db_profile');
    expect(installs).toHaveLength(0);
  });

  it('is confirmed first with a preview that holds no secret, then installs with the profile', async () => {
    const first = await run('admin', 'wordpress_install', args);
    expect(first.needs_confirmation).toBe(true);
    expect(first.preview.database).toEqual({ profile: 'main', method: 'mysql_root' });
    expect(JSON.stringify(first)).not.toContain('ROOT-DB-SECRET');
    expect(installs).toHaveLength(0);

    const done = await run('admin', 'wordpress_install', args, first.confirm_token);
    expect(done.ok).toBe(true);
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({
      host: 'h',
      title: 'New Shop',
      adminEmail: 'me@example.com',
      name: 'new-shop',
      db: { method: 'mysql_root', root_pass: 'ROOT-DB-SECRET' },
    });
    expect(installs[0]!.adminPassword).toBeUndefined();

    // the AI sees where the password is, not the password
    expect(JSON.stringify(done)).not.toContain('S3cret-generated-password');
    expect(existsSync(done.credentials_saved_to)).toBe(true);
    expect(readFileSync(done.credentials_saved_to, 'utf8')).toContain('S3cret-generated-password');
    if (process.platform !== 'win32') expect(statSync(done.credentials_saved_to).mode & 0o077).toBe(0);
  });

  it('a token of another action or other arguments does not install', async () => {
    const first = await run('admin', 'wordpress_install', args);
    const other = await run('admin', 'wordpress_install', { ...args, title: 'Different' }, first.confirm_token);
    expect(other.error.code).toBe('bad_confirm_token');
  });
});
