import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentClient } from '../src/agentclient.ts';
import { assembleNextStandalone } from '../src/build.ts';
import { encrypt } from '../src/crypto.ts';
import { createProject, deployProject, projectDir } from '../src/projects.ts';
import { zipDirectory } from '../src/zip.ts';
import { createEnv, type Env } from './helpers.ts';

const names = (zip: Buffer): string[] => {
  const out: string[] = [];
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const nlen = zip.readUInt16LE(p + 28);
    out.push(zip.subarray(p + 46, p + 46 + nlen).toString());
    p += 46 + nlen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return out;
};

describe('node zips keep what a Node app needs', () => {
  it('includes node_modules and .next/static, but never secrets or .git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpm-nz-'));
    for (const d of ['node_modules/dep', '.next/static/chunks', '.git']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'server.js'), 'x');
    writeFileSync(join(dir, 'node_modules/dep/index.js'), 'x');
    writeFileSync(join(dir, '.next/static/chunks/a.js'), 'x');
    writeFileSync(join(dir, '.git/config'), 'x');
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    const node = names(zipDirectory(dir, undefined, { node: true }).buffer).sort();
    expect(node).toEqual(['.next/static/chunks/a.js', 'node_modules/dep/index.js', 'server.js']);
    expect(names(zipDirectory(dir).buffer)).toEqual(['server.js']);
  });
});

describe('Next standalone assembly', () => {
  it('puts static files and public beside server.js', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpm-ns-'));
    mkdirSync(join(dir, '.next/standalone/node_modules/next'), { recursive: true });
    mkdirSync(join(dir, '.next/static/css'), { recursive: true });
    mkdirSync(join(dir, 'public'));
    writeFileSync(join(dir, '.next/standalone/server.js'), 's');
    writeFileSync(join(dir, '.next/standalone/node_modules/next/p.json'), '{}');
    writeFileSync(join(dir, '.next/static/css/a.css'), 'c');
    writeFileSync(join(dir, 'public/logo.svg'), '<svg/>');
    assembleNextStandalone(dir);
    for (const f of ['server.js', 'node_modules/next/p.json', '.next/static/css/a.css', 'public/logo.svg']) expect(existsSync(join(dir, '.wpm-deploy', f)), f).toBe(true);
    assembleNextStandalone(dir); // idempotent
  });

  it('finds server.js when Next nested the output under the workspace path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpm-ns-'));
    const nested = join(dir, '.next/standalone/Users/me/work/site');
    mkdirSync(join(nested, '.next'), { recursive: true });
    mkdirSync(join(dir, '.next/standalone/node_modules/next'), { recursive: true });
    mkdirSync(join(dir, '.next/static'), { recursive: true });
    writeFileSync(join(nested, 'server.js'), 'nested');
    writeFileSync(join(dir, '.next/static/a.js'), 'a');
    assembleNextStandalone(dir);
    expect(readFileSync(join(dir, '.wpm-deploy/server.js'), 'utf8')).toBe('nested');
    expect(existsSync(join(dir, '.wpm-deploy/.next/static/a.js'))).toBe(true);
  });

  it('explains a missing standalone output', () => {
    expect(() => assembleNextStandalone(mkdtempSync(join(tmpdir(), 'wpm-ns-')))).toThrow(/output: "standalone"/);
  });
});

describe('deploying a Node project', () => {
  let env: Env;
  let app: http.Server;
  let hits = 0;
  const calls: { op: string; args: Record<string, any> }[] = [];
  let deployedZip = Buffer.alloc(0);

  beforeAll(async () => {
    env = await createEnv([], { dataDir: mkdtempSync(join(tmpdir(), 'wpm-nd-')) }, { owner: false });
    app = http.createServer((_req, res) => {
      hits++;
      res.writeHead(hits < 2 ? 502 : 200).end('ok'); // the app needs a moment to restart
    });
    await new Promise<void>((done) => app.listen(0, '127.0.0.1', done));
    env.app.agents = {
      call: async (_h: unknown, op: string, args: Record<string, any> = {}) => {
        calls.push({ op, args });
        if (op === 'roots.add') return { root: args.path };
        if (op === 'sites.create') return { site: { id: args.name } };
        return {};
      },
      deploy: async (_h: unknown, _site: string, zip: Buffer) => {
        deployedZip = zip;
        return { id: 'r1', previous: null, mode: 'sync', created: 0, files: 0, bytes: 0, sha256: '', note: '', by: '' };
      },
    } as unknown as AgentClient;
    env.app.store.addHost({ name: 'h', url: 'https://h.test/wpm-agent/', key_id: 'k', secret_enc: encrypt(env.config.masterKey, 'x'), level: 'admin' });
    env.app.store.hostHealth('h', true);
  });
  afterAll(async () => {
    await new Promise<void>((done) => app.close(() => done()));
    await env.stop();
  });

  it('creates the site with its app root, sets env, ships dependencies and checks the address', async () => {
    createProject(env.app, { name: 'api', template: 'node-http', title: 'API' });
    const dir = projectDir(env.app, 'api');
    mkdirSync(join(dir, 'node_modules/dep'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/dep/index.js'), 'x');
    const port = (app.address() as AddressInfo).port;
    const done = await deployProject(env.app, { project: 'api', host: 'h', note: 'n', node: { appRoot: '/home/u/nodeapps', docroot: 'api-public', port: 24100, env: { DATABASE_URL: 'mysql://x' }, checkUrl: `http://127.0.0.1:${port}/` } });
    expect(calls.map((c) => c.op)).toEqual(['roots.add', 'sites.create', 'sites.env']);
    expect(calls[0].args.path).toBe('/home/u/nodeapps');
    expect(calls[1].args).toMatchObject({ kind: 'node', root: '/home/u/nodeapps', startup: 'server.js', docroot: 'api-public', port: 24100 });
    expect(calls[2].args.env).toEqual({ DATABASE_URL: 'mysql://x' });
    expect(names(deployedZip)).toEqual(expect.arrayContaining(['server.js', 'package.json', 'node_modules/dep/index.js']));
    expect(done.check?.status).toBe(200);
    expect(hits).toBeGreaterThanOrEqual(2);
  }, 30000);

  it('asks for the startup file instead of publishing an empty app', async () => {
    createProject(env.app, { name: 'empty-node', template: 'next-ssr' });
    await expect(deployProject(env.app, { project: 'empty-node', host: 'h', node: {} })).rejects.toMatchObject({ code: 'no_startup' });
  });

  it('keeps cpSync available for tests', () => {
    expect(typeof cpSync).toBe('function');
    expect(readFileSync).toBeTruthy();
  });
});
