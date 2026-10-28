import http from 'node:http';
import { authenticate, bearerFrom } from './auth.ts';
import { handleAdmin, loginRedirect, sessionOf } from './admin.ts';
import type { App, Reply } from './context.ts';
import { json } from './context.ts';
import { handleMessage } from './mcp/server.ts';
import { authorizationServer, checkAuthorize, consentPage, decide, issueCode, protectedResource, readAuthorize, register, revoke, silentGrant, tokenEndpoint } from './oauth.ts';
import { esc, page, securityHeaders } from './html.ts';

const MCP_LIMIT = 16 * 1024 * 1024;
const SMALL_LIMIT = 256 * 1024;

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, x-api-key, last-event-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id',
  'access-control-max-age': '600',
};

class TooLarge extends Error {}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new TooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function clientIp(app: App, req: http.IncomingMessage): string {
  if (app.config.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function send(res: http.ServerResponse, reply: Reply, extra: Record<string, string> = {}): void {
  const headers: Record<string, string | string[]> = { ...(reply.headers ?? {}), ...extra };
  let body = '';
  if (reply.json !== undefined) {
    body = JSON.stringify(reply.json);
    headers['content-type'] = 'application/json';
  } else if (reply.html !== undefined) {
    body = reply.html;
    headers['content-type'] ??= 'text/html; charset=utf-8';
  } else if (reply.text !== undefined) {
    body = reply.text;
    headers['content-type'] = 'text/plain; charset=utf-8';
  }
  if (reply.cookies?.length) headers['set-cookie'] = reply.cookies;
  res.writeHead(reply.status, headers);
  res.end(body);
}

const parseForm = (body: Buffer, type: string): URLSearchParams => {
  if (type.includes('application/json')) {
    try {
      const data = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      return new URLSearchParams(Object.entries(data).map(([k, v]) => [k, String(v)]));
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(body.toString('utf8'));
};

export function createHandler(app: App): http.RequestListener {
  return async (req, res) => {
    try {
      await route(app, req, res);
    } catch (error) {
      if (error instanceof TooLarge) return send(res, json(413, { error: 'payload_too_large' }));
      console.error('request failed', error);
      if (!res.headersSent) send(res, json(500, { error: 'server_error' }));
    }
  };
}

async function route(app: App, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', app.config.publicUrl);
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const ip = clientIp(app, req);
  const type = String(req.headers['content-type'] ?? '');

  if (method === 'OPTIONS') return void send(res, { status: 204, headers: CORS });

  if (path === '/healthz') return send(res, json(200, { ok: true }));

  if (path === '/') {
    return send(res, { status: 200, headers: securityHeaders(), html: page('WP MCP gateway', `<h1>WP MCP gateway</h1><p>MCP endpoint: <code>${esc(app.config.publicUrl)}/mcp</code></p><p><a href="/admin">Admin panel</a></p>`) });
  }

  if (path.startsWith('/.well-known/oauth-protected-resource')) return send(res, protectedResource(app));
  if (path === '/.well-known/oauth-authorization-server') return send(res, authorizationServer(app));

  if (path === '/register' && method === 'POST') {
    const raw = await readBody(req, SMALL_LIMIT);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      return send(res, json(400, { error: 'invalid_client_metadata' }, { 'access-control-allow-origin': '*' }));
    }
    return send(res, register(app, body, ip), { 'access-control-allow-origin': '*' });
  }

  if (path === '/token' && method === 'POST') {
    const form = parseForm(await readBody(req, SMALL_LIMIT), type);
    return send(res, tokenEndpoint(app, Object.fromEntries(form), ip));
  }

  if (path === '/revoke' && method === 'POST') {
    const form = parseForm(await readBody(req, SMALL_LIMIT), type);
    return send(res, revoke(app, Object.fromEntries(form)));
  }

  if (path === '/authorize') {
    const session = sessionOf(app, req.headers.cookie);
    if (method === 'GET') {
      const checked = checkAuthorize(app, readAuthorize(Object.fromEntries(url.searchParams)));
      if ('reply' in checked) return send(res, checked.reply);
      if (!session) return send(res, loginRedirect(`${path}${url.search}`));
      const remembered = silentGrant(app, checked.params.client_id);
      if (remembered && url.searchParams.get('prompt') !== 'consent' && !url.searchParams.has('lang')) return send(res, issueCode(app, checked.params, remembered.level, remembered.sites));
      return send(res, consentPage(app, checked.params, checked.clientName, session, url.searchParams.get('lang') === 'fa' ? 'fa' : 'en'));
    }
    if (method === 'POST') {
      const form = parseForm(await readBody(req, SMALL_LIMIT), type);
      if (!session) return send(res, loginRedirect('/admin'));
      return send(res, decide(app, session, Object.fromEntries(form), form.getAll('sites')));
    }
  }

  if (path === '/admin' || path.startsWith('/admin/')) {
    const form = method === 'POST' ? parseForm(await readBody(req, SMALL_LIMIT), type) : new URLSearchParams();
    return send(res, await handleAdmin(app, { method, path, query: url.searchParams, form, cookie: req.headers.cookie, ip }));
  }

  if (path === '/mcp') return mcp(app, req, res, method, ip);

  send(res, json(404, { error: 'not_found' }));
}

async function mcp(app: App, req: http.IncomingMessage, res: http.ServerResponse, method: string, ip: string): Promise<void> {
  if (method !== 'POST') return send(res, json(405, { error: 'method_not_allowed', error_description: 'Stateless Streamable HTTP: use POST.' }, { allow: 'POST, OPTIONS', ...CORS }));

  const auth = authenticate(app, bearerFrom(req.headers));
  if ('error' in auth) {
    const guard = app.limiter.take(`authfail:${ip}`, 30, 30);
    if (!guard.ok) return send(res, json(429, { error: 'slow_down' }, { 'retry-after': String(guard.retryAfter), ...CORS }));
    const meta = `resource_metadata="${app.config.publicUrl}/.well-known/oauth-protected-resource"`;
    const detail = auth.error === 'missing' ? '' : `, error="invalid_token", error_description="${auth.error === 'expired' ? 'The access token expired' : 'The access token is invalid'}"`;
    return send(res, json(401, { error: 'unauthorized', error_description: 'Send Authorization: Bearer <API key or OAuth token>.' }, { 'www-authenticate': `Bearer ${meta}${detail}`, ...CORS }));
  }
  const { principal } = auth;

  const gate = app.limiter.take(`h:${principal.id}`, 600, 600);
  if (!gate.ok) return send(res, json(429, { error: 'rate_limited' }, { 'retry-after': String(gate.retryAfter), ...CORS }));

  const raw = await readBody(req, MCP_LIMIT);
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return send(res, json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, CORS));
  }

  const batch = Array.isArray(payload);
  const messages = (batch ? payload : [payload]) as Record<string, unknown>[];
  const replies = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const reply = await handleMessage(app, principal, message);
    if (reply) replies.push(reply);
  }
  if (replies.length === 0) return send(res, { status: 202, headers: CORS });
  send(res, json(200, batch ? replies : replies[0], CORS));
}

export function startServer(app: App): Promise<http.Server> {
  const server = http.createServer(createHandler(app));
  server.requestTimeout = 300000;
  server.headersTimeout = 20000;
  server.keepAliveTimeout = 65000;
  return new Promise((resolve) => server.listen(app.config.port, app.config.host, () => resolve(server)));
}
