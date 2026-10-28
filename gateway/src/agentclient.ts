import { randomBytes } from 'node:crypto';
import type { Config } from './config.ts';
import { decrypt, hmacHex, safeEqual, sha256 } from './crypto.ts';
import { safeRequest, SsrfError } from './ssrf.ts';
import type { HostRow } from './store.ts';

export class AgentError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
    public retryable = false,
  ) {
    super(message);
  }
}

export const API = '/api/v1/';

/** Turns whatever the user pasted (folder URL, index.php URL, panel URL) into the agent's base folder URL with a trailing slash. */
export function normalizeAgentUrl(raw: string): string {
  const url = new URL(raw.trim());
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/index\.php$/i, '').replace(/\/+$/, '') + '/';

  return url.toString();
}

export const agentEndpoint = (base: string, route: string): string => `${base}index.php?r=${encodeURIComponent(route)}`;

/** Request signature; the agent computes the same value (Security::sign in PHP, same layout as the WordPress bridge). */
export const signAgentRequest = (secret: string, keyId: string, ts: number | string, nonce: string, route: string, body: string | Buffer): string => hmacHex(secret, [ts, nonce, keyId, 'POST', route, sha256(body)].join('\n'));

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export interface PairedAgent {
  key_id: string;
  secret: string;
  level: string;
  agent_version: string;
}

export interface Release {
  id: string;
  created: number;
  files: number;
  bytes: number;
  sha256: string;
  note: string;
  by: string;
}

export interface RemoteSite {
  id: string;
  name: string;
  kind: string;
  mode: string;
  folder: string;
  url: string;
  current: string | null;
  releases: number;
  created: number;
}

export class AgentClient {
  constructor(
    private config: Config,
    private retryDelayMs = 300,
  ) {}

  private policy() {
    return { allowPrivate: this.config.allowPrivateSites, allowHttp: this.config.allowInsecureSites };
  }

  /** Exchanges the one-time pairing code (made in the agent panel) for a signing secret. */
  async pair(rawUrl: string, code: string, name: string): Promise<{ base: string; paired: PairedAgent }> {
    const base = normalizeAgentUrl(rawUrl);
    const body = JSON.stringify({ code: code.trim(), name });
    let res;
    try {
      res = await safeRequest(agentEndpoint(base, `${API}pair`), this.policy(), { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, body, timeoutMs: 20000, maxBytes: 200000 });
    } catch (error) {
      throw this.transportError(error);
    }
    const json = this.parse(res.body) as { ok?: boolean; data?: PairedAgent; error?: { code?: string; message?: string } } | null;
    if (!json) throw new AgentError('not_an_agent', 'That address did not answer like a WPM Host Agent. Check the address (the folder where you uploaded the agent) and that index.php is reachable.', res.status);
    if (res.status >= 300 || json.ok !== true || !json.data) throw new AgentError(json.error?.code ?? 'pair_failed', json.error?.message ?? `Pairing failed (HTTP ${res.status}).`, res.status);

    return { base, paired: json.data };
  }

  /** One signed call. Safe (idempotent) calls are retried on network trouble. */
  async call<T = Record<string, unknown>>(host: HostRow, op: string, args: Record<string, unknown> = {}, opts: { retry?: boolean; timeoutMs?: number } = {}): Promise<T> {
    return this.signed<T>(host, `${API}${op}`, Buffer.from(JSON.stringify(args)), opts);
  }

