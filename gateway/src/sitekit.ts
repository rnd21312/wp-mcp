/**
 * Deterministic parts of a generated site: design tokens → CSS, the page shell (head, SEO, navigation, footer), image
 * placeholders, sitemap. The AI only writes the content of <main>; everything that must be consistent, accessible and
 * well-formed is produced here.
 */

export interface Tokens {
  palette: { primary: string; secondary: string; accent: string; background: string; surface: string; text: string; muted: string };
  fonts: { heading: string; body: string };
  radius: number;
  maxWidth: number;
}

export interface PageSpec {
  slug: string;
  title: string;
  purpose: string;
  sections: string[];
  seo_title: string;
  seo_description: string;
}

export interface Plan {
  site_name: string;
  tagline: string;
  language: string;
  rtl: boolean;
  tone: string;
  audience: string;
  pages: PageSpec[];
  footer_note: string;
}

export const HEX = /^#[0-9a-fA-F]{6}$/;
const FONT_STACKS: Record<string, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  'system-fa': 'Vazirmatn, Tahoma, "Segoe UI", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Consolas, monospace',
};
export const FONT_CHOICES = Object.keys(FONT_STACKS);

export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---- colour maths (WCAG 2.x) -------------------------------------------------------------------------------------

const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Text colour (white or near-black) that reads best on `bg`. */
export const onColor = (bg: string): string => (contrast('#ffffff', bg) >= contrast('#111827', bg) ? '#ffffff' : '#111827');

// ---- CSS ----------------------------------------------------------------------------------------------------------

