import { createHash } from 'node:crypto';
import { ACCESS_PREFIX, REFRESH_PREFIX } from './auth.ts';
import type { App, Reply } from './context.ts';
import { json } from './context.ts';
import { safeEqual, sha256, token } from './crypto.ts';
import { esc, page, securityHeaders } from './html.ts';
import type { Level } from './levels.ts';
import { isLevel, LEVEL_HELP, LEVELS, minLevel, rank } from './levels.ts';
import { checkCsrf, csrfToken, type Session } from './session.ts';
import { encodeScope, parseScope, type SiteScope } from './store.ts';

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const EDITOR_SCHEMES = ['cursor', 'vscode', 'vscode-insiders'];
const MAX_CLIENTS = 200;

/* ----------------------------------------------------------------- metadata */

export const protectedResource = (app: App): Reply =>
  json(200, { resource: `${app.config.publicUrl}/mcp`, authorization_servers: [app.config.publicUrl], bearer_methods_supported: ['header'], scopes_supported: [...LEVELS] }, { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' });

export const authorizationServer = (app: App): Reply => {
  const base = app.config.publicUrl;
  return json(
    200,
    {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...LEVELS],
    },
    { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' },
  );
};

/* ---------------------------------------------------------------- redirects */

/** https, loopback http (desktop tools), or an editor scheme. Never javascript:, data:, fragments or credentials. */
export function redirectUriOk(uri: string): boolean {
  if (uri.length > 500 || /[\x00-\x20#]/.test(uri)) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const scheme = url.protocol.slice(0, -1);
  if (scheme === 'https') return true;
  if (EDITOR_SCHEMES.includes(scheme)) return true;
  return scheme === 'http' && LOOPBACK.includes(url.hostname.toLowerCase());
}

const loopbackKey = (uri: string): string | null => {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && LOOPBACK.includes(url.hostname.toLowerCase()) ? `${url.pathname}?${url.search}` : null;
  } catch {
    return null;
  }
};

/** Exact match; loopback addresses match on any port (RFC 8252 §7.3), since desktop tools pick a random one. */
export function redirectRegistered(uri: string, registered: string[]): boolean {
  if (registered.includes(uri)) return true;
  const want = loopbackKey(uri);
  return want !== null && registered.some((r) => loopbackKey(r) === want);
}

const hostOf = (uri: string): string => {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : `${url.protocol}//${url.host || url.pathname}`;
  } catch {
    return uri;
  }
};

/* ------------------------------------------------------------ registration */

export function register(app: App, body: Record<string, unknown>, ip: string): Reply {
  const gate = app.limiter.take(`register:${ip}`, app.config.limits.registerPerHour, app.config.limits.registerPerHour / 60);
  if (!gate.ok) return json(429, { error: 'slow_down', error_description: 'Too many registrations.' }, { 'retry-after': String(gate.retryAfter) });

  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every((u) => typeof u === 'string' && redirectUriOk(u))) {
    return json(400, { error: 'invalid_redirect_uri', error_description: 'Give 1 to 5 redirect_uris: https, loopback http, or an editor scheme.' });
  }
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') {
    return json(400, { error: 'invalid_client_metadata', error_description: 'Only public clients (token_endpoint_auth_method none) with PKCE are supported.' });
  }
  if (app.store.countClients() >= MAX_CLIENTS) app.store.purge();
  if (app.store.countClients() >= MAX_CLIENTS) return json(503, { error: 'temporarily_unavailable', error_description: 'Too many registered apps.' });

  const name = String(body.client_name ?? '').replace(/[\x00-\x1f<>]/g, '').trim().slice(0, 80) || 'AI app';
  const id = token('wpmc_', 16);
  app.store.addClient({ id, name, redirect_uris: JSON.stringify(uris) });
  return json(201, { client_id: id, client_name: name, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_id_issued_at: app.store.clock() });
}

/* ---------------------------------------------------------------- authorize */

export interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
  scope: string;
}

