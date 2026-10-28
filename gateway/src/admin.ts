import { randomBytes } from 'node:crypto';
import { createApiKey } from './auth.ts';
import type { App, Reply } from './context.ts';
import { hashPassword, safeEqual, verifyPassword } from './crypto.ts';
import { esc, page, securityHeaders } from './html.ts';
import { isLevel, LEVELS } from './levels.ts';
import { checkCsrf, clearSessionCookie, csrfToken, newSessionCookie, readSession, type Session } from './session.ts';
import { addSite, testSite } from './siteadmin.ts';
import { parseScope } from './store.ts';
import { SiteError } from './wpclient.ts';

export interface AdminReq {
  method: string;
  path: string;
  query: URLSearchParams;
  form: URLSearchParams;
  cookie: string | undefined;
  ip: string;
}

const html = (body: string, title: string, status = 200, extra: Partial<Reply> = {}): Reply => ({ status, headers: securityHeaders(), html: page(title, body, nav()), ...extra });
const redirect = (to: string, cookies: string[] = []): Reply => ({ status: 303, headers: { location: to, 'cache-control': 'no-store' }, cookies });
const nav = (): string => '<nav><a href="/admin">Dashboard</a><a href="/admin/workbench">Workbench</a><a href="/admin/connect">Connect AI</a><a href="/admin/activity">Activity</a><a href="/admin/lang?l=fa">فارسی</a> <a href="/admin/lang?l=en">English</a></nav>';

/** Setup token printed at start-up: only someone who can read the server log can claim an empty gateway. */
let setupToken = '';
export const currentSetupToken = (): string => setupToken;

export function prepareSetup(app: App): string | null {
  if (app.store.ownerHash()) return null;
  if (app.config.adminPassword) {
    if (app.config.adminPassword.length < 12) throw new Error('WPMCP_ADMIN_PASSWORD must be at least 12 characters.');
    app.store.setOwnerHash(hashPassword(app.config.adminPassword));
    return null;
  }
  setupToken = randomBytes(9).toString('base64url');
  return setupToken;
}

