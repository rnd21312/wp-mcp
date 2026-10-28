import type { FrameworkTemplate } from './templates.ts';

/** Templates for Node.js sites (run by Passenger on shared hosting, or by systemd on a VPS). */

const json = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site';
const lead = (rtl: boolean): string => (rtl ? 'سایت شما با موفقیت ساخته شد.' : 'Your site is up and running.');

const css = (rtl: boolean): string => `body{margin:0;font-family:system-ui,Tahoma,sans-serif;line-height:1.7${rtl ? ';direction:rtl' : ''}}
main{max-width:720px;margin:0 auto;padding:4rem 1.5rem;text-align:center}h1{font-size:clamp(2rem,6vw,3rem)}
`;

const SERVER_JS = `import { createServer } from 'node:http';

const port = process.env.PORT || 3000;
const page = __PAGE__;

createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
}).listen(port, () => console.log('listening on ' + port));
`;

export const NODE_TEMPLATES: Record<string, FrameworkTemplate> = {
  'node-http': {
    label: 'Node.js app (no dependencies)',
    framework: 'node-http',
    kind: 'node',
    publish: '.',
    startup: 'server.js',
    note: 'A plain Node.js server. Needs a host that runs Node (Passenger on cPanel/Plesk/DirectAdmin, or a VPS).',
    files: (title, rtl) => {
      const page = `<!doctype html><html lang="${rtl ? 'fa' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><body style="font-family:system-ui;text-align:center;padding:4rem"><h1>${esc(title)}</h1><p>${lead(rtl)}</p>`;

      return {
        'package.json': json({ name: slug(title), private: true, version: '0.0.0', type: 'module', scripts: { start: 'node server.js', build: 'node -e "console.log(\'Nothing to compile; dependencies are installed.\')"' }, engines: { node: '>=20' } }),
        'server.js': SERVER_JS.replace('__PAGE__', JSON.stringify(page)),
      };
    },
  },
  'next-ssr': {
    label: 'Next.js (server rendering)',
    framework: 'next-ssr',
    kind: 'node',
    publish: '.wpm-deploy',
    startup: 'server.js',
    note: 'Server-rendered Next.js (standalone output). Needs a host that runs Node.',
    files: (title, rtl) => ({
      'package.json': json({ name: slug(title), private: true, version: '0.0.0', scripts: { dev: 'next dev', build: 'next build', start: 'node .next/standalone/server.js' }, dependencies: { next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0' } }),
      'next.config.mjs': `import { dirname } from 'node:path';\nimport { fileURLToPath } from 'node:url';\n\n// Trace files from this folder, not from a lock file somewhere above it, so the standalone output is not nested.\n/** @type {import('next').NextConfig} */\nconst config = { output: 'standalone', outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)) };\n\nexport default config;\n`,
      'app/layout.jsx': `import './globals.css';\n\nexport const metadata = { title: ${JSON.stringify(title)} };\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="${rtl ? 'fa' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
      'app/page.jsx': `export const dynamic = 'force-dynamic';\n\nexport default function Page() {\n  return (\n    <main>\n      <h1>${esc(title)}</h1>\n      <p>${lead(rtl)}</p>\n      <p>Rendered on the server at {new Date().toISOString()}</p>\n    </main>\n  );\n}\n`,
      'app/api/health/route.js': `export const dynamic = 'force-dynamic';\n\nexport function GET() {\n  return Response.json({ ok: true });\n}\n`,
      'app/globals.css': css(rtl),
    }),
  },
};
