/** Client-side page analysis for the URL inspector. Pure: HTML in, report out. */

export interface Check {
  id: string;
  severity: 'high' | 'medium' | 'low' | 'ok';
  title: string;
  detail: string;
  fix?: string;
}

export interface Report {
  url: string;
  title: string;
  description: string;
  canonical: string;
  robots: string;
  lang: string;
  viewport: boolean;
  favicon: string;
  hreflang: { lang: string; href: string }[];
  og: Record<string, string>;
  twitter: Record<string, string>;
  headings: { level: number; text: string }[];
  images: { src: string; alt: string | null; width: string; height: string; lazy: boolean }[];
  links: { href: string; text: string; internal: boolean; nofollow: boolean }[];
  schema: { type: string; raw: any; problems: string[] }[];
  schemaErrors: number;
  words: number;
  sentences: number;
  text: string;
  keyword: { word: string; count: number; density: number; inTitle: boolean; inH1: boolean; inDescription: boolean; inUrl: boolean; inFirst100: boolean; inAlt: boolean } | null;
  checks: Check[];
  score: number;
}

export interface FetchInfo {
  status: number;
  ms: number;
  bytes: number;
  headers: Record<string, string>;
  chain: { url: string; status: number; location?: string }[];
}

const meta = (doc: Document, attr: string, name: string): string => doc.querySelector(`meta[${attr}="${name}"]`)?.getAttribute('content')?.trim() ?? '';

const REQUIRED: Record<string, string[]> = {
  Article: ['headline', 'author', 'datePublished'],
  BlogPosting: ['headline', 'author', 'datePublished'],
  NewsArticle: ['headline', 'author', 'datePublished'],
  Product: ['name', 'offers'],
  LocalBusiness: ['name', 'address'],
  Organization: ['name'],
  Person: ['name'],
  FAQPage: ['mainEntity'],
  BreadcrumbList: ['itemListElement'],
  WebSite: ['name', 'url'],
  Recipe: ['name', 'recipeIngredient'],
  Event: ['name', 'startDate', 'location'],
};

function flatten(node: any, out: any[] = []): any[] {
  if (Array.isArray(node)) node.forEach((n) => flatten(n, out));
  else if (node && typeof node === 'object') {
    if (node['@graph']) flatten(node['@graph'], out);
    else out.push(node);
  }

  return out;
}