const safeNext = (value: string | null): string => (value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/admin');

export function loginRedirect(next: string): Reply {
  return redirect(`/admin/login?next=${encodeURIComponent(next)}`);
}

/** The signed-in owner's session, or null. */
export const sessionOf = (app: App, cookie: string | undefined): Session | null => (app.store.ownerHash() ? readSession(app, cookie) : null);

import { handlePanel } from './panel.ts';
import { translate } from './fa.ts';

export async function handleAdmin(app: App, req: AdminReq): Promise<Reply> {
  if (req.path === '/admin/lang') {
    const l = req.query.get('l') === 'en' ? 'en' : 'fa';
    return redirect('/admin', [`wpm_lang=${l}; Path=/; SameSite=Lax; Max-Age=31536000`]);
  }
  const reply = await handleAdminInner(app, req);
  const lang = /(?:^|;\s*)wpm_lang=(\w+)/.exec(req.cookie ?? '')?.[1] ?? 'fa';
  if (lang === 'fa' && reply.html) reply.html = translate(reply.html);

  return reply;
}

async function handleAdminInner(app: App, req: AdminReq): Promise<Reply> {
  const { path, method } = req;

  if (path === '/admin/setup') return setup(app, req);
  if (!app.store.ownerHash()) return redirect('/admin/setup');
  if (path === '/admin/login') return login(app, req);

  const session = readSession(app, req.cookie);
  if (!session) return loginRedirect(req.path === '/admin' ? '/admin' : req.path);

  const panel = await handlePanel(app, req, session);
  if (panel) return panel;

  if (method === 'GET') {
    if (path === '/admin') return dashboard(app, session);
    if (path === '/admin/activity') return activity(app);
    return html('<h1>Not found</h1>', 'Not found', 404);
  }
  if (method !== 'POST') return html('<h1>Method not allowed</h1>', 'Error', 405);
  if (!checkCsrf(app, session, req.form.get('_csrf'))) return html('<h1>Form expired</h1><p>Reload the page and try again.</p>', 'Error', 403);

  const f = req.form;
  switch (path) {
    case '/admin/logout':
      return redirect('/admin/login', [clearSessionCookie()]);

    case '/admin/sites/add': {
      try {
        const site = await addSite(app, { url: f.get('url') ?? '', code: f.get('code') ?? '', name: f.get('name') ?? '', maxLevel: isLevel(f.get('max_level')) ? (f.get('max_level') as never) : 'admin' });
        return site.status === 'ok' ? dashboard(app, session, `Connected "${site.name}".`) : dashboard(app, session, `Paired "${site.name}".`, `The first test call failed: ${site.last_error}`);
      } catch (error) {
        return dashboard(app, session, undefined, error instanceof SiteError || error instanceof Error ? error.message : 'Failed.');
      }
    }
    case '/admin/sites/test': {
      const result = await testSite(app, f.get('name') ?? '');
      return dashboard(app, session, result.ok ? `OK: ${result.detail}` : undefined, result.ok ? undefined : result.detail);
    }
    case '/admin/sites/level':
      if (isLevel(f.get('level')) && app.store.site(f.get('name') ?? '')) app.store.setSiteLevel(f.get('name')!, f.get('level') as never);
      return redirect('/admin');
    case '/admin/sites/remove':
      app.store.removeSite(f.get('name') ?? '');
      return redirect('/admin');

    case '/admin/keys/create': {
      const level = isLevel(f.get('level')) ? (f.get('level') as never) : 'read';
      const chosen = f.getAll('sites');
      const known = app.store.sites().map((s) => s.name);
      const sites = chosen.length === 0 || chosen.length === known.length ? '*' : chosen.filter((s) => known.includes(s));
      const days = Math.max(0, Math.min(3650, Number(f.get('days') ?? 0) || 0));
      const key = createApiKey(app, { name: f.get('name') ?? 'API key', level, sites, expiresInDays: days || undefined });
      return dashboard(app, session, undefined, undefined, key.token);
    }
    case '/admin/keys/revoke':
      app.store.revokeKey(f.get('id') ?? '');
      return redirect('/admin');

    case '/admin/clients/revoke':
      app.store.removeClient(f.get('id') ?? '');
      return redirect('/admin');
    case '/admin/clients/level':
      if (isLevel(f.get('level')) && app.store.grant(f.get('id') ?? '')) app.store.setGrant(f.get('id')!, f.get('level') as never, app.store.grant(f.get('id')!)!.sites);
      return redirect('/admin');

    default:
      return html('<h1>Not found</h1>', 'Not found', 404);
  }
}

/* ----------------------------------------------------------------- pages */

function setup(app: App, req: AdminReq): Reply {
  if (app.store.ownerHash()) return redirect('/admin');
  const form = (message = ''): Reply =>
    html(
      `<h1>First-time setup</h1><p class="muted">Create the owner password. The setup token is printed in the server log when the gateway starts.</p>${message ? `<p class="bad">${esc(message)}</p>` : ''}
<form method="post" action="/admin/setup" class="card"><label>Setup token</label><input type="password" name="token" autocomplete="off" required>
<label>New password (12+ characters)</label><input type="password" name="password" autocomplete="new-password" minlength="12" required><div style="margin-top:14px"><button>Create owner</button></div></form>`,
      'Setup',
    );
  if (req.method !== 'POST') return form();
  const gate = app.limiter.take(`setup:${req.ip}`, 5, 1);
  if (!gate.ok) return form('Too many attempts. Wait a minute.');
  const password = req.form.get('password') ?? '';
  if (!setupToken || !safeEqual(req.form.get('token') ?? '', setupToken)) return form('Wrong setup token.');
  if (password.length < 12) return form('Password must be at least 12 characters.');
  app.store.setOwnerHash(hashPassword(password));
  setupToken = '';
  return redirect('/admin', [newSessionCookie(app)]);
}

function login(app: App, req: AdminReq): Reply {
  const next = safeNext(req.query.get('next') ?? req.form.get('next'));
  const form = (message = ''): Reply =>
    html(
      `<h1>Sign in</h1>${message ? `<p class="bad">${esc(message)}</p>` : ''}<form method="post" action="/admin/login" class="card"><input type="hidden" name="next" value="${esc(next)}"><label>Owner password</label><input type="password" name="password" autocomplete="current-password" required autofocus><div style="margin-top:14px"><button>Sign in</button></div></form>`,
      'Sign in',
      message ? 401 : 200,
    );
  if (req.method !== 'POST') return form();
  const gate = app.limiter.take(`login:${req.ip}`, app.config.limits.loginPer10Min, app.config.limits.loginPer10Min / 10);
  if (!gate.ok) return html('<h1>Too many attempts</h1><p>Try again in a few minutes.</p>', 'Locked', 429, { headers: { ...securityHeaders(), 'retry-after': String(gate.retryAfter) } });
  if (!verifyPassword(req.form.get('password') ?? '', app.store.ownerHash() ?? '')) return form('Wrong password.');
  return redirect(next, [newSessionCookie(app)]);
}

const when = (ts: number): string => (ts ? new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16) : 'never');

