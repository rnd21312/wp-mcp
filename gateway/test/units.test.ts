import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { canonical, decrypt, encrypt, hashPassword, seal, unseal, verifyPassword } from '../src/crypto.ts';
import { atLeast, minLevel } from '../src/levels.ts';
import { RateLimiter } from '../src/ratelimit.ts';
import { checkArgs, OPS, TOOLS, opsOf, parseParam } from '../src/registry.ts';
import { assertUrlShape, isPrivateAddress, safeRequest, SsrfError } from '../src/ssrf.ts';
import { normalizeSiteUrl } from '../src/wpclient.ts';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { redirectRegistered, redirectUriOk } from '../src/oauth.ts';

describe('crypto', () => {
  const key = randomBytes(32);
  it('encrypts and decrypts, and rejects tampering', () => {
    const packed = encrypt(key, 'site secret');
    expect(decrypt(key, packed)).toBe('site secret');
    const bad = Buffer.from(packed, 'base64url');
    bad[bad.length - 1] ^= 1;
    expect(() => decrypt(key, bad.toString('base64url'))).toThrow();
    expect(() => decrypt(randomBytes(32), packed)).toThrow();
  });
  it('seals values with expiry and detects forgery', () => {
    const ok = seal(key, { a: 1, exp: Math.floor(Date.now() / 1000) + 60 });
    expect(unseal(key, ok)).toMatchObject({ a: 1 });
    expect(unseal(key, seal(key, { a: 1, exp: 1 }))).toBeNull();
    expect(unseal(randomBytes(32), ok)).toBeNull();
    expect(unseal(key, ok.replace(/^./, 'x'))).toBeNull();
  });
  it('hashes passwords', () => {
    const stored = hashPassword('a long enough password');
    expect(verifyPassword('a long enough password', stored)).toBe(true);
    expect(verifyPassword('another password!!', stored)).toBe(false);
  });
  it('canonical JSON ignores key order', () => {
    expect(canonical({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
});

describe('levels', () => {
  it('orders read < draft < live < admin', () => {
    expect(atLeast('live', 'draft')).toBe(true);
    expect(atLeast('draft', 'live')).toBe(false);
    expect(minLevel('admin', 'draft')).toBe('draft');
  });
});

describe('rate limiter', () => {
  it('refills over time and isolates keys', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    expect(limiter.take('a', 2, 60).ok).toBe(true);
    expect(limiter.take('a', 2, 60).ok).toBe(true);
    const blocked = limiter.take('a', 2, 60);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(limiter.take('b', 2, 60).ok).toBe(true);
    now += 1500;
    expect(limiter.take('a', 2, 60).ok).toBe(true);
  });
});

describe('SSRF guard', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1'])('treats %s as private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'])('treats %s as public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
  const strict = { allowPrivate: false, allowHttp: false };
  it('rejects bad shapes', () => {
    for (const url of ['http://example.com', 'https://user:pw@example.com', 'https://localhost/', 'https://127.0.0.1/', 'https://[::1]/', 'https://metadata.internal/', 'ftp://example.com', 'not a url', 'https://printer.local/']) {
      expect(() => assertUrlShape(url, strict), url).toThrow(SsrfError);
    }
    expect(() => assertUrlShape('https://example.com/x', strict)).not.toThrow();
  });
  it('blocks a host that resolves to a private address at connect time', async () => {
    // "localhost" passes no shape check when private is allowed in shape but not in lookup: simulate with allowPrivate false via IP-less name.
    await expect(safeRequest('https://localtest.me/', strict, { timeoutMs: 3000 })).rejects.toThrow();
  });
  it('never follows redirects', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as AddressInfo).port;
    const res = await safeRequest(`http://127.0.0.1:${port}/`, { allowPrivate: true, allowHttp: true });
    expect(res.status).toBe(302);
    await new Promise<void>((done) => server.close(() => done()));
  });
  it('caps response size', async () => {
    const server = createServer((_req, res) => res.end('x'.repeat(5000)));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as AddressInfo).port;
    await expect(safeRequest(`http://127.0.0.1:${port}/`, { allowPrivate: true, allowHttp: true }, { maxBytes: 1000 })).rejects.toThrow();
    await new Promise<void>((done) => server.close(() => done()));
  });
  it('normalizes site URLs', () => {
    expect(normalizeSiteUrl('https://example.com/wp-json/wp/v2/?x=1#a')).toBe('https://example.com');
    expect(normalizeSiteUrl('https://example.com/blog/')).toBe('https://example.com/blog');
  });
});