export function analyze(html: string, url: string, info: FetchInfo, keyword = ''): Report {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const origin = (() => { try { return new URL(url).origin; } catch { return ''; } })();
  const abs = (href: string): string => { try { return new URL(href, url).href; } catch { return href; } };

  const title = doc.title.trim();
  const description = meta(doc, 'name', 'description');
  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '';
  const robots = [meta(doc, 'name', 'robots'), info.headers['x-robots-tag'] ?? ''].filter(Boolean).join(', ');
  const lang = doc.documentElement.getAttribute('lang') ?? '';
  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  doc.querySelectorAll('meta[property^="og:"]').forEach((m) => { og[m.getAttribute('property')!.slice(3)] = m.getAttribute('content') ?? ''; });
  doc.querySelectorAll('meta[name^="twitter:"]').forEach((m) => { twitter[m.getAttribute('name')!.slice(8)] = m.getAttribute('content') ?? ''; });

  const headings = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent ?? '').replace(/\s+/g, ' ').trim() }));
  const images = [...doc.querySelectorAll('img')].map((i) => ({ src: abs(i.getAttribute('src') ?? i.getAttribute('data-src') ?? ''), alt: i.getAttribute('alt'), width: i.getAttribute('width') ?? '', height: i.getAttribute('height') ?? '', lazy: i.getAttribute('loading') === 'lazy' }));
  const links = [...doc.querySelectorAll('a[href]')].map((a) => {
    const href = abs(a.getAttribute('href') ?? '');
    return { href, text: (a.textContent ?? '').replace(/\s+/g, ' ').trim() || a.getAttribute('aria-label') || a.querySelector('img')?.getAttribute('alt') || '', internal: href.startsWith(origin), nofollow: /nofollow/.test(a.getAttribute('rel') ?? '') };
  }).filter((l) => /^https?:/.test(l.href));

  const schema: Report['schema'] = [];
  let schemaErrors = 0;
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      for (const node of flatten(JSON.parse(s.textContent ?? ''))) {
        const type = String(Array.isArray(node['@type']) ? node['@type'][0] : node['@type'] ?? '?');
        schema.push({ type, raw: node, problems: (REQUIRED[type] ?? []).filter((k) => node[k] === undefined || node[k] === '').map((k) => `${k}`) });
      }
    } catch {
      schemaErrors++;
    }
  });

  doc.querySelectorAll('script,style,noscript,nav,header,footer').forEach((n) => n.remove());
  const text = (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const wordList = text.split(/[\s،؛:.!?؟()«»"'\-–—/]+/u).filter((w) => w.length > 0);
  const sentences = text.split(/[.!?؟]+\s/u).filter((s) => s.trim().length > 0).length;

  let kw: Report['keyword'] = null;
  const k = keyword.trim().toLowerCase();
  if (k) {
    const lower = text.toLowerCase();
    const count = lower.split(k).length - 1;
    const first = wordList.slice(0, 100).join(' ').toLowerCase();
    kw = {
      word: k,
      count,
      density: wordList.length ? (count * k.split(/\s+/).length * 100) / wordList.length : 0,
      inTitle: title.toLowerCase().includes(k),
      inH1: headings.some((h) => h.level === 1 && h.text.toLowerCase().includes(k)),
      inDescription: description.toLowerCase().includes(k),
      inUrl: decodeURIComponent(url).toLowerCase().includes(k.replace(/\s+/g, '-')) || decodeURIComponent(url).toLowerCase().includes(k),
      inFirst100: first.includes(k),
      inAlt: images.some((i) => (i.alt ?? '').toLowerCase().includes(k)),
    };
  }

  /* ----------------------------------------------------------- the checks */
  const checks: Check[] = [];
  const add = (c: Check): void => { checks.push(c); };
  const need = (cond: boolean, ok: Omit<Check, 'severity'>, bad: Check): void => (cond ? add({ ...ok, severity: 'ok' }) : add(bad));

  need(info.status === 200, { id: 'status', title: 'HTTP 200', detail: 'The page answers normally.' }, { id: 'status', severity: 'high', title: `HTTP ${info.status}`, detail: 'Search engines index only pages that answer 200.', fix: 'Fix the page or redirect it to a working one.' });
  if (info.chain.length > 2) add({ id: 'redirects', severity: 'medium', title: `${info.chain.length - 1} redirects before the page`, detail: info.chain.map((c) => `${c.status} ${c.url}`).join(' → '), fix: 'Link directly to the final address.' });
  need(url.startsWith('https:'), { id: 'https', title: 'HTTPS', detail: 'The page is served over a secure connection.' }, { id: 'https', severity: 'high', title: 'Not HTTPS', detail: 'Browsers warn and search engines prefer secure pages.', fix: 'Install a certificate and redirect http to https.' });
  need(!/noindex/i.test(robots), { id: 'noindex', title: 'Indexable', detail: robots ? `robots: ${robots}` : 'No noindex directive.' }, { id: 'noindex', severity: 'high', title: 'Blocked from search (noindex)', detail: robots, fix: 'Remove noindex if this page should appear in search results.' });

  if (!title) add({ id: 'title', severity: 'high', title: 'Missing title', detail: 'The <title> tag is empty.', fix: 'Write a unique title of 30-60 characters.' });
  else if (title.length < 25 || title.length > 65) add({ id: 'title', severity: 'medium', title: `Title is ${title.length} characters`, detail: title, fix: 'Aim for 30-60 so it is not cut in results.' });
  else add({ id: 'title', severity: 'ok', title: 'Title length is good', detail: `${title.length} characters` });

  if (!description) add({ id: 'desc', severity: 'high', title: 'Missing meta description', detail: 'Search engines will make up a snippet.', fix: 'Write 120-155 characters with a reason to click.' });
  else if (description.length < 70 || description.length > 165) add({ id: 'desc', severity: 'low', title: `Description is ${description.length} characters`, detail: description, fix: 'Aim for 120-155.' });
  else add({ id: 'desc', severity: 'ok', title: 'Description length is good', detail: `${description.length} characters` });

  const h1 = headings.filter((h) => h.level === 1).length;
  need(h1 === 1, { id: 'h1', title: 'One H1', detail: headings.find((h) => h.level === 1)?.text ?? '' }, { id: 'h1', severity: h1 === 0 ? 'high' : 'medium', title: h1 === 0 ? 'No H1' : `${h1} H1 headings`, detail: 'Each page needs one main heading.', fix: 'Keep exactly one H1 that names the topic.' });
  let skip = false;
  headings.reduce((last, h) => { if (last && h.level > last + 1) skip = true; return h.level; }, 0);
  if (skip) add({ id: 'order', severity: 'low', title: 'Heading levels skip', detail: 'For example H2 followed by H4.', fix: 'Do not skip levels.' });

  need(!!canonical, { id: 'canonical', title: 'Canonical link', detail: canonical }, { id: 'canonical', severity: 'medium', title: 'No canonical link', detail: 'Duplicates of this page are not consolidated.', fix: 'Add rel=canonical pointing to the preferred address.' });
  if (canonical && abs(canonical).replace(/\/$/, '') !== url.replace(/\/$/, '')) add({ id: 'canon-other', severity: 'medium', title: 'Canonical points elsewhere', detail: abs(canonical), fix: 'Make sure this is intended; otherwise this page will not be indexed.' });
  need(!!doc.querySelector('meta[name="viewport"]') || html.includes('name="viewport"'), { id: 'viewport', title: 'Mobile viewport', detail: 'Present.' }, { id: 'viewport', severity: 'high', title: 'No viewport meta', detail: 'The page is not mobile friendly.', fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.' });
  need(!!lang, { id: 'lang', title: `Language: ${lang}`, detail: '' }, { id: 'lang', severity: 'low', title: 'No lang attribute', detail: 'Helps screen readers and search engines.', fix: 'Set <html lang="fa">.' });

  const noAlt = images.filter((i) => i.alt === null || i.alt.trim() === '');
  need(noAlt.length === 0, { id: 'alt', title: 'All images have alt text', detail: `${images.length} images` }, { id: 'alt', severity: 'medium', title: `${noAlt.length} of ${images.length} images without alt`, detail: noAlt.slice(0, 3).map((i) => i.src).join('\n'), fix: 'Describe each meaningful image.' });
  const noSize = images.filter((i) => !i.width || !i.height);
  if (noSize.length > 2) add({ id: 'dims', severity: 'low', title: `${noSize.length} images without width/height`, detail: 'Causes layout shift while loading.', fix: 'Set width and height attributes.' });

  need(Object.keys(og).length >= 3, { id: 'og', title: 'Open Graph tags', detail: Object.keys(og).join(', ') }, { id: 'og', severity: 'low', title: 'Missing Open Graph tags', detail: 'Shared links look plain.', fix: 'Set og:title, og:description, og:image.' });
  need(schema.length > 0 && schemaErrors === 0, { id: 'schema', title: 'Structured data', detail: schema.map((s) => s.type).join(', ') }, { id: 'schema', severity: schemaErrors ? 'medium' : 'low', title: schemaErrors ? 'Invalid JSON-LD' : 'No structured data', detail: schemaErrors ? `${schemaErrors} block(s) do not parse` : 'Rich results need schema.org markup.', fix: 'Add JSON-LD (Article, LocalBusiness, Product, FAQ…).' });
  for (const s of schema.filter((x) => x.problems.length)) add({ id: `schema-${s.type}`, severity: 'medium', title: `${s.type} is missing ${s.problems.join(', ')}`, detail: 'Required or recommended properties are absent.', fix: 'Complete the structured data.' });

  need(wordList.length >= 250, { id: 'words', title: `${wordList.length} words`, detail: '' }, { id: 'words', severity: 'low', title: `Only ${wordList.length} words`, detail: 'Thin pages rank poorly unless the intent is brief.', fix: 'Add useful content.' });
  const avg = sentences ? wordList.length / sentences : 0;
  if (avg > 28) add({ id: 'read', severity: 'low', title: `Long sentences (about ${Math.round(avg)} words)`, detail: '', fix: 'Shorter sentences are easier to read.' });
  const internal = links.filter((l) => l.internal).length;
  need(internal > 0, { id: 'links', title: `${internal} internal links`, detail: '' }, { id: 'links', severity: 'low', title: 'No internal links', detail: 'Link related pages so crawlers and visitors find them.', fix: 'Add contextual links.' });
  const empty = links.filter((l) => !l.text).length;
  if (empty) add({ id: 'emptyanchor', severity: 'low', title: `${empty} links without text`, detail: '', fix: 'Give links descriptive text or aria-label.' });
  if (info.bytes > 1_500_000) add({ id: 'size', severity: 'medium', title: `HTML is ${(info.bytes / 1e6).toFixed(1)} MB`, detail: '', fix: 'Reduce inline CSS/JS and builder bloat.' });
  if (info.ms > 1500) add({ id: 'speed', severity: 'medium', title: `Slow response (${info.ms} ms)`, detail: 'Time to download the HTML from the gateway.', fix: 'Enable page caching, upgrade hosting or use a CDN.' });
  if (!info.headers['content-encoding']) add({ id: 'gzip', severity: 'low', title: 'No compression', detail: 'The HTML is sent uncompressed.', fix: 'Enable gzip or brotli.' });

  if (kw) {
    need(kw.inTitle, { id: 'kw-title', title: 'Keyword in title', detail: kw.word }, { id: 'kw-title', severity: 'medium', title: 'Keyword not in title', detail: kw.word, fix: 'Put the focus keyword near the start of the title.' });
    need(kw.inH1, { id: 'kw-h1', title: 'Keyword in H1', detail: '' }, { id: 'kw-h1', severity: 'medium', title: 'Keyword not in H1', detail: '', fix: 'Use it in the main heading.' });
    need(kw.inDescription, { id: 'kw-desc', title: 'Keyword in description', detail: '' }, { id: 'kw-desc', severity: 'low', title: 'Keyword not in description', detail: '', fix: 'Mention it naturally.' });
    need(kw.inFirst100, { id: 'kw-first', title: 'Keyword in the first 100 words', detail: '' }, { id: 'kw-first', severity: 'low', title: 'Keyword not in the first 100 words', detail: '', fix: 'Introduce it early.' });
    if (kw.density > 3) add({ id: 'kw-dens', severity: 'medium', title: `Keyword density ${kw.density.toFixed(1)}% is high`, detail: '', fix: 'Aim for 0.5-2.5%; avoid stuffing.' });
    else if (kw.count === 0) add({ id: 'kw-none', severity: 'high', title: 'Keyword never appears in the text', detail: '', fix: 'Write about it.' });
  }

  const penalty = { high: 14, medium: 7, low: 3, ok: 0 };
  const score = Math.max(0, 100 - checks.reduce((n, c) => n + penalty[c.severity], 0));

  return { url, title, description, canonical, robots, lang, viewport: true, favicon: doc.querySelector('link[rel~="icon"]')?.getAttribute('href') ?? '', hreflang: [...doc.querySelectorAll('link[rel="alternate"][hreflang]')].map((l) => ({ lang: l.getAttribute('hreflang')!, href: l.getAttribute('href') ?? '' })), og, twitter, headings, images, links, schema, schemaErrors, words: wordList.length, sentences, text, keyword: kw, checks, score };
}
