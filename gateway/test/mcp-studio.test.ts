import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentClient } from '../src/agentclient.ts';
import type { Principal } from '../src/auth.ts';
import { encrypt } from '../src/crypto.ts';
import type { Level } from '../src/levels.ts';
import { callTool, listTools } from '../src/mcp/tools.ts';
import { createProject } from '../src/projects.ts';
import { createEnv, type Env } from './helpers.ts';

const who = (level: Level, sites: Principal['sites'] = '*'): Principal => ({ id: `t-${level}`, kind: 'api_key', name: `test ${level}`, level, sites });

describe('studio MCP tool', () => {
  let env: Env;
  const agentCalls: { op: string; args: Record<string, any> }[] = [];
  let deployed = 0;
  const run = async (level: Level, action: string, args: Record<string, unknown> = {}, confirm?: string, sites: Principal['sites'] = '*') => {
    const r = await callTool(env.app, who(level, sites), 'studio', { action, args, confirm_token: confirm });
    return { ...JSON.parse(r.content[0].text), isError: !!r.isError };
  };

  beforeAll(async () => {
    env = await createEnv([], { dataDir: mkdtempSync(join(tmpdir(), 'wpm-mcps-')) }, { owner: false });
    env.app.agents = {
      call: async (_h: unknown, op: string, args: Record<string, any> = {}) => {
        agentCalls.push({ op, args });
        if (op === 'sites.create') return { site: { id: args.name } };
        if (op === 'releases.list') return { current: 'r2', releases: [{ id: 'r2' }, { id: 'r1' }] };
        if (op === 'rollback') return { current: 'r1', previous: 'r2' };
        return {};
      },
      deploy: async () => ({ id: `rel${++deployed}`, previous: null, mode: 'sync', created: 0, files: 0, bytes: 0, sha256: '', note: '', by: '' }),
    } as unknown as AgentClient;
    env.app.store.addHost({ name: 'h', url: 'https://h.test/wpm-agent/', key_id: 'k', secret_enc: encrypt(env.config.masterKey, 'x'), level: 'admin' });
    env.app.store.hostHealth('h', true, '', { version: '2.0.0', caps: { php: { version: '8.3.0' } } });
  });
  afterAll(() => env.stop());

  const actionsOf = (level: Level): string[] => (listTools(who(level)).find((t) => t.name === 'studio')!.inputSchema as any).properties.action.enum;

  it('is offered only to connections that are not limited to some WordPress sites, with actions by level', () => {
    expect(actionsOf('read')).toEqual(['hosts', 'projects', 'files', 'read_file', 'releases']);
    expect(actionsOf('draft')).toEqual(expect.arrayContaining(['write_file', 'create_project']));
    expect(actionsOf('draft')).not.toContain('deploy');
    expect(actionsOf('live')).toEqual(expect.arrayContaining(['deploy', 'rollback']));
    expect(listTools(who('live', ['alpha'])).some((t) => t.name === 'studio')).toBe(false);
  });

  it('does not offer builds, Node apps, WordPress creation or secrets', () => {
    const all = Object.keys(actionsOf('admin').reduce((o, a) => ({ ...o, [a]: 1 }), {}));
    for (const forbidden of ['build', 'env', 'wordpress', 'node_script', 'update_agent', 'pair', 'db']) expect(all).not.toContain(forbidden);
  });

  it('refuses what the level does not allow', async () => {
    expect((await run('read', 'write_file', { project: 'x', path: 'a.html', content: 'x' })).error.code).toBe('level_too_low');
    expect((await run('draft', 'deploy', { project: 'x', host: 'h' })).error.code).toBe('level_too_low');
    expect((await run('live', 'projects', {}, undefined, ['alpha'])).error.code).toBe('not_allowed');
    expect((await run('admin', 'build', {})).error.code).toBe('unknown_action');
  });

  it('creates a project, edits files inside it and cannot leave it', async () => {
    const made = await run('draft', 'create_project', { name: 'ai-site', template: 'landing', title: 'AI Site' });
    expect(made.ok).toBe(true);
    expect(made.files.map((f: any) => f.path)).toContain('index.html');
    expect((await run('draft', 'write_file', { project: 'ai-site', path: 'about.html', content: '<h1>About</h1>' })).ok).toBe(true);
    expect((await run('read', 'read_file', { project: 'ai-site', path: 'about.html' })).content).toBe('<h1>About</h1>');
    for (const bad of ['../x.html', '/etc/passwd', 'a/../../x', 'C:/x', '..']) {
      expect((await run('draft', 'write_file', { project: 'ai-site', path: bad, content: 'x' })).error.code, bad).toBe('bad_path');
      expect((await run('read', 'read_file', { project: 'ai-site', path: bad })).isError, bad).toBe(true);
    }
    expect((await run('draft', 'delete_file', { project: 'ai-site', path: 'about.html' })).ok).toBe(true);
    expect((await run('draft', 'create_project', { name: 'x2', template: 'next-ssr' })).error.code).toBe('bad_template');
    expect((await run('read', 'read_file', { project: 'nope', path: 'a' })).error.code).toBe('no_project');
  });

  it('keeps framework and Node projects out of reach', async () => {
    createProject(env.app, { name: 'react-app', template: 'vite-react' });
    createProject(env.app, { name: 'node-app', template: 'node-http' });
    for (const p of ['react-app', 'node-app']) {
      expect((await run('draft', 'write_file', { project: p, path: 'x.js', content: 'x' })).error.code, p).toBe('not_allowed');
      expect((await run('live', 'deploy', { project: p, host: 'h' })).error.code, p).toBe('not_allowed');
    }
  });

  it('publishes only after the two-step confirmation for exactly those arguments', async () => {
    const args = { project: 'ai-site', host: 'h', folder: 'ai-site', note: 'first' };
    const first = await run('live', 'deploy', args);
    expect(first.needs_confirmation).toBe(true);
    expect(first.preview).toMatchObject({ project: 'ai-site', to_host: 'h' });
    expect(deployed).toBe(0);
    expect(agentCalls.some((c) => c.op === 'sites.create')).toBe(false);
    // different arguments, another connection or another action: the token does not carry over
    expect((await run('live', 'deploy', { ...args, folder: 'elsewhere' }, first.confirm_token)).error.code).toBe('bad_confirm_token');
    expect((await run('live', 'rollback', { host: 'h', site: 'ai-site' }, first.confirm_token)).error.code).toBe('bad_confirm_token');
    const other = await callTool(env.app, { ...who('live'), id: 'someone-else' }, 'studio', { action: 'deploy', args, confirm_token: first.confirm_token });
    expect(JSON.parse(other.content[0].text).error.code).toBe('bad_confirm_token');
    expect(deployed).toBe(0);

    const done = await run('live', 'deploy', args, first.confirm_token);
    expect(done.ok).toBe(true);
    expect(done.release).toBe('rel1');
    expect(done.undo).toContain('studio.rollback');
    expect(deployed).toBe(1);
  });

  it('rolls back with confirmation and records everything in the activity log', async () => {
    const args = { host: 'h', site: 'ai-site' };
    const first = await run('live', 'rollback', args);
    expect(first.needs_confirmation).toBe(true);
    expect(first.preview).toMatchObject({ live_now: 'r2' });
    expect(agentCalls.some((c) => c.op === 'rollback')).toBe(false);
    const done = await run('live', 'rollback', args, first.confirm_token);
    expect(done).toMatchObject({ ok: true, current: 'r1' });
    const log = env.app.store.activity({ limit: 50 }).filter((r) => r.tool === 'studio');
    expect(log.map((r) => `${r.action}:${r.status}`)).toEqual(expect.arrayContaining(['create_project:ok', 'write_file:ok', 'deploy:pending', 'deploy:ok', 'rollback:ok']));
  });

  it('lists hosts without any secret', async () => {
    const r = await run('read', 'hosts');
    expect(r.hosts).toEqual([{ name: 'h', url: 'https://h.test/wpm-agent/', status: 'ok', agent: '2.0.0', php: '8.3.0' }]);
    expect(JSON.stringify(r)).not.toMatch(/secret|key_id/i);
  });
});
