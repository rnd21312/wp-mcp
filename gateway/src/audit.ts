import { contrast, HEX, type Plan, type Tokens } from './sitekit.ts';

export interface Issue {
  level: 'error' | 'warn';
  page: string;
  rule: string;
  message: string;
}

export interface AuditReport {
  issues: Issue[];
  errors: number;
  warnings: number;
  pages: number;
  score: number;
  checked_at: number;
}

const tag = (html: string, name: string): string[] => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => m[0]);
const attr = (t: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(t);
  return m ? (m[2] ?? m[3] ?? '') : null;
};
const textOf = (html: string): string => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Checks the assembled site. Errors block publishing (the human cannot approve past them); warnings are shown.
 * `files` maps a path such as "about.html" to its content; `others` lists non-HTML files that exist (for link checks).
 */
export function auditSite(plan: Plan, tokens: Tokens, files: Record<string, string>, others: string[], now = Date.now()): AuditReport {
  const issues: Issue[] = [];
  const add = (level: Issue['level'], page: string, rule: string, message: string): void => void issues.push({ level, page, rule, message });
  const known = new Set([...Object.keys(files), ...others]);
  const titles = new Map<string, string>();
  const descriptions = new Map<string, string>();

  // palette contrast
  const p = tokens.palette;
  for (const [fg, bg, label, min] of [
    [p.text, p.background, 'text on background', 4.5],
    [p.text, p.surface, 'text on cards', 4.5],
    [p.muted, p.background, 'muted text on background', 4.5],
    [p.primary, p.background, 'links on background', 4.5],
  ] as const) {
    const ratio = contrast(fg, bg);
    if (ratio < min) add(label.startsWith('muted') || label.startsWith('links') ? 'warn' : 'error', '(design)', 'contrast', `Low contrast for ${label}: ${ratio.toFixed(1)}:1 (needs ${min}:1).`);
  }
  for (const c of Object.values(p)) if (!HEX.test(c)) add('error', '(design)', 'palette', `"${c}" is not a #rrggbb colour.`);

  for (const [path, html] of Object.entries(files)) {
    const name = path;
    const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
    const desc = tag(html, 'meta').map((m) => (attr(m, 'name') === 'description' ? attr(m, 'content') : null)).find((x) => x !== null && x !== undefined) ?? '';
    const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? '';

    if (!/<html[^>]*\slang=/i.test(html)) add('error', name, 'lang', 'The <html> tag has no lang attribute.');
    if (!/<html[^>]*\sdir=/i.test(html)) add('warn', name, 'dir', 'The <html> tag has no dir attribute.');
    if (!tag(html, 'meta').some((m) => attr(m, 'name') === 'viewport')) add('error', name, 'viewport', 'Missing viewport meta tag (the page will not be mobile friendly).');
    if (!title) add('error', name, 'title', 'The page has no title.');
    else {
      if (title.length > 65) add('warn', name, 'title-length', `The title is ${title.length} characters; search engines show about 60.`);
      if (title.length < 15) add('warn', name, 'title-length', `The title is only ${title.length} characters.`);
      if (titles.has(title)) add('warn', name, 'title-duplicate', `Same title as ${titles.get(title)}.`);
      titles.set(title, name);
    }
    if (!desc) add('warn', name, 'description', 'No meta description.');
    else {
      if (desc.length > 165) add('warn', name, 'description-length', `The description is ${desc.length} characters; about 160 are shown.`);
      if (descriptions.has(desc)) add('warn', name, 'description-duplicate', `Same description as ${descriptions.get(desc)}.`);
      descriptions.set(desc, name);
    }
    if (textOf(main).length < 60) add('error', name, 'empty', 'The page has almost no content.');

    const h1s = (main.match(/<h1\b/gi) ?? []).length;
    if (h1s === 0) add('error', name, 'h1', 'The page has no <h1> heading.');
    else if (h1s > 1) add('error', name, 'h1', `The page has ${h1s} <h1> headings; use exactly one.`);
    let last = 1;
    for (const m of main.matchAll(/<h([1-6])\b/gi)) {
      const level = Number(m[1]);
      if (level > last + 1) add('warn', name, 'heading-order', `Heading jumps from h${last} to h${level}.`);
      last = level;
    }

    for (const img of tag(main, 'img')) {
      const alt = attr(img, 'alt');
      if (alt === null) add('error', name, 'img-alt', `Image without alt text: ${attr(img, 'src') ?? '?'}`);
      else if (alt.trim() === '') add('warn', name, 'img-alt', `Empty alt text on ${attr(img, 'src') ?? 'an image'} (fine only for decoration).`);
      const src = attr(img, 'src') ?? '';
      if (/^images\/.+\.svg$/.test(src) && !known.has(src)) add('error', name, 'img-missing', `Image file not found: ${src}`);
      if (/^https?:/i.test(src)) add('warn', name, 'img-external', `External image: ${src}`);
    }

    for (const a of tag(html, 'a')) {
      const href = attr(a, 'href');
      if (href === null || href === '') {
        add('error', name, 'link-empty', 'A link has no destination.');
        continue;
      }
      if (/^(https?:|mailto:|tel:)/i.test(href)) continue;
      const [target, hash] = href.split('#');
      if (target && !known.has(target)) add('error', name, 'link-broken', `Link to a missing page: ${href}`);
      if (!target && hash && !new RegExp(`\\sid\\s*=\\s*["']${hash.replace(/[^\w-]/g, '')}["']`, 'i').test(html)) add('warn', name, 'anchor-missing', `Link to a missing section: #${hash}`);
    }
    const links = [...main.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => textOf(m[1]).toLowerCase());
    if (links.some((l) => ['click here', 'here', 'read more', 'اینجا', 'بیشتر'].includes(l))) add('warn', name, 'link-text', 'Some links say only "click here" / "read more"; describe where they go.');

    if (/<script[^>]+src\s*=\s*["']https?:/i.test(html)) add('warn', name, 'external-script', 'The page loads a script from another site.');
    if (/<form\b/i.test(main) && !/<label\b/i.test(main)) add('error', name, 'form-label', 'A form has no labels.');
    if (Buffer.byteLength(html) > 600_000) add('warn', name, 'size', 'The page is larger than 600 KB.');
    if (/images\/[\w-]+\.svg/.test(main)) add('warn', name, 'placeholder-image', 'The page still uses placeholder images; replace them with real pictures (same file names) before launch.');
  }

  for (const p2 of plan.pages) if (!files[p2.slug === 'index' ? 'index.html' : `${p2.slug}.html`]) add('error', p2.slug, 'missing-page', `The page "${p2.title}" has not been built.`);
  if (!known.has('style.css')) add('error', '(site)', 'css', 'style.css is missing.');

  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.length - errors;

  return { issues, errors, warnings, pages: Object.keys(files).length, score: Math.max(0, Math.round(100 - errors * 12 - warnings * 3)), checked_at: now };
}