describe('redirect URIs', () => {
  it('accepts https, loopback http and editor schemes only', () => {
    for (const ok of ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:3118/callback', 'http://127.0.0.1:9/cb', 'cursor://anysphere.cursor-retrieval/oauth', 'vscode://x/y']) expect(redirectUriOk(ok), ok).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'http://evil.example/cb', 'https://u:p@evil.example/', 'https://x.example/cb#frag', 'ftp://x/y', 'file:///etc/passwd', 'https://x.example/ cb']) expect(redirectUriOk(bad), bad).toBe(false);
  });
  it('matches loopback on any port but not other hosts', () => {
    expect(redirectRegistered('http://localhost:5555/cb', ['http://localhost:3000/cb'])).toBe(true);
    expect(redirectRegistered('http://localhost:5555/other', ['http://localhost:3000/cb'])).toBe(false);
    expect(redirectRegistered('https://a.example/cb', ['https://b.example/cb'])).toBe(false);
    expect(redirectRegistered('https://a.example/cb', ['https://a.example/cb'])).toBe(true);
  });
});

describe('operation spec', () => {
  it('is internally consistent', () => {
    const toolNames = new Set(TOOLS.map((t) => t.name));
    expect(Object.keys(OPS).length).toBeGreaterThan(100);
    const seen = new Set<string>();
    for (const op of Object.values(OPS)) {
      expect(seen.has(op.id)).toBe(false);
      seen.add(op.id);
      expect(['read', 'draft', 'live', 'admin']).toContain(op.level);
      expect(toolNames.has(op.tool), op.id).toBe(true);
      expect(op.id).toBe(`${op.tool}.${op.action}`);
      for (const name of op.required) expect(op.params[name], `${op.id}.${name}`).toBeDefined();
      for (const def of Object.values(op.params)) expect(['string', 'int', 'bool', 'object', 'array', 'any', 'enum']).toContain(parseParam(def).type);
      if (op.escalates) expect(['draft', 'live', 'admin']).toContain(op.escalates);
      expect(op.summary.length).toBeGreaterThan(10);
    }
    for (const tool of TOOLS) expect(opsOf(tool.name).length, tool.name).toBeGreaterThan(0);
  });
  it('permanent and code-running actions need confirmation and the right level', () => {
    for (const id of ['content.delete', 'plugins.delete', 'plugins.install_zip', 'media.import_url', 'design.theme_file_write', 'maintain.backup_restore', 'users.delete']) expect(OPS[id].confirm, id).toBeTruthy();
    expect(OPS['plugins.install_zip'].level).toBe('admin');
    expect(OPS['users.list'].level).toBe('admin');
    expect(OPS['shop.orders_list'].level).toBe('admin');
  });
  it('the plugin ships the same spec as the gateway', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const a = readFileSync(`${here}../src/generated/ops.json`, 'utf8');
    const b = readFileSync(`${here}../../plugin/wp-mcp-bridge/ops.json`, 'utf8');
    const c = readFileSync(`${here}../../spec/ops.json`, 'utf8');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
  it('validates and coerces arguments', () => {
    const op = OPS['content.list'];
    expect(checkArgs(op, { per_page: '5', status: 'draft' })).toEqual({ args: { per_page: 5, status: 'draft' }, errors: [] });
    expect(checkArgs(op, { nope: 1 }).errors[0]).toMatch(/Unknown argument "nope"/);
    expect(checkArgs(op, { order: 'sideways' }).errors[0]).toMatch(/one of: asc, desc/);
    expect(checkArgs(OPS['content.trash'], {}).errors[0]).toMatch(/Missing required argument "id"/);
    expect(checkArgs(OPS['content.bulk'], { ids: '1,2', status: 'draft' }).args.ids).toEqual(['1', '2']);
    expect(checkArgs(OPS['content.terms_list'], { hide_empty: 'true' }).args.hide_empty).toBe(true);
  });
});