export const readAuthorize = (source: Record<string, unknown>): AuthorizeParams => ({
  client_id: String(source.client_id ?? ''),
  redirect_uri: String(source.redirect_uri ?? ''),
  response_type: String(source.response_type ?? ''),
  code_challenge: String(source.code_challenge ?? ''),
  code_challenge_method: String(source.code_challenge_method ?? ''),
  state: String(source.state ?? '').slice(0, 500),
  scope: String(source.scope ?? '').slice(0, 200),
});

const fatal = (message: string): Reply => ({ status: 400, headers: securityHeaders(), html: page('Cannot authorize', `<h1>Cannot authorize</h1><p class="bad">${esc(message)}</p>`) });

const back = (uri: string, params: Record<string, string>): Reply => {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== '') url.searchParams.set(k, v);
  return { status: 302, headers: { location: url.toString(), 'cache-control': 'no-store' } };
};

type Checked = { reply: Reply } | { params: AuthorizeParams; clientName: string };

/** "reply" is a fatal page (never redirect to an unchecked address) or a redirect back with an OAuth error. */
export function checkAuthorize(app: App, params: AuthorizeParams): Checked {
  const client = app.store.client(params.client_id);
  const uris = client ? (JSON.parse(client.redirect_uris) as string[]) : [];
  if (!client || !redirectUriOk(params.redirect_uri) || !redirectRegistered(params.redirect_uri, uris)) return { reply: fatal('This app is not registered, or its redirect address does not match its registration.') };
  if (params.response_type !== 'code') return { reply: back(params.redirect_uri, { error: 'unsupported_response_type', state: params.state }) };
  if (params.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge)) return { reply: back(params.redirect_uri, { error: 'invalid_request', error_description: 'PKCE with S256 is required.', state: params.state }) };
  return { params, clientName: client.name };
}

const requestedLevel = (scope: string): Level => {
  const levels = scope.split(/[\s,]+/).filter(isLevel);
  const asked = levels.length ? levels.reduce((top, l) => (rank(l) > rank(top) ? l : top)) : 'live';
  return minLevel(asked, 'live'); // admin is never pre-selected: the owner must choose it deliberately.
};

const FA = {
  title: 'به این برنامه اجازه می‌دهید سایت‌های وردپرس شما را مدیریت کند؟',
  intro: 'برنامه‌ی زیر درخواست اتصال به gateway شما را داده است.',
  app: 'نام برنامه (توسط خود برنامه اعلام شده و تأیید نشده است)',
  after: 'پس از تأیید، نتیجه‌ی ورود به این آدرس فرستاده می‌شود',
  warn: 'فقط اگر خودتان این اتصال را شروع کرده‌اید و آدرس بالا را می‌شناسید تأیید کنید.',
  level: 'سطح دسترسی',
  sites: 'سایت‌ها',
  approve: 'تأیید',
  deny: 'رد',
  none: 'هنوز سایتی وصل نشده است. ابتدا در پنل مدیریت یک سایت اضافه کنید.',
  levels: {
    read: 'فقط خواندن داده‌ی منتشرشده و غیرحساس. بدون کاربران، سفارش‌ها، تنظیمات و پیش‌نویس‌ها.',
    draft: 'همه‌ی read + پیش‌نویس و محتوای خصوصی، آپلود و نوشتن پیش‌نویس. چیزی عمومی نمی‌شود.',
    live: 'همه‌ی draft + انتشار و ویرایش صفحات زنده، منو، CSS، سئو، ریدایرکت، محصولات و کش.',
    admin: 'همه‌چیز: افزونه‌ها، به‌روزرسانی، کاربران، گزینه‌ها، دیتابیس، فایل‌های پوسته، بکاپ. عملیات مخرب باز هم تأیید می‌خواهد.',
  } as Record<Level, string>,
};

