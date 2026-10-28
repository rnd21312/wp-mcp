import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, type Env } from './helpers.ts';

describe('panel URL inspector (crawler-style fetch)', () => {
  let env: Env;
  let origin = '';
  const target = http.createServer((req, res) => {
    if (req.url === '/old') {
      res.writeHead(301, { location: '/new' });
      return void res.end();
    }
    if (req.url === '/new') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' });
      return void res.end('<html><head><title>Hi</title></head><body><h1>سلام</h1></body></html>');
    }
    if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' });
      return void res.end();
    }
    res.writeHead(req.method === 'HEAD' ? 405 : 404);
    res.end();
  });
  beforeAll(async () => {
    await new Promise<void>((done) => target.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    env = await createEnv(['alpha'], { localPanel: true }, { owner: false });
  });
  afterAll(async () => {
    await env.stop();
    await new Promise<void>((done) => target.close(() => done()));
  });

  const post = async (path: string, body: unknown) => (await (await fetch(`${env.base}/admin/api/${path}`, { method: 'POST', headers: { 'x-wpm-panel': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as any;

  it('follows redirects by hand and reports the chain, headers and html', async () => {
    const r = await post('inspect/fetch', { url: `${origin}/old` });
    expect(r.ok).toBe(true);
    expect(r.chain.map((c: any) => c.status)).toEqual([301, 200]);
    expect(r.final.url).toBe(`${origin}/new`);
    expect(r.final.headers['x-robots-tag']).toBe('noindex');
    expect(r.final.html).toContain('<h1>سلام</h1>');
  });

  it('stops redirect loops', async () => {
    const r = await post('inspect/fetch', { url: `${origin}/loop` });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('too_many_redirects');
  });

  it('checks links, falling back to GET when HEAD is refused', async () => {
    const r = await post('inspect/links', { urls: [`${origin}/new`, `${origin}/missing`] });
    expect(r.statuses[`${origin}/new`]).toBe(200);
    expect(r.statuses[`${origin}/missing`]).toBe(404);
  });

  it('refuses private addresses when private sites are not allowed', async () => {
    const strict = await createEnv([], { localPanel: true, allowPrivateSites: false }, { owner: false });
    const res = await fetch(`${strict.base}/admin/api/inspect/fetch`, { method: 'POST', headers: { 'x-wpm-panel': '1', 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }) });
    const r = (await res.json()) as any;
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('blocked');
    await strict.stop();
  });
});