function levelSelect(name: string, current: string): string {
  return `<select name="${name}">${LEVELS.map((l) => `<option ${l === current ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
}

function dashboard(app: App, session: Session, notice = '', problem = '', newKey = ''): Reply {
  const csrf = `<input type="hidden" name="_csrf" value="${esc(csrfToken(app, session))}">`;
  const post = (action: string, fields: string, label: string, cls = 'secondary'): string => `<form method="post" action="${action}" style="display:inline">${csrf}${fields}<button class="${cls}">${label}</button></form>`;
  const sites = app.store.sites();

  const siteRows = sites
    .map(
      (s) => `<tr><td><b>${esc(s.name)}</b><div class="muted">${esc(s.title)}</div></td><td class="mono">${esc(s.url)}</td>
<td class="${s.status === 'ok' ? 'ok' : 'bad'}">${esc(s.status)}${s.last_error ? `<div class="muted">${esc(s.last_error)}</div>` : ''}<div class="muted">WP ${esc(s.wp_version)} · bridge ${esc(s.plugin_version)}</div></td>
<td><form method="post" action="/admin/sites/level" class="row">${csrf}<input type="hidden" name="name" value="${esc(s.name)}">${levelSelect('level', s.max_level)}<button class="secondary">Set</button></form></td>
<td>${post('/admin/sites/test', `<input type="hidden" name="name" value="${esc(s.name)}">`, 'Test')} ${post('/admin/sites/remove', `<input type="hidden" name="name" value="${esc(s.name)}">`, 'Remove', 'danger')}</td></tr>`,
    )
    .join('');

  const siteBoxes = sites.map((s) => `<label class="radio"><input type="checkbox" name="sites" value="${esc(s.name)}"> ${esc(s.name)}</label>`).join('') || '<span class="muted">No sites yet.</span>';

  const keyRows = app.store
    .keys()
    .filter((k) => !k.revoked)
    .map((k) => `<tr><td>${esc(k.name)}<div class="muted mono">${esc(k.prefix)}…</div></td><td>${esc(k.level)}</td><td>${esc(parseScope(k.sites) === '*' ? 'all sites' : (parseScope(k.sites) as string[]).join(', '))}</td><td>${when(k.last_used)}<div class="muted">${k.expires ? 'expires ' + when(k.expires) : 'no expiry'}</div></td><td>${post('/admin/keys/revoke', `<input type="hidden" name="id" value="${esc(k.id)}">`, 'Revoke', 'danger')}</td></tr>`)
    .join('');

  const clientRows = app.store
    .clients()
    .filter((c) => c.grant_level)
    .map((c) => `<tr><td>${esc(c.name)}<div class="muted mono">${esc(c.id)}</div></td><td><form method="post" action="/admin/clients/level" class="row">${csrf}<input type="hidden" name="id" value="${esc(c.id)}">${levelSelect('level', c.grant_level!)}<button class="secondary">Set</button></form></td><td>${esc(parseScope(c.grant_sites!) === '*' ? 'all sites' : (parseScope(c.grant_sites!) as string[]).join(', '))}</td><td>${when(c.last_used)}</td><td>${post('/admin/clients/revoke', `<input type="hidden" name="id" value="${esc(c.id)}">`, 'Disconnect', 'danger')}</td></tr>`)
    .join('');

  const body = `
<div class="row" style="justify-content:space-between"><h1>WP MCP gateway</h1>${post('/admin/logout', '', 'Sign out')}</div>
${notice ? `<p class="ok">${esc(notice)}</p>` : ''}${problem ? `<p class="warn">${esc(problem)}</p>` : ''}
${newKey ? `<div class="card"><b>New API key (shown once, copy it now)</b><div class="mono" style="word-break:break-all;margin-top:8px">${esc(newKey)}</div></div>` : ''}
<div class="card"><b>MCP endpoint</b><div class="mono" style="margin-top:6px">${esc(app.config.publicUrl)}/mcp</div><div class="muted">Claude.ai: add it as a custom connector. Claude Code: <code>claude mcp add --transport http wp ${esc(app.config.publicUrl)}/mcp</code></div></div>

<h2>Sites</h2>
<div class="card"><table><tr><th>Site</th><th>URL</th><th>Status</th><th>Ceiling</th><th></th></tr>${siteRows || '<tr><td colspan="5" class="muted">No sites connected.</td></tr>'}</table></div>
<form method="post" action="/admin/sites/add" class="card">${csrf}<b>Connect a site</b><div class="muted">In WordPress: Tools → WP MCP Bridge → create a pairing code (valid 15 minutes).</div>
<label>Site URL</label><input type="url" name="url" placeholder="https://example.com" required>
<label>Pairing code</label><input type="text" name="code" autocomplete="off" required>
<label>Unique name (optional, default: domain)</label><input type="text" name="name" placeholder="example.com">
<label>Highest level allowed on this site</label>${levelSelect('max_level', 'admin')}
<div style="margin-top:14px"><button>Connect</button></div></form>

<h2>API keys</h2>
<div class="card"><table><tr><th>Key</th><th>Level</th><th>Sites</th><th>Used</th><th></th></tr>${keyRows || '<tr><td colspan="5" class="muted">No keys.</td></tr>'}</table></div>
<form method="post" action="/admin/keys/create" class="card">${csrf}<b>Create a key</b>
<label>Name</label><input type="text" name="name" placeholder="Claude Code on laptop" required>
<label>Level</label>${levelSelect('level', 'draft')}
<label>Sites (none ticked = all)</label>${siteBoxes}
<label>Expires after days (0 = never)</label><input type="number" name="days" value="0" min="0" max="3650">
<div style="margin-top:14px"><button>Create key</button></div></form>

<h2>Connected apps (OAuth)</h2>
<div class="card"><table><tr><th>App</th><th>Level</th><th>Sites</th><th>Last used</th><th></th></tr>${clientRows || '<tr><td colspan="5" class="muted">None.</td></tr>'}</table></div>`;
  return html(body, 'WP MCP gateway');
}

function activity(app: App): Reply {
  const rows = app.store
    .activity({ limit: 100 })
    .map((r) => `<tr><td class="mono">${when(r.ts)}</td><td>${esc(r.principal_name)}</td><td>${esc(r.site)}</td><td class="mono">${esc(r.tool)}.${esc(r.action)}</td><td class="${r.status === 'ok' ? 'ok' : r.status === 'error' || r.status === 'denied' ? 'bad' : ''}">${esc(r.status)}</td><td>${esc(r.summary)}</td></tr>`)
    .join('');
  return html(`<h1>Activity</h1><div class="card"><table><tr><th>When (UTC)</th><th>Who</th><th>Site</th><th>Action</th><th>Result</th><th>Details</th></tr>${rows || '<tr><td colspan="6" class="muted">Nothing yet.</td></tr>'}</table></div>`, 'Activity');
}