export function consentPage(app: App, params: AuthorizeParams, clientName: string, session: Session, lang = 'en'): Reply {
  const fa = lang === 'fa';
  const sites = app.store.sites();
  const wanted = requestedLevel(params.scope);
  const hidden = (['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope'] as const).map((k) => `<input type="hidden" name="${k}" value="${esc(params[k])}">`).join('');
  const levels = LEVELS.map(
    (l) => `<label class="radio"><input type="radio" name="level" value="${l}" ${l === wanted ? 'checked' : ''}> <b>${l}</b>: ${esc(fa ? FA.levels[l] : LEVEL_HELP[l])}</label>`,
  ).join('');
  const siteBoxes = sites.length
    ? sites.map((s) => `<label class="radio"><input type="checkbox" name="sites" value="${esc(s.name)}" checked> <b>${esc(s.name)}</b> <span class="muted">${esc(s.url)}</span></label>`).join('')
    : `<p class="warn">${fa ? FA.none : 'No sites are connected yet. Add one in the admin panel first.'}</p>`;
  const body = `
<h1>${fa ? FA.title : 'Allow this app to manage your WordPress sites?'}</h1>
<p class="muted">${fa ? FA.intro : 'The app below asked to connect to your WP MCP gateway.'}</p>
<div class="card">
  <div class="muted">${fa ? FA.app : 'App name (chosen by the app itself, not verified)'}</div><div><b>${esc(clientName)}</b></div>
  <div class="muted" style="margin-top:10px">${fa ? FA.after : 'After you approve, the sign-in result is sent to'}</div>
  <div class="domain">${esc(hostOf(params.redirect_uri))}</div>
  <div class="muted mono">${esc(params.redirect_uri)}</div>
</div>
<div class="warn">${fa ? FA.warn : 'Only approve if you started this connection and recognise the address above.'}</div>
<form method="post" action="/authorize">
  ${hidden}<input type="hidden" name="_csrf" value="${esc(csrfToken(app, session))}">
  <h2>${fa ? FA.level : 'Permission level'}</h2>${levels}
  <h2>${fa ? FA.sites : 'Sites'}</h2>${siteBoxes}
  <div class="row" style="margin-top:18px"><button name="decision" value="approve">${fa ? FA.approve : 'Approve'}</button><button class="secondary" name="decision" value="deny">${fa ? FA.deny : 'Deny'}</button></div>
</form>
<p class="muted"><a href="${esc(`/authorize?${new URLSearchParams({ ...Object.fromEntries(Object.entries(params)), prompt: 'consent', lang: fa ? 'en' : 'fa' })}`)}">${fa ? 'English' : 'فارسی'}</a></p>`;
  return { status: 200, headers: securityHeaders(), html: page('Authorize app', body, '', lang) };
}

/** Issues a code for an already-approved grant, or null when the owner has to decide. */
export function silentGrant(app: App, clientId: string): { level: Level; sites: SiteScope } | null {
  const grant = app.store.grant(clientId);
  return grant ? { level: grant.level, sites: parseScope(grant.sites) } : null;
}

export function issueCode(app: App, params: AuthorizeParams, level: Level, sites: SiteScope): Reply {
  const code = token('', 32);
  app.store.putCode({ hash: sha256(code), client_id: params.client_id, redirect_uri: params.redirect_uri, challenge: params.code_challenge, level, sites: encodeScope(sites), expires: app.store.clock() + 60 });
  return back(params.redirect_uri, { code, state: params.state });
}

export function decide(app: App, session: Session, form: Record<string, unknown>, selectedSites: string[]): Reply {
  if (!checkCsrf(app, session, form._csrf)) return fatal('The form expired. Go back to the app and start the connection again.');
  const checked = checkAuthorize(app, readAuthorize(form));
  if ('reply' in checked) return checked.reply;
  const { params } = checked;
  if (form.decision !== 'approve') return back(params.redirect_uri, { error: 'access_denied', state: params.state });

  const level = isLevel(form.level) ? form.level : 'read';
  const known = new Set(app.store.sites().map((s) => s.name));
  const sites = selectedSites.filter((s) => known.has(s));
  if (sites.length === 0) return fatal('Select at least one site.');
  const all = sites.length === known.size;
  const scope: SiteScope = all ? '*' : sites;
  app.store.setGrant(params.client_id, level, encodeScope(scope));
  return issueCode(app, params, level, scope);
}

