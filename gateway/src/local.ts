import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiKey, type Principal } from './auth.ts';
import type { App, Reply } from './context.ts';
import { isLevel, LEVELS } from './levels.ts';
import { callTool } from './mcp/tools.ts';
import { OPS, TOOLS } from './registry.ts';
import { addSite, testSite } from './siteadmin.ts';
import { parseScope } from './store.ts';
import { SiteError } from './wpclient.ts';

/**
 * The local panel: a single-page app plus a small JSON API, with no password.
 * It is only reachable from this computer: the server listens on 127.0.0.1, every request must carry a
 * loopback Host header (defeats DNS rebinding), a same-origin Origin if any, and a custom header that a
 * foreign web page cannot add without a CORS preflight (which is never granted).
 */

const here = dirname(fileURLToPath(import.meta.url));
export const panelDir = resolve(here, 'panel');
const ENTRY = resolve(here, 'index.js');

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };

const SECURITY: Record<string, string> = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const json = (status: number, body: unknown): Reply => ({ status, json: body, headers: { 'cache-control': 'no-store', ...SECURITY } });

export interface LocalReq {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, any>;
  headers: Record<string, string | string[] | undefined>;
}

function hostOk(app: App, headers: LocalReq['headers']): boolean {
  const host = String(headers.host ?? '').toLowerCase();
  const port = String(app.config.port);
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host);
}

function serveFile(path: string): Reply {
  const rel = normalize(path.replace(/^\/admin\/?/, '')).replace(/^(\.\.[/\\])+/, '');
  let file = join(panelDir, rel === '.' || rel === '' ? 'index.html' : rel);
  if (!file.startsWith(panelDir + sep) && file !== panelDir) return json(404, { error: 'not_found' });
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(panelDir, 'index.html'); // client-side routes
  if (!existsSync(file)) return { status: 503, headers: { ...SECURITY, 'content-type': 'text/plain; charset=utf-8' }, text: 'The panel is not built. Run: npm run build (in the project folder).' };
  const ext = extname(file).toLowerCase();
  const hashed = file.includes(`${sep}assets${sep}`);
  return { status: 200, headers: { ...SECURITY, 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-store' }, body: readFileSync(file) };
}

const toSite = (s: ReturnType<App['store']['sites']>[number]) => ({ name: s.name, url: s.url, title: s.title, status: s.status, last_error: s.last_error, last_ok: s.last_ok, max_level: s.max_level, wp_version: s.wp_version, plugin_version: s.plugin_version });

function spec() {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    intro: t.intro,
    actions: Object.values(OPS)
      .filter((o) => o.tool === t.name)
      .map((o) => ({ action: o.action, level: o.level, summary: o.summary, confirm: !!o.confirm, write: o.write, required: o.required, params: o.params })),
  }));
}

function state(app: App) {
  const clients = app.store.clients().filter((c) => c.grant_level).map((c) => ({ id: c.id, name: c.name, level: c.grant_level, sites: parseScope(c.grant_sites!), last_used: c.last_used }));
  return {
    version: '0.1.0',
    levels: LEVELS,
    publicUrl: app.config.publicUrl,
    dataDir: app.config.dataDir,
    entry: ENTRY,
    sites: app.store.sites().map(toSite),
    keys: app.store.keys().filter((k) => !k.revoked).map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, level: k.level, sites: parseScope(k.sites), created: k.created, last_used: k.last_used, expires: k.expires })),
    clients,
    activity: app.store.activity({ limit: 15 }),
  };
}

async function api(app: App, req: LocalReq): Promise<Reply> {
  const { path, method, body, query } = req;
  const route = path.replace('/admin/api/', '');
  try {
    if (method === 'GET' && route === 'state') return json(200, state(app));
    if (method === 'GET' && route === 'spec') return json(200, spec());
    if (method === 'GET' && route === 'activity') return json(200, { entries: app.store.activity({ limit: Math.min(200, Number(query.get('limit') ?? 100)) }) });
    if (method !== 'POST') return json(404, { error: 'not_found' });

    switch (route) {
      case 'sites/add': {
        const site = await addSite(app, { url: String(body.url ?? ''), code: String(body.code ?? ''), name: String(body.name ?? ''), maxLevel: isLevel(body.max_level) ? body.max_level : 'admin' });
        return json(200, { ok: true, site: toSite(site) });
      }
      case 'sites/test':
        return json(200, await testSite(app, String(body.name)));
      case 'sites/remove':
        app.store.removeSite(String(body.name));
        return json(200, { ok: true });
      case 'sites/level':
        if (isLevel(body.level) && app.store.site(String(body.name))) app.store.setSiteLevel(String(body.name), body.level);
        return json(200, { ok: true });
      case 'keys/create': {
        const known = app.store.sites().map((s) => s.name);
        const chosen = (Array.isArray(body.sites) ? body.sites : []).filter((s: string) => known.includes(s));
        const key = createApiKey(app, { name: String(body.name || 'API key'), level: isLevel(body.level) ? body.level : 'read', sites: chosen.length === 0 || chosen.length === known.length ? '*' : chosen, expiresInDays: Math.max(0, Math.min(3650, Number(body.days) || 0)) || undefined });
        return json(200, { ok: true, token: key.token });
      }
      case 'keys/revoke':
        app.store.revokeKey(String(body.id));
        return json(200, { ok: true });
      case 'clients/revoke':
        app.store.removeClient(String(body.id));
        return json(200, { ok: true });
      case 'clients/level': {
        const grant = app.store.grant(String(body.id));
        if (grant && isLevel(body.level)) app.store.setGrant(String(body.id), body.level, grant.sites);
        return json(200, { ok: true });
      }
      case 'run': {
        const principal: Principal = { id: 'panel', kind: 'stdio', name: 'Local panel', level: isLevel(body.level) ? body.level : 'read', sites: '*' };
        const result = await callTool(app, principal, String(body.tool ?? ''), { site: body.site || undefined, action: body.action, args: body.args ?? {}, dry_run: !!body.dry_run, confirm_token: body.confirm_token || undefined });
        let data: unknown;
        try {
          data = JSON.parse(result.content[0].text);
        } catch {
          data = { ok: false, error: { code: 'error', message: result.content[0].text } };
        }
        return json(200, data);
      }
      default:
        return json(404, { error: 'not_found' });
    }
  } catch (error) {
    const message = error instanceof SiteError || error instanceof Error ? error.message : 'Failed.';
    return json(error instanceof SiteError ? 200 : 500, { ok: false, error: { code: error instanceof SiteError ? error.code : 'error', message } });
  }
}

/** Handles every /admin request in local mode. */
export async function handleLocal(app: App, req: LocalReq): Promise<Reply> {
  if (!hostOk(app, req.headers)) return json(403, { error: 'forbidden', message: 'The local panel only answers on 127.0.0.1 / localhost.' });
  if (req.path.startsWith('/admin/api/')) {
    const origin = String(req.headers.origin ?? '');
    if (origin && origin !== `http://${req.headers.host}`) return json(403, { error: 'forbidden', message: 'Cross-origin request refused.' });
    if (req.headers['x-wpm-panel'] !== '1') return json(403, { error: 'forbidden', message: 'Missing panel header.' });
    return api(app, req);
  }
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });

  return serveFile(req.path);
}