  private async signed<T>(host: HostRow, route: string, body: Buffer, opts: { retry?: boolean; timeoutMs?: number; type?: string } = {}): Promise<T> {
    const secret = decrypt(this.config.masterKey, host.secret_enc);
    const attempts = opts.retry ? 3 : 1;
    let last: AgentError | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(this.retryDelayMs * 2 ** (attempt - 1));
      try {
        return await this.once<T>(host, secret, route, body, opts);
      } catch (error) {
        const err = error instanceof AgentError ? error : this.transportError(error);
        if (!err.retryable) throw err;
        last = err;
      }
    }
    throw last ?? new AgentError('unreachable', 'The host did not answer.');
  }

  private async once<T>(host: HostRow, secret: string, route: string, body: Buffer, opts: { timeoutMs?: number; type?: string }): Promise<T> {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(16).toString('hex');
    const signature = signAgentRequest(secret, host.key_id, ts, nonce, route, body);
    let res;
    try {
      res = await safeRequest(agentEndpoint(host.url, route), this.policy(), {
        method: 'POST',
        headers: { 'content-type': opts.type ?? 'application/json', 'content-length': String(body.length), 'x-wpm-key': host.key_id, 'x-wpm-time': String(ts), 'x-wpm-nonce': nonce, 'x-wpm-signature': signature, 'user-agent': 'wpm-studio/2.0' },
        body,
        timeoutMs: opts.timeoutMs ?? 60000,
        maxBytes: 8 * 1024 * 1024,
      });
    } catch (error) {
      throw this.transportError(error);
    }
    if ([502, 503, 504].includes(res.status) && !this.parse(res.body)) throw new AgentError('host_busy', `The host answered HTTP ${res.status}.`, res.status, true);
    if (res.status >= 300 && res.status < 400) throw new AgentError('redirect', 'The host redirected the API call (not followed). Check the address: http vs https, www, trailing folder.', res.status);

    const json = this.parse(res.body) as { ok?: boolean; data?: T; error?: { code?: string; message?: string; data?: unknown } } | null;
    if (!json) throw new AgentError('bad_response', `The host returned something that is not JSON (HTTP ${res.status}). Is the agent address right?`, res.status);

    const claimed = String(res.headers['x-wpm-signature'] ?? '');
    const expected = hmacHex(secret, `${nonce}\n${sha256(res.body)}`);
    if (json.ok !== true) {
      // Errors raised before the agent knew who we are cannot be signed; they still carry a useful code.
      const code = json.error?.code ?? 'error';
      const message = json.error?.message ?? 'Agent error.';
      if (claimed && !safeEqual(claimed, expected)) throw new AgentError('bad_response_signature', 'The reply did not carry a valid signature from the agent. Refusing to use it.', res.status);
      throw new AgentError(code, message, res.status);
    }
    if (!claimed || !safeEqual(claimed, expected)) throw new AgentError('bad_response_signature', 'The reply did not carry a valid signature from the agent. Refusing to use it.', res.status);

    return json.data as T;
  }

  /** Uploads a zip in chunks sized to the host's limits, verifies the checksum on the host, returns the upload id. */
  async upload(host: HostRow, zip: Buffer, onProgress?: (done: number, total: number) => void): Promise<string> {
    const begin = await this.call<{ upload_id: string; chunk_bytes: number }>(host, 'upload.begin', { size: zip.length, sha256: sha256(zip) }, { retry: true });
    const size = Math.max(65536, Math.min(begin.chunk_bytes, 8 * 1024 * 1024));
    const chunks = Math.ceil(zip.length / size);
    for (let i = 0; i < chunks; i++) {
      const part = zip.subarray(i * size, (i + 1) * size);
      await this.signed(host, `${API}upload/chunk/${begin.upload_id}/${i}`, part, { retry: true, type: 'application/octet-stream', timeoutMs: 120000 });
      onProgress?.(i + 1, chunks);
    }
    await this.call(host, 'upload.finish', { upload_id: begin.upload_id, chunks }, { retry: false });

    return begin.upload_id;
  }

  async deploy(host: HostRow, site: string, zip: Buffer, note: string, onProgress?: (done: number, total: number) => void): Promise<Release & { previous: string | null; mode: string }> {
    const uploadId = await this.upload(host, zip, onProgress);
    const out = await this.call<{ release: Release & { previous: string | null; mode: string } }>(host, 'deploy', { site, upload_id: uploadId, note }, { timeoutMs: 300000 });

    return out.release;
  }

  private parse(buf: Buffer): unknown {
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      return null;
    }
  }

  private transportError(error: unknown): AgentError {
    if (error instanceof AgentError) return error;
    if (error instanceof SsrfError) return new AgentError('blocked', error.message);
    const e = error as NodeJS.ErrnoException;
    if (e.code === 'ESSRF') return new AgentError('blocked', 'The host resolves to a private or reserved address, which is not allowed.');
    if (e.code === 'ETIMEDOUT') return new AgentError('timeout', 'The host did not answer in time.', 0, true);
    return new AgentError('unreachable', `Cannot reach the host (${e.code ?? e.message}).`, 0, true);
  }
}