/* -------------------------------------------------------------------- token */

const oauthError = (status: number, error: string, description: string, extra: Record<string, string> = {}): Reply =>
  json(status, { error, error_description: description }, { 'access-control-allow-origin': '*', ...extra });

function issueTokens(app: App, clientId: string, family: string, level: Level, sites: string): Reply {
  const now = app.store.clock();
  const access = token(ACCESS_PREFIX);
  const refresh = token(REFRESH_PREFIX);
  app.store.putToken({ hash: sha256(access), kind: 'access', client_id: clientId, family, level, sites, expires: now + app.config.accessTtl, created: now });
  app.store.putToken({ hash: sha256(refresh), kind: 'refresh', client_id: clientId, family, level, sites, expires: now + app.config.refreshTtl, created: now });
  return json(200, { access_token: access, token_type: 'Bearer', expires_in: app.config.accessTtl, refresh_token: refresh, scope: level }, { 'access-control-allow-origin': '*' });
}

export function tokenEndpoint(app: App, form: Record<string, unknown>, ip: string): Reply {
  const clientId = String(form.client_id ?? '');
  const gate = app.limiter.take(`token:${clientId || ip}`, app.config.limits.tokenPerMin, app.config.limits.tokenPerMin);
  if (!gate.ok) return oauthError(429, 'slow_down', 'Too many token requests.', { 'retry-after': String(gate.retryAfter) });
  const client = app.store.client(clientId);
  if (!client) return oauthError(401, 'invalid_client', 'Unknown client_id.');

  if (form.grant_type === 'authorization_code') {
    const row = app.store.takeCode(sha256(String(form.code ?? '')));
    if (!row || row.client_id !== clientId || row.redirect_uri !== String(form.redirect_uri ?? '')) return oauthError(400, 'invalid_grant', 'The code is invalid, used or expired.');
    const verifier = String(form.code_verifier ?? '');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(challenge, row.challenge)) return oauthError(400, 'invalid_grant', 'PKCE verification failed.');
    app.store.touchClient(clientId);
    return issueTokens(app, clientId, token('f_', 9), row.level, row.sites);
  }

  if (form.grant_type === 'refresh_token') {
    const presented = String(form.refresh_token ?? '');
    const row = presented.startsWith(REFRESH_PREFIX) ? app.store.token(sha256(presented)) : undefined;
    const now = app.store.clock();
    if (!row || row.kind !== 'refresh' || row.client_id !== clientId || row.expires < now) return oauthError(400, 'invalid_grant', 'The refresh token is invalid or expired. Connect again.');
    const grant = app.store.grant(clientId);
    if (!grant) return oauthError(400, 'invalid_grant', 'Access was revoked. Connect again.');
    if (row.rotated_at > 0 && now - row.rotated_at > app.config.refreshGrace) {
      // An old token came back after its replacement was in use: treat the whole chain as stolen.
      app.store.revokeFamily(row.family);
      return oauthError(400, 'invalid_grant', 'This refresh token was already used. Connect again.');
    }
    // Within the grace window a retry (lost response) is answered with a fresh pair in the same chain.
    if (row.rotated_at === 0) app.store.markRotated(row.hash);
    return issueTokens(app, clientId, row.family, minLevel(row.level, grant.level), row.sites);
  }

  return oauthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

export function revoke(app: App, form: Record<string, unknown>): Reply {
  const presented = String(form.token ?? '');
  const row = presented ? app.store.token(sha256(presented)) : undefined;
  if (row && row.client_id === String(form.client_id ?? '')) app.store.revokeFamily(row.family);
  return json(200, {}, { 'access-control-allow-origin': '*' });
}
