import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentError, type AgentClient } from '../src/agentclient.ts';
import { encrypt } from '../src/crypto.ts';
import { buildBridgeZip, createWordPress, deriveSiteUrl, timing } from '../src/wordpress.ts';
import { createEnv, FakeSite, type Env } from './helpers.ts';

timing.retryMs = 1;

describe('deriveSiteUrl', () => {
  it('maps the agent address to the web root and adds the folder', () => {
    expect(deriveSiteUrl('https://example.com/wpm-agent/', '/wpm-agent', 'blog')).toBe('https://example.com/blog/');
    expect(deriveSiteUrl('https://example.com/tools/wpm-agent/', '/tools/wpm-agent', '')).toBe('https://example.com/');
    expect(deriveSiteUrl('https://example.com/a/b/', '', 'x')).toBe('https://example.com/a/x/');
    expect(deriveSiteUrl('https://example.com:8443/wpm-agent/', '/wpm-agent', '/shop/')).toBe('https://example.com:8443/shop/');
  });
});

describe('bridge zip', () => {
  it('contains the plugin under its own folder', () => {
    const zip = buildBridgeZip();
    expect(zip.includes(Buffer.from('wp-mcp-bridge/wp-mcp-bridge.php'))).toBe(true);
    expect(zip.includes(Buffer.from('wp-mcp-bridge/includes/Signature.php'))).toBe(true);
  });
});

/** The Studio's WordPress flow against stand-ins: a scripted agent, and a "WordPress" that serves the installer and proxies the rest to a fake bridge. */
describe('createWordPress', () => {
  let env: Env;
  let fake: FakeSite;
  let wp: http.Server;
  let installs: string[] = [];
  let installStatus = 200;
  const calls: { op: string; args: Record<string, any> }[] = [];
  let failInstall = false;

  beforeAll(async () => {
    env = await createEnv([]);
    fake = await new FakeSite('New Blog').start();
    wp = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (req.url?.includes('/wp-admin/install.php')) {
          installs.push(body.toString());
          res.writeHead(installStatus, { 'content-type': 'text/html' });
          return void res.end(installStatus === 200 ? '<h1>Success!</h1>' : 'error');
        }
        const query = (req.url ?? '').split('?')[1] ?? '';
        const proxy = http.request(`${fake.url}/?${query}`, { method: req.method, headers: req.headers }, (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        });
        proxy.end(body);
      });
    });
    await new Promise<void>((done) => wp.listen(0, '127.0.0.1', done));
    const port = (wp.address() as AddressInfo).port;

    env.app.agents = {
      call: async (_host: unknown, op: string, args: Record<string, any> = {}) => {
        calls.push({ op, args });
        if (op === 'sites.create') return { site: { id: args.name } };
        if (op === 'wp.install') {
          if (failInstall) throw new AgentError('db_connect', 'Cannot connect to the database');
          return { wp_version: '6.9.1', db: { name: 'x' } };
        }
        if (op === 'wp.finish') return { pairing_code: fake.code };
        return {};
      },
      upload: async () => 'upload-bridge-1',
    } as unknown as AgentClient;
    env.app.store.addHost({ name: 'h1', url: `http://127.0.0.1:${port}/wpm-agent/`, key_id: 'k1', secret_enc: encrypt(env.config.masterKey, 'x'), level: 'admin' });
    env.app.store.hostHealth('h1', true, '', { version: '2.0.0', caps: { script_dir: '/wpm-agent' } });
  });

  afterAll(async () => {
    await new Promise<void>((done) => wp.close(() => done()));
    await fake.stop();
    await env.stop();
  });

  const base = { host: 'h1', name: 'blog', title: 'My Blog', adminEmail: 'me@example.com', db: { method: 'cpanel' as const, url: 'https://panel:2083', user: 'u', token: 't' } };

  it('creates the site, installs through the web installer, activates the bridge and pairs', async () => {
    const r = await createWordPress(env.app, base);
    expect(calls.map((c) => c.op)).toEqual(['sites.create', 'wp.install', 'wp.finish']);
    expect(calls[0].args).toMatchObject({ kind: 'wordpress', folder: 'blog' });
    expect(calls[1].args.bridge_upload).toBe('upload-bridge-1');
    expect(calls[1].args.db).toMatchObject({ method: 'cpanel', user: 'u' });
    const form = new URLSearchParams(installs[0]);
    expect(form.get('weblog_title')).toBe('My Blog');
    expect(form.get('admin_email')).toBe('me@example.com');
    expect(form.get('admin_password')).toBe(r.admin_password);
    expect(form.get('user_name')).toBe(r.admin_user);
    expect(r.admin_password.length).toBeGreaterThanOrEqual(12);
    expect(calls[2].args.admin_user).toBe(r.admin_user);
    const site = env.app.store.site('blog')!;
    expect(site.status).toBe('ok');
    expect(site.title).toBe('New Blog');
    expect(JSON.stringify(env.app.store.sites())).not.toContain(r.admin_password);
  });

  it('removes the half-made site slot when the database or files fail', async () => {
    calls.length = 0;
    installs = [];
    failInstall = true;
    await expect(createWordPress(env.app, { ...base, name: 'second', folder: 'second' })).rejects.toThrow(/database/);
    failInstall = false;
    expect(calls.map((c) => c.op)).toEqual(['sites.create', 'wp.install', 'sites.delete']);
    expect(installs).toHaveLength(0);
    expect(env.app.store.site('second')).toBeUndefined();
  });

  it('keeps the files and says what to do when the installer never answers', async () => {
    calls.length = 0;
    installStatus = 500;
    await expect(createWordPress(env.app, { ...base, name: 'third', folder: 'third' })).rejects.toMatchObject({ code: 'wp_install_failed' });
    installStatus = 200;
    expect(calls.map((c) => c.op)).not.toContain('sites.delete');
    expect(calls.map((c) => c.op)).not.toContain('wp.finish');
  });

  it('validates input before touching the host', async () => {
    calls.length = 0;
    await expect(createWordPress(env.app, { ...base, name: 'Bad Name!' })).rejects.toMatchObject({ code: 'bad_name' });
    await expect(createWordPress(env.app, { ...base, name: 'okname', adminEmail: 'nope' })).rejects.toMatchObject({ code: 'bad_email' });
    await expect(createWordPress(env.app, { ...base, name: 'okname', adminPassword: 'short' })).rejects.toMatchObject({ code: 'weak_password' });
    await expect(createWordPress(env.app, { ...base, name: 'okname', adminUser: 'a b' })).rejects.toMatchObject({ code: 'bad_admin' });
    await expect(createWordPress(env.app, { ...base, name: 'blog' })).rejects.toMatchObject({ code: 'name_taken' });
    expect(calls).toHaveLength(0);
  });
});
