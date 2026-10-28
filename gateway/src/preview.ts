import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { AGENT_JS } from './agent.ts';
import type { App } from './context.ts';
import { safeRequest } from './ssrf.ts';

/**
 * Preview origin for the visual editor. It serves a site's pages on a different origin than the panel (port + 1), with
 * stylesheets proxied same-origin so the inspector agent can read their rules. Page scripts run, but can never reach the
 * panel (different origin, no cookies, no CORS). Every URL carries a per-run token.
 */

export const previewToken = randomBytes(18).toString('base64url');
const UA = 'Mozilla/5.0 (compatible; WP-MCP-Preview/0.1)';
const abs = (href: string, base: string): string => { try { return new URL(href, base).href; } catch { return href; } };

export function rewriteCss(css: string, base: string, origin: string): string {
  const proxied = (u: string): string => `${origin}/css?u=${encodeURIComponent(u)}&t=${previewToken}`;
  return css
    .replace(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?/gi, (_m, _q, u: string) => `@import url("${proxied(abs(u, base))}")`)
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q: string, u: string) => (/^(data:|#|about:)/i.test(u) || /\/css\?u=/.test(u) ? m : `url(${q}${abs(u, base)}${q})`));
}

export function rewriteHtml(html: string, finalUrl: string, origin: string, panelOrigin: string): string {
  const agent = `<script src="${origin}/agent.js?o=${encodeURIComponent(panelOrigin)}&t=${previewToken}"></script>`;
  let out = html
    .replace(/<meta[^>]+http-equiv=["']?(content-security-policy|refresh)["']?[^>]*>/gi, '')
    .replace(/<link\b[^>]*>/gi, (tag) => {
      if (!/rel=["']?stylesheet/i.test(tag) && !/rel=["']?preload["']?[^>]*as=["']?style/i.test(tag)) return tag;
      const m = /\bhref=(["'])(.*?)\1/i.exec(tag);
      if (!m) return tag;
      const target = abs(m[2].replace(/&amp;/g, '&'), finalUrl);
      return tag
        .replace(m[0], `href="${origin}/css?u=${encodeURIComponent(target)}&t=${previewToken}" data-wpm-src="${target.replace(/"/g, '&quot;')}"`)
        .replace(/\s(integrity|crossorigin|onload)=("[^"]*"|'[^']*'|\S+)/gi, '')
        .replace(/rel=["']?preload["']?/i, 'rel="stylesheet"')
        .replace(/media=["']print["']/i, 'media="all"');
    });
  const head = `<base href="${finalUrl}">`;
  out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (h) => `${h}${head}`) : `<head>${head}</head>${out}`;
  out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${agent}</body>`) : `${out}${agent}`;

  return out;
}

export function startPreview(app: App, panelPort: number): Promise<http.Server> {
  const port = panelPort + 1;
  const origin = `http://127.0.0.1:${port}`;
  const panelOrigin = `http://127.0.0.1:${panelPort}`;
  const policy = { allowPrivate: app.config.allowPrivateSites, allowHttp: true };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    const fail = (code: number, msg: string): void => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(msg); };
    const host = String(req.headers.host ?? '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return fail(403, 'forbidden');
    if (url.searchParams.get('t') !== previewToken) return fail(403, 'forbidden');
    const common = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': `frame-ancestors ${panelOrigin} http://localhost:${panelPort}` };

    try {
      if (url.pathname === '/agent.js') {
        res.writeHead(200, { ...common, 'content-type': 'text/javascript; charset=utf-8' });
        return void res.end(AGENT_JS);
      }
      const target = url.searchParams.get('u') ?? '';
      if (url.pathname === '/page' || url.pathname === '/css') {
        let next = target;
        for (let hop = 0; hop < 6; hop++) {
          const r = await safeRequest(next, policy, { headers: { 'user-agent': UA, accept: url.pathname === '/css' ? 'text/css,*/*' : 'text/html,*/*', 'accept-language': 'fa,en;q=0.8' }, maxBytes: 6 * 1024 * 1024, timeoutMs: 25000 });
          const loc = typeof r.headers.location === 'string' ? abs(r.headers.location, next) : '';
          if (r.status >= 300 && r.status < 400 && loc) { next = loc; continue; }
          if (url.pathname === '/css') {
            res.writeHead(200, { ...common, 'content-type': 'text/css; charset=utf-8' });
            return void res.end(rewriteCss(r.body.toString('utf8'), next, origin));
          }
          res.writeHead(r.status, { ...common, 'content-type': 'text/html; charset=utf-8', 'x-wpm-final-url': encodeURIComponent(next) });
          return void res.end(rewriteHtml(r.body.toString('utf8'), next, origin, panelOrigin));
        }
        return fail(502, 'Too many redirects');
      }
      return fail(404, 'not found');
    } catch (error) {
      return fail(502, `Preview failed: ${(error as Error).message}`);
    }
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

export const previewInfo = (app: App): { base: string; token: string } => ({ base: `http://127.0.0.1:${app.config.port + 1}`, token: previewToken });
