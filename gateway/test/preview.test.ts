import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { previewToken, rewriteCss, rewriteHtml, startPreview } from '../src/preview.ts';
import { createEnv, type Env } from './helpers.ts';

describe('preview origin for the visual editor', () => {
  const O = 'http://127.0.0.1:9999';

  it('proxies stylesheets, keeps scripts, removes CSP and refresh', () => {
    const html = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src none"><meta http-equiv="refresh" content="0;url=/x"><link rel="stylesheet" href="/s/a.css" integrity="sha" crossorigin="anonymous"><link rel="preload" as="style" href="b.css" media="print" onload="this.media=\'all\'"></head><body><script>1</script></body></html>';
    const out = rewriteHtml(html, 'https://site.test/page/', O, 'http://127.0.0.1:8787');
    expect(out).not.toMatch(/content-security-policy|http-equiv="refresh"/i);
    expect(out).toContain(`href="${O}/css?u=${encodeURIComponent('https://site.test/s/a.css')}&t=${previewToken}"`);
    expect(out).toContain(`data-wpm-src="https://site.test/s/a.css"`);
    expect(out).toContain(encodeURIComponent('https://site.test/page/b.css'));
    expect(out).not.toMatch(/integrity|crossorigin|onload/i);
    expect(out).toContain('<base href="https://site.test/page/">');
    expect(out).toContain('<script>1</script>');
    expect(out).toContain(`${O}/agent.js?o=${encodeURIComponent('http://127.0.0.1:8787')}`);
  });

  it('makes url() and @import in CSS absolute', () => {
    const css = '@import "reset.css";body{background:url(../img/a.png)}@font-face{src:url("f.woff2")}i{background:url(data:image/png;base64,AA)}';
    const out = rewriteCss(css, 'https://site.test/wp-content/themes/t/css/main.css', O);
    expect(out).toContain(`@import url("${O}/css?u=${encodeURIComponent('https://site.test/wp-content/themes/t/css/reset.css')}`);
    expect(out).toContain('url(https://site.test/wp-content/themes/t/img/a.png)');
    expect(out).toContain('url("https://site.test/wp-content/themes/t/css/f.woff2")');
    expect(out).toContain('url(data:image/png;base64,AA)');
  });

  describe('server', () => {
    let env: Env;
    let target: http.Server;
    let site = '';
    let preview: http.Server;
    let base = '';
    beforeAll(async () => {
      target = http.createServer((req, res) => {
        if (req.url === '/style.css') { res.writeHead(200, { 'content-type': 'text/css' }); return void res.end('h1{background:url(img.png)}'); }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head><link rel="stylesheet" href="/style.css"></head><body><h1>Hi</h1></body></html>');
      });
      await new Promise<void>((done) => target.listen(0, '127.0.0.1', done));
      site = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
      env = await createEnv([], { localPanel: true }, { owner: false });
      preview = await startPreview(env.app, env.config.port);
      base = `http://127.0.0.1:${env.config.port + 1}`;
    });
    afterAll(async () => {
      await env.stop();
      await new Promise<void>((d) => preview.close(() => d()));
      await new Promise<void>((d) => target.close(() => d()));
    });

    it('serves rewritten pages and css only with the token', async () => {
      const page = await fetch(`${base}/page?u=${encodeURIComponent(site)}&t=${previewToken}`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('<h1>Hi</h1>');
      expect(html).toContain('/css?u=');
      const css = await (await fetch(`${base}/css?u=${encodeURIComponent(`${site}/style.css`)}&t=${previewToken}`)).text();
      expect(css).toContain(`url(${site}/img.png)`);
      expect((await fetch(`${base}/page?u=${encodeURIComponent(site)}&t=wrong`)).status).toBe(403);
      expect((await fetch(`${base}/agent.js?t=${previewToken}`)).headers.get('content-type')).toMatch(/javascript/);
    });

    it('does not fetch private addresses when they are not allowed', async () => {
      const strict = await createEnv([], { localPanel: true, allowPrivateSites: false }, { owner: false });
      const p2 = await startPreview(strict.app, strict.config.port);
      const res = await fetch(`http://127.0.0.1:${strict.config.port + 1}/page?u=${encodeURIComponent('http://169.254.169.254/')}&t=${previewToken}`);
      expect(res.status).toBe(502);
      await new Promise<void>((d) => p2.close(() => d()));
      await strict.stop();
    });
  });
});