export function buildCss(t: Tokens): string {
  const p = t.palette;
  const head = FONT_STACKS[t.fonts.heading] ?? FONT_STACKS.system;
  const body = FONT_STACKS[t.fonts.body] ?? FONT_STACKS.system;

  return `/* Generated from the design tokens in the AI builder. Edit the tokens there, or this file by hand. */
:root{--primary:${p.primary};--on-primary:${onColor(p.primary)};--secondary:${p.secondary};--on-secondary:${onColor(p.secondary)};--accent:${p.accent};--bg:${p.background};--surface:${p.surface};--text:${p.text};--muted:${p.muted};--radius:${t.radius}px;--max:${t.maxWidth}px;--font-body:${body};--font-head:${head}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:1rem/1.75 var(--font-body)}
h1,h2,h3,h4{font-family:var(--font-head);line-height:1.25;margin:0 0 .6em}
h1{font-size:clamp(2rem,5vw,3.25rem)}h2{font-size:clamp(1.5rem,3.5vw,2.25rem)}h3{font-size:1.25rem}
p{margin:0 0 1em}a{color:var(--primary)}img{max-width:100%;height:auto;display:block}
.container{width:min(100% - 2rem,var(--max));margin-inline:auto}
.skip{position:absolute;inset-inline-start:-999px}.skip:focus{inset-inline-start:1rem;top:1rem;background:var(--surface);padding:.5rem 1rem;z-index:10}
header.site{background:var(--surface);border-bottom:1px solid color-mix(in srgb,var(--text) 12%,transparent)}
header.site .container{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-block:.9rem;flex-wrap:wrap}
.brand{font-family:var(--font-head);font-weight:700;font-size:1.25rem;text-decoration:none;color:var(--text)}
nav.site ul{display:flex;gap:.25rem 1.25rem;list-style:none;margin:0;padding:0;flex-wrap:wrap}
nav.site a{display:inline-block;padding:.5rem .25rem;text-decoration:none;color:var(--text)}
nav.site a[aria-current=page]{color:var(--primary);font-weight:600;border-bottom:2px solid var(--primary)}
main{display:block}
.section{padding-block:clamp(2.5rem,7vw,5rem)}
.section.alt{background:var(--surface)}
.hero{padding-block:clamp(3rem,10vw,7rem);background:linear-gradient(135deg,color-mix(in srgb,var(--primary) 14%,var(--bg)),var(--bg))}
.hero .lead{font-size:1.25rem;color:var(--muted);max-width:42rem}
.lead{font-size:1.15rem;color:var(--muted)}
.grid{display:grid;gap:1.5rem;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))}
.card{background:var(--surface);border:1px solid color-mix(in srgb,var(--text) 12%,transparent);border-radius:var(--radius);padding:1.5rem}
.card h3{margin-top:0}
.btn{display:inline-block;padding:.75rem 1.4rem;border-radius:var(--radius);background:var(--primary);color:var(--on-primary);text-decoration:none;font-weight:600;border:2px solid var(--primary)}
.btn:hover,.btn:focus-visible{filter:brightness(1.08)}
.btn.secondary{background:transparent;color:var(--primary)}
.cta{text-align:center}
figure.img{margin:0}figure.img img{border-radius:var(--radius);width:100%}
figcaption{color:var(--muted);font-size:.9rem;margin-top:.4rem}
form{display:grid;gap:1rem;max-width:34rem}label{font-weight:600;display:block;margin-bottom:.25rem}
input,textarea,select{width:100%;padding:.7rem .8rem;border:1px solid color-mix(in srgb,var(--text) 35%,transparent);border-radius:var(--radius);font:inherit;background:var(--bg);color:var(--text)}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
footer.site{background:var(--surface);border-top:1px solid color-mix(in srgb,var(--text) 12%,transparent);padding-block:2rem;color:var(--muted);font-size:.95rem}
table{border-collapse:collapse;width:100%}th,td{padding:.6rem;border-bottom:1px solid color-mix(in srgb,var(--text) 15%,transparent);text-align:start}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
}

/** Classes the page generator is told about, so its markup matches the stylesheet. */
export const CSS_CLASSES = '.container, .section, .section.alt, .hero (with .lead), .grid (auto-fit columns), .card, .btn, .btn.secondary, .cta, figure.img + figcaption, form/label/input/textarea (styled), table';

// ---- shell --------------------------------------------------------------------------------------------------------

export interface ShellInput {
  plan: Plan;
  page: PageSpec;
  main: string;
  /** Public address without trailing slash, when known. */
  baseUrl?: string;
}

const fileOf = (slug: string): string => (slug === 'index' ? 'index.html' : `${slug}.html`);
export const pageFile = fileOf;

export function assemblePage({ plan, page, main, baseUrl }: ShellInput): string {
  const dir = plan.rtl ? 'rtl' : 'ltr';
  const url = baseUrl ? `${baseUrl}/${page.slug === 'index' ? '' : fileOf(page.slug)}` : '';
  const title = page.slug === 'index' ? page.seo_title : `${page.seo_title}`;
  const nav = plan.pages.map((p) => `<li><a href="${fileOf(p.slug)}"${p.slug === page.slug ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`).join('');
  const ld =
    page.slug === 'index'
      ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebSite', name: plan.site_name, description: plan.tagline, inLanguage: plan.language, ...(baseUrl ? { url: baseUrl + '/' } : {}) }).replace(/</g, '\\u003c')}</script>\n`
      : '';

  return `<!doctype html>
<html lang="${esc(plan.language)}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(page.seo_description)}">
${url ? `<link rel="canonical" href="${esc(url)}">\n` : ''}<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(page.seo_description)}">
<meta property="og:site_name" content="${esc(plan.site_name)}">
${url ? `<meta property="og:url" content="${esc(url)}">\n` : ''}<meta name="twitter:card" content="summary">
<link rel="stylesheet" href="style.css">
${ld}</head>
<body>
<a class="skip" href="#main">${plan.language.startsWith('fa') ? 'پرش به محتوا' : 'Skip to content'}</a>
<header class="site"><div class="container"><a class="brand" href="index.html">${esc(plan.site_name)}</a><nav class="site" aria-label="${plan.language.startsWith('fa') ? 'منوی اصلی' : 'Main'}"><ul>${nav}</ul></nav></div></header>
<main id="main">
${main}
</main>
<footer class="site"><div class="container"><p>${esc(plan.footer_note)}</p></div></footer>
</body>
</html>
`;
}

export function sitemapXml(plan: Plan, baseUrl: string): string {
  const urls = plan.pages.map((p) => `  <url><loc>${esc(baseUrl)}/${p.slug === 'index' ? '' : fileOf(p.slug)}</loc></url>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export const robotsTxt = (baseUrl?: string): string => `User-agent: *\nAllow: /\n${baseUrl ? `Sitemap: ${baseUrl}/sitemap.xml\n` : ''}`;

/** A neutral SVG standing in for a picture, drawn from the palette. The prompt and alt text stay in images.json. */
export function placeholderSvg(label: string, t: Tokens, w = 1200, h = 675): string {
  const p = t.palette;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${p.primary}"/><stop offset="1" stop-color="${p.secondary}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.78}" cy="${h * 0.3}" r="${h * 0.12}" fill="${p.accent}" opacity=".85"/><path d="M0 ${h} L${w * 0.35} ${h * 0.55} L${w * 0.55} ${h * 0.8} L${w * 0.75} ${h * 0.6} L${w} ${h} Z" fill="${onColor(p.primary)}" opacity=".22"/></svg>\n`;
}

// ---- main-content validation --------------------------------------------------------------------------------------

/** Rejects markup the shell must own or that could run code. Returns the cleaned fragment or throws a readable message. */
export function checkMain(html: string): string {
  const body = html.trim();
  if (body.length < 40) throw new Error('the page content is empty');
  if (body.length > 120_000) throw new Error('the page content is too large');
  if (/<\s*(html|head|body|title|meta|link|script|iframe|object|embed|style|base|form[^>]*action\s*=\s*["']?https?:)/i.test(body)) throw new Error('use only content markup: no <html>, <head>, <body>, <script>, <style>, <iframe>, <link>, <meta>, or forms posting to other sites');
  if (/\son[a-z]+\s*=/i.test(body)) throw new Error('no inline event handlers (onclick=...)');
  if (/javascript:/i.test(body)) throw new Error('no javascript: links');
  return body;
}
