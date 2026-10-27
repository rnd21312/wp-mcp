import { createHash, createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApiKey } from '../src/auth.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { createApp, type App } from '../src/context.ts';
import { hashPassword } from '../src/crypto.ts';
import { createHandler } from '../src/http.ts';
import type { Level } from '../src/levels.ts';
import { OPS } from '../src/registry.ts';
import { addSite } from '../src/siteadmin.ts';
import { Store } from '../src/store.ts';
import { SiteClient } from '../src/wpclient.ts';

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const hmac = (key: string, data: string): string => createHmac('sha256', key).update(data).digest('hex');

export interface Call {
  op: string;
  args: Record<string, unknown>;
  level: string;
  actor: string;
  client: string;
  dry_run: boolean;
  idempotency_key: string;
}

/** A stand-in for a WordPress site running the bridge: same signing rules, scripted answers. */
export class FakeSite {
  server = http.createServer((req, res) => void this.handle(req, res));
  url = '';
  keyId: string;
  secret = randomBytes(32).toString('hex');
  code = 'WPMP-AAAA-BBBB-CCCC-DDDD';
  title: string;
  ceiling: Level = 'admin';
  calls: Call[] = [];
  /** op id → answer */
  answers: Record<string, (args: Record<string, unknown>, call: Call) => unknown> = {};
  failNext = 0;
  tamperResponses = false;
  private nonces = new Set<string>();
  private idem = new Map<string, unknown>();

  constructor(title = 'Fake Site') {
    this.title = title;
    this.keyId = 'k' + randomBytes(5).toString('hex');
  }

  async start(): Promise<this> {
    await new Promise<void>((done) => this.server.listen(0, '127.0.0.1', done));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }

  /** Writes that reached the "database" (excluding previews). */
  executed(op?: string): Call[] {
    return this.calls.filter((c) => !c.dry_run && (!op || c.op === op));
  }

  private reply(res: http.ServerResponse, status: number, payload: unknown, nonce?: string): void {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (nonce) headers['x-wpm-signature'] = this.tamperResponses ? 'f'.repeat(64) : hmac(this.secret, `${nonce}\n${sha(body)}`);
    res.writeHead(status, headers);
    res.end(body);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const route = new URL(req.url ?? '/', this.url).searchParams.get('rest_route');

    if (route === '/wp-mcp/v1/pair') {
      const body = JSON.parse(raw) as { code: string };
      if (body.code !== this.code) return this.reply(res, 403, { ok: false, error: { code: 'bad_code', message: 'That pairing code is wrong.' } });
      this.code = '';
      return this.reply(res, 200, { ok: true, data: { key_id: this.keyId, secret: this.secret, site_title: this.title, wp_version: '6.8', plugin_version: '0.1.0', ceiling: this.ceiling, site_url: this.url } });
    }
    if (route !== '/wp-mcp/v1/call') return this.reply(res, 404, { code: 'rest_no_route' });

    const h = req.headers;
    const nonce = String(h['x-wpm-nonce']);
    const expected = hmac(this.secret, [h['x-wpm-time'], nonce, h['x-wpm-key'], 'POST', '/wp-mcp/v1/call', sha(raw)].join('\n'));
    if (h['x-wpm-key'] !== this.keyId || h['x-wpm-signature'] !== expected) return this.reply(res, 401, { ok: false, error: { code: 'bad_signature', message: 'Request signature rejected.' } }, nonce);
    if (Math.abs(Date.now() / 1000 - Number(h['x-wpm-time'])) > 300) return this.reply(res, 401, { ok: false, error: { code: 'stale_request', message: 'stale' } }, nonce);
    if (this.nonces.has(nonce)) return this.reply(res, 401, { ok: false, error: { code: 'replayed', message: 'replayed' } }, nonce);
    this.nonces.add(nonce);

    if (this.failNext > 0) {
      this.failNext--;
      res.writeHead(503);
      return void res.end('busy');
    }

    const body = JSON.parse(raw) as { op: string; args: Record<string, unknown>; level: string; actor: string; client: string; dry_run: boolean; idempotency_key: string };
    const call: Call = { op: body.op, args: body.args, level: body.level, actor: body.actor, client: body.client, dry_run: !!body.dry_run, idempotency_key: body.idempotency_key };
    this.calls.push(call);

    const spec = OPS[body.op];
    if (!spec) return this.reply(res, 404, { ok: false, error: { code: 'unknown_op', message: 'unknown' } }, nonce);
    const cacheKey = spec.write && !body.dry_run && body.idempotency_key ? `${body.op}|${body.idempotency_key}` : '';
    if (cacheKey && this.idem.has(cacheKey)) return this.reply(res, 200, { ok: true, data: this.idem.get(cacheKey), replayed: true, revision: 0 }, nonce);

    const answer = this.answers[body.op];
    let data: unknown;
    try {
      data = answer ? answer(body.args, call) : { echo: body.op, args: body.args, dry_run: !!body.dry_run };
    } catch (error) {
      return this.reply(res, 400, { ok: false, error: { code: 'handler_error', message: (error as Error).message } }, nonce);
    }
    if (cacheKey) this.idem.set(cacheKey, data);
    return this.reply(res, 200, { ok: true, data, revision: spec.write && !body.dry_run ? this.executed().length : 0 }, nonce);
  }
}

export interface Env {
  app: App;
  config: Config;
  base: string;
  server: http.Server;
  sites: Record<string, FakeSite>;
  stop(): Promise<void>;
}

export const OWNER_PASSWORD = 'correct horse battery staple';

/** A gateway on a random port with the given fake sites already connected. */
export async function createEnv(siteNames: string[] = ['alpha'], overrides: Partial<Config> = {}, opts: { owner?: boolean } = {}): Promise<Env> {
  const server = http.createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  const config = loadConfig({}, { port, publicUrl: `http://127.0.0.1:${port}`, dataDir: process.env.TEMP ?? '.', masterKey: randomBytes(32), allowPrivateSites: true, allowInsecureSites: true, ...overrides });
  const store = new Store(':memory:');
  if (opts.owner !== false) store.setOwnerHash(hashPassword(OWNER_PASSWORD));
  const app = createApp(config, store, { sites: new SiteClient(config, 1) });
  server.on('request', createHandler(app));

  const sites: Record<string, FakeSite> = {};
  for (const name of siteNames) {
    const fake = await new FakeSite(`Title of ${name}`).start();
    await addSite(app, { url: fake.url, code: fake.code, name });
    sites[name] = fake;
  }

  return {
    app,
    config,
    base: config.publicUrl,
    server,
    sites,
    async stop() {
      await Promise.all(Object.values(sites).map((s) => s.stop()));
      await new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      });
      store.close();
    },
  };
}

/** API key for a level (and optionally a subset of sites). */
export function key(env: Env, level: Level, sites: '*' | string[] = '*'): string {
  return createApiKey(env.app, { name: `test-${level}`, level, sites }).token;
}

let rpcId = 0;

/** One JSON-RPC call to /mcp. */
export async function rpc(env: Env, bearer: string, method: string, params: Record<string, unknown> = {}): Promise<{ status: number; headers: Headers; body: any }> {
  const res = await fetch(`${env.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

/** Calls a tool and returns the parsed JSON text content. */
export async function tool(env: Env, bearer: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
  const { body } = await rpc(env, bearer, 'tools/call', { name, arguments: args });
  const text = body.result.content[0].text as string;
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { isError: !!body.result.isError, data };
}
