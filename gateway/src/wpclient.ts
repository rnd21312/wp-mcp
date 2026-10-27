import { randomBytes } from 'node:crypto';
import type { Config } from './config.ts';
import { decrypt, hmacHex, safeEqual, sha256 } from './crypto.ts';
import type { Level } from './levels.ts';
import { safeRequest, SsrfError } from './ssrf.ts';
import type { SiteRow } from './store.ts';

export class SiteError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
    public retryable = false,
    public data?: unknown,
  ) {
    super(message);
  }
}

export interface CallContext {
  level: Level;
  actor: string;
  client: string;
  requestId: string;
  idempotencyKey?: string;
  dryRun?: boolean;
  write: boolean;
}

export interface CallResult {
  data: unknown;
  revision: number;
  replayed: boolean;
  summary: string;
}

export const ROUTE_CALL = '/wp-mcp/v1/call';
export const ROUTE_PAIR = '/wp-mcp/v1/pair';

export const normalizeSiteUrl = (raw: string): string => {
  const url = new URL(raw.trim());
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/wp-json.*$/, '').replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
};

/** Request signature; the bridge computes the same value (see Signature.php). */
export const signRequest = (secret: string, keyId: string, ts: number | string, nonce: string, body: string): string => hmacHex(secret, [ts, nonce, keyId, 'POST', ROUTE_CALL, sha256(body)].join('\n'));

/** Signature the bridge puts on every reply. */
export const responseSignature = (secret: string, nonce: string, body: Buffer | string): string => hmacHex(secret, `${nonce}\n${sha256(body)}`);

const endpoint = (base: string, route: string): string => `${base}/?rest_route=${route}`;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const SLOW_OPS = /^(maintain\.(update|backup|db_|search_replace)|plugins\.install|design\.theme_install|media\.import_url)/;

export interface PairResult {
  key_id: string;
  secret: string;
  site_title: string;
  wp_version: string;
  plugin_version: string;
  ceiling: Level;
  site_url: string;
}

export class SiteClient {
  constructor(
    private config: Config,
    private retryDelayMs = 400,
  ) {}

  private policy() {
    return { allowPrivate: this.config.allowPrivateSites, allowHttp: this.config.allowInsecureSites };
  }

  /** Exchanges a one-time pairing code (made in the WordPress admin) for a signing secret. */
  async pair(rawUrl: string, code: string, gatewayName: string): Promise<PairResult> {
    const base = normalizeSiteUrl(rawUrl);
    const body = JSON.stringify({ code: code.trim(), gateway: gatewayName });
    let res;
    try {
      res = await safeRequest(endpoint(base, ROUTE_PAIR), this.policy(), { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, body, timeoutMs: 20000, maxBytes: 200000 });
    } catch (error) {
      throw this.transportError(error);
    }
    const json = this.parse(res.body);
    if (res.status === 404) throw new SiteError('plugin_missing', 'WP MCP Bridge was not found on that URL. Install and activate the plugin, and make sure the REST API is reachable.', 404);
    if (res.status >= 300 || !json || (json as { ok?: boolean }).ok !== true) {
      const message = (json as { error?: { message?: string } } | null)?.error?.message ?? `Pairing failed (HTTP ${res.status}).`;
      throw new SiteError('pair_failed', message, res.status);
    }
    return (json as { data: PairResult }).data;
  }

  async call(site: SiteRow, op: string, args: Record<string, unknown>, ctx: CallContext): Promise<CallResult> {
    const secret = decrypt(this.config.masterKey, site.secret_enc);
    const retriable = !ctx.write || !!ctx.idempotencyKey;
    const attempts = retriable ? 3 : 1;
    let last: SiteError | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(this.retryDelayMs * 2 ** (attempt - 1) * (0.75 + Math.random() / 2));
      try {
        return await this.once(site, secret, op, args, ctx);
      } catch (error) {
        const err = error instanceof SiteError ? error : this.transportError(error);
        if (!err.retryable) throw err;
        last = err;
      }
    }
    throw last ?? new SiteError('unreachable', 'Site did not answer.');
  }

  private async once(site: SiteRow, secret: string, op: string, args: Record<string, unknown>, ctx: CallContext): Promise<CallResult> {
    const body = JSON.stringify({ op, args, level: ctx.level, actor: ctx.actor, client: ctx.client, request_id: ctx.requestId, idempotency_key: ctx.idempotencyKey ?? '', dry_run: !!ctx.dryRun });
    const ts = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(16).toString('hex');
    const signature = hmacHex(secret, [ts, nonce, site.key_id, 'POST', ROUTE_CALL, sha256(body)].join('\n'));
    let res;
    try {
      res = await safeRequest(endpoint(site.url, ROUTE_CALL), this.policy(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'x-wpm-key': site.key_id, 'x-wpm-time': String(ts), 'x-wpm-nonce': nonce, 'x-wpm-signature': signature, 'user-agent': 'wp-mcp-gateway/0.1' },
        body,
        timeoutMs: SLOW_OPS.test(op) ? 180000 : 30000,
        maxBytes: 24 * 1024 * 1024,
      });
    } catch (error) {
      throw this.transportError(error);
    }

    if ([502, 503, 504, 429].includes(res.status)) throw new SiteError('site_busy', `Site answered HTTP ${res.status}.`, res.status, true);
    if (res.status >= 300 && res.status < 400) throw new SiteError('redirect', 'The site redirected the API call (not followed). Check the site URL (http vs https, www).', res.status);

    const claimed = String(res.headers['x-wpm-signature'] ?? '');
    const json = this.parse(res.body) as { ok?: boolean; data?: unknown; revision?: number; replayed?: boolean; summary?: string; error?: { code?: string; message?: string; data?: unknown } } | null;
    if (res.status === 404 && !json?.error) throw new SiteError('plugin_missing', 'WP MCP Bridge is not reachable on this site (plugin deactivated, or REST API blocked).', 404);
    if (json === null) throw new SiteError('bad_response', `Site returned something that is not JSON (HTTP ${res.status}).`, res.status);

    const expected = hmacHex(secret, `${nonce}\n${sha256(res.body)}`);
    if (!claimed || !safeEqual(claimed, expected)) {
      if (json.error?.code === 'bad_signature' || json.error?.code === 'unknown_key') throw new SiteError('site_auth', `${json.error.message ?? 'The site rejected the signature.'} Re-pair the site if its secret was reset.`, res.status);
      throw new SiteError('bad_response_signature', 'The reply did not carry a valid signature from the bridge. Refusing to use it.', res.status);
    }
    if (json.ok !== true) {
      const code = json.error?.code ?? 'error';
      throw new SiteError(code, json.error?.message ?? 'Site error.', res.status, code === 'busy', json.error?.data);
    }

    return { data: json.data ?? null, revision: json.revision ?? 0, replayed: !!json.replayed, summary: json.summary ?? '' };
  }

  private parse(buf: Buffer): unknown {
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      return null;
    }
  }

  private transportError(error: unknown): SiteError {
    if (error instanceof SiteError) return error;
    if (error instanceof SsrfError) return new SiteError('blocked', error.message);
    const e = error as NodeJS.ErrnoException;
    if (e.code === 'ESSRF') return new SiteError('blocked', 'The site resolves to a private or reserved address, which is not allowed.');
    if (e.code === 'ETIMEDOUT') return new SiteError('timeout', 'The site did not answer in time.', 0, true);
    return new SiteError('unreachable', `Cannot reach the site (${e.code ?? e.message}).`, 0, true);
  }
}
