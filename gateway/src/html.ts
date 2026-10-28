export const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#15181d;--muted:#5d6672;--card:#fff;--line:#d9dde3;--accent:#2457d6;--danger:#b3261e;--ok:#17703a}
@media(prefers-color-scheme:dark){:root{--bg:#121417;--fg:#e8eaed;--muted:#9aa3ad;--card:#1b1e23;--line:#2c3138;--accent:#7aa2ff;--danger:#ff8a80;--ok:#6fd699}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.1rem;margin:28px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px}
input,select,button{font:inherit}input[type=text],input[type=password],input[type=url],input[type=number],select{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
button{padding:8px 14px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}button.secondary{background:transparent;color:var(--accent)}button.danger{background:var(--danger);border-color:var(--danger)}
label{display:block;margin:10px 0 4px;font-weight:600}.muted{color:var(--muted)}.ok{color:var(--ok)}.bad{color:var(--danger)}code,.mono{font-family:ui-monospace,Consolas,monospace;font-size:13px}
.domain{font-size:1.5rem;font-weight:700;word-break:break-all;padding:10px 12px;border:2px solid var(--accent);border-radius:8px;margin:8px 0}
.warn{border-left:4px solid var(--danger);padding:6px 10px;background:color-mix(in srgb,var(--danger) 10%,transparent);margin:10px 0}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.radio{display:block;font-weight:400;margin:6px 0}nav a{margin-right:14px}
`;

export function page(title: string, body: string, nav = '', lang = 'en'): string {
  return `<!doctype html><html lang="${lang}" dir="${lang === 'fa' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${nav}${body}</main></body></html>`;
}

export const securityHeaders = (): Record<string, string> => ({
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:* cursor: vscode: vscode-insiders:; frame-ancestors 'none'; base-uri 'none'",
});
