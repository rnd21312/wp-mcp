import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentClient } from '../src/agentclient.ts';
import { auditSite } from '../src/audit.ts';
import { approve, loadState, pageMain, preview, publish, runStage, startBuilder, stateView } from '../src/builder.ts';
import { encrypt } from '../src/crypto.ts';
import { extractJson, llm } from '../src/llm.ts';
import { projectDir } from '../src/projects.ts';
import { assemblePage, buildCss, checkMain, contrast, type Plan, type Tokens } from '../src/sitekit.ts';
import { createEnv, type Env } from './helpers.ts';

const PLAN = {
  site_name: 'Nur Bakery',
  tagline: 'Fresh bread every morning',
  language: 'en',
  rtl: false,
  tone: 'warm',
  audience: 'neighbours',
  footer_note: '© Nur Bakery',
  pages: [
    { slug: 'index', title: 'Home', purpose: 'Introduce the bakery and invite people in', sections: ['Hero', 'Why us'], seo_title: 'Nur Bakery - fresh bread daily', seo_description: 'Nur Bakery bakes fresh bread, pastries and cakes every morning in the heart of the neighbourhood.' },
    { slug: 'menu', title: 'Menu', purpose: 'Show what is baked', sections: ['Breads', 'Pastries'], seo_title: 'Menu - Nur Bakery bread and pastries', seo_description: 'See the breads, pastries and cakes baked fresh at Nur Bakery, with seasonal specials every month.' },
    { slug: 'contact', title: 'Contact', purpose: 'How to reach us', sections: ['Address and hours', 'Message form'], seo_title: 'Contact Nur Bakery - visit or call us', seo_description: 'Find Nur Bakery, see the opening hours and send us a message about orders and events.' },
  ],
};

const GOOD_TOKENS = { palette: { primary: '#9a3412', secondary: '#78350f', accent: '#f59e0b', background: '#fffbeb', surface: '#ffffff', text: '#1c1917', muted: '#57534e' }, fonts: { heading: 'serif', body: 'system' }, radius: 10, maxWidth: 1080, rationale: 'warm bakery tones' };
const BAD_TOKENS = { ...GOOD_TOKENS, palette: { ...GOOD_TOKENS.palette, text: '#cccccc' } };

const mainFor = (slug: string): string =>
  `<section class="hero"><div class="container"><h1>Page ${slug}</h1><p class="lead">Fresh and honest baking for our neighbourhood, every single morning of the week.</p><a class="btn" href="contact.html">Contact us</a></div></section>
<section class="section alt"><div class="container"><h2>Why choose us</h2><figure class="img"><img src="images/${slug}-1.svg" alt="Loaves cooling on a wooden rack" data-image-prompt="warm photo of loaves on a rack" width="1200" height="675"></figure><p>We use slow fermentation and local flour. See the <a href="menu.html">full menu</a> for details and seasonal specials.</p></div></section>`;

describe('builder pipeline (scripted AI)', () => {
  let env: Env;
  let planCalls = 0;
  let designCalls = 0;
  let pageCalls = 0;
  let pageMode: 'good' | 'script' | 'no-h1' = 'good';
  let seenPrompts: string[] = [];
  const realComplete = llm.complete;

  beforeAll(async () => {
    env = await createEnv([], { dataDir: mkdtempSync(join(tmpdir(), 'wpm-bld-')) }, { owner: false });
    env.app.store.addAiProvider({ id: 'p1', name: 'test', preset: 'custom', type: 'openai', base_url: 'http://x', model: 'm', key_enc: '' });
    llm.complete = async (_app, _provider, system, user) => {
      seenPrompts.push(user);
      if (system.includes('information architect')) {
        planCalls++;
        return '```json\n' + JSON.stringify(PLAN) + '\n```';
      }
      if (system.includes('brand and UI designer')) {
        designCalls++;
        return JSON.stringify(user.includes('was rejected') ? GOOD_TOKENS : designCalls === 1 ? BAD_TOKENS : GOOD_TOKENS);
      }
      pageCalls++;
      const slug = /Page to write: .*\((\w+)\.html\)/.exec(user)![1];
      if (pageMode === 'script' || (pageMode === 'no-h1' && !user.includes('was rejected'))) return pageMode === 'script' ? `<section class="section"><div class="container"><h1>x</h1><script>alert(1)</script></div></section>` : '<section class="section"><div class="container"><h2>No heading one here</h2><p>' + 'text '.repeat(20) + '</p></div></section>';
      return mainFor(slug);
    };
    env.app.agents = {
      call: async (_h: unknown, op: string, args: Record<string, unknown>) => (op === 'sites.create' ? { site: { id: args.name } } : {}),
      deploy: async () => ({ id: 'rel1', previous: null, mode: 'sync', created: 0, files: 0, bytes: 0, sha256: '', note: '', by: '' }),
    } as unknown as AgentClient;
    env.app.store.addHost({ name: 'h', url: 'https://h.test/wpm-agent/', key_id: 'k', secret_enc: encrypt(env.config.masterKey, 'x'), level: 'admin' });
    env.app.store.hostHealth('h', true);
  });
  afterAll(async () => {
    llm.complete = realComplete;
    await env.stop();
  });
  beforeEach(() => {
    pageMode = 'good';
  });

  const start = (name: string, extra = {}) => startBuilder(env.app, { name, brief: 'A neighbourhood bakery that sells bread, pastries and cakes. Visitors should find the menu and our address.', provider: 'p1', baseUrl: 'https://nur.example.com', ...extra });

  it('validates the start', () => {
    expect(() => startBuilder(env.app, { name: 'x1', brief: 'short', provider: 'p1' })).toThrow(/few sentences/);
    expect(() => start('nope', { provider: 'missing' })).toThrow(/provider/);
    expect(() => start('badurl', { baseUrl: 'javascript:alert(1)' })).toThrow(/https/);
  });

  it('runs end to end and refuses every shortcut', async () => {
    start('bakery');
    // order is enforced
    await expect(runStage(env.app, 'bakery', { stage: 'design' })).rejects.toMatchObject({ code: 'not_approved' });
    await expect(runStage(env.app, 'bakery', { stage: 'pages' })).rejects.toMatchObject({ code: 'not_approved' });
    expect(() => approve(env.app, 'bakery', { stage: 'plan' })).toThrow(/nothing waiting/);
    await expect(publish(env.app, 'bakery', { host: 'h' })).rejects.toMatchObject({ code: 'not_approved' });

    // plan: model answer wrapped in a fence is understood; a hand edit is validated
    const planned = await runStage(env.app, 'bakery', { stage: 'plan' });
    expect(planned.stages.plan).toBe('review');
    expect(planned.plan!.pages.map((p) => p.slug)).toEqual(['index', 'menu', 'contact']);
    expect(() => approve(env.app, 'bakery', { stage: 'plan', edit: { ...PLAN, pages: [{ ...PLAN.pages[1] }] } })).toThrow(/index/);
    approve(env.app, 'bakery', { stage: 'plan' });

    // design: the first answer fails the contrast rule, the retry succeeds, the CSS comes from the tokens
    await runStage(env.app, 'bakery', { stage: 'design' });
    expect(designCalls).toBe(2);
    expect(seenPrompts.at(-1)).toMatch(/contrast/);
    expect(readFileSync(join(projectDir(env.app, 'bakery'), 'style.css'), 'utf8')).toContain('--primary:#9a3412');
    approve(env.app, 'bakery', { stage: 'design' });

    // pages: all generated, shell added by code
    await runStage(env.app, 'bakery', { stage: 'pages' });
    expect(pageCalls).toBe(3);
    const dir = projectDir(env.app, 'bakery');
    const index = readFileSync(join(dir, 'index.html'), 'utf8');
    expect(index).toContain('<html lang="en" dir="ltr">');
    expect(index).toContain('<title>Nur Bakery - fresh bread daily</title>');
    expect(index).toContain('name="description"');
    expect(index).toContain('<a href="index.html" aria-current="page">Home</a>');
    expect(index).toContain('<main id="main">');
    expect(index).not.toContain('og:url'); // SEO step not done yet
    expect(stateView(env.app, 'bakery').stages.pages).toBe('review');
    await expect(runStage(env.app, 'bakery', { stage: 'images' })).rejects.toMatchObject({ code: 'not_approved' });
    expect(() => approve(env.app, 'bakery', { stage: 'pages' })).toThrow(/one at a time/);
    for (const slug of ['index', 'menu', 'contact']) approve(env.app, 'bakery', { stage: 'pages', slug });
    expect(stateView(env.app, 'bakery').stages.pages).toBe('approved');

    // images, seo, audit
    await runStage(env.app, 'bakery', { stage: 'images' });
    expect(existsSync(join(dir, 'images', 'menu-1.svg'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'images.json'), 'utf8'))).toHaveLength(3);
    approve(env.app, 'bakery', { stage: 'images' });
    await runStage(env.app, 'bakery', { stage: 'seo' });
    expect(readFileSync(join(dir, 'sitemap.xml'), 'utf8')).toContain('<loc>https://nur.example.com/menu.html</loc>');
    expect(readFileSync(join(dir, 'robots.txt'), 'utf8')).toContain('Sitemap: https://nur.example.com/sitemap.xml');
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('<link rel="canonical" href="https://nur.example.com/">');
    approve(env.app, 'bakery', { stage: 'seo' });
    await expect(publish(env.app, 'bakery', { host: 'h' })).rejects.toMatchObject({ code: 'not_approved' }); // audit not approved
    const audited = await runStage(env.app, 'bakery', { stage: 'audit' });
    expect(audited.audit!.errors).toBe(0);
    expect(audited.audit!.issues.some((i) => i.rule === 'placeholder-image')).toBe(true);
    approve(env.app, 'bakery', { stage: 'audit' });

    // publish only now
    const done = await publish(env.app, 'bakery', { host: 'h', folder: 'bakery' });
    expect(done.release.id).toBe('rel1');
    expect(env.app.store.project('bakery')!.last_release).toBe('rel1');

    // sending the builder's private folder to the host is never part of the zip
    expect(existsSync(join(dir, '.wpm-builder', 'state.json'))).toBe(true);
  }, 60000);

  it('re-running an earlier step sends the later ones back to review', async () => {
    const before = loadState(env.app, 'bakery');
    expect(before.stages.audit).toBe('approved');
    await runStage(env.app, 'bakery', { stage: 'design', feedback: 'warmer please' });
    const after = loadState(env.app, 'bakery');
    expect(after.stages.design).toBe('review');
    expect(after.stages.images).toBe('pending');
    expect(after.stages.audit).toBe('pending');
    expect(seenPrompts.at(-1)).toContain('warmer please');
    await expect(publish(env.app, 'bakery', { host: 'h' })).rejects.toMatchObject({ code: 'not_approved' });
  }, 30000);

  it('feedback regenerates one page and sends the stage back to review', async () => {
    const s = loadState(env.app, 'bakery');
    approve(env.app, 'bakery', { stage: 'design' });
    const calls = pageCalls;
    await runStage(env.app, 'bakery', { stage: 'pages', slug: 'menu', feedback: 'add a section about gluten-free options' });
    expect(pageCalls).toBe(calls + 1);
    expect(seenPrompts.at(-1)).toContain('gluten-free');
    expect(seenPrompts.at(-1)).toContain('Current version (revise it)');
    const st = loadState(env.app, 'bakery');
    expect(st.pages.menu.status).toBe('review');
    expect(st.pages.menu.revision).toBe(s.pages.menu.revision + 1);
    expect(st.pages.index.status).toBe('approved');
    expect(st.stages.pages).toBe('review');
  }, 30000);

  it('rejects unusable page answers after one retry and writes nothing', async () => {
    start('scripty');
    await runStage(env.app, 'scripty', { stage: 'plan' });
    approve(env.app, 'scripty', { stage: 'plan' });
    await runStage(env.app, 'scripty', { stage: 'design' });
    approve(env.app, 'scripty', { stage: 'design' });
    pageMode = 'script';
    const calls = pageCalls;
    await expect(runStage(env.app, 'scripty', { stage: 'pages', slug: 'index' })).rejects.toMatchObject({ code: 'bad_answer' });
    expect(pageCalls).toBe(calls + 2);
    expect(existsSync(join(projectDir(env.app, 'scripty'), 'index.html'))).toBe(false);
    pageMode = 'no-h1'; // wrong the first time, fixed after the model is told why
    const before = pageCalls;
    await runStage(env.app, 'scripty', { stage: 'pages', slug: 'index' });
    expect(pageCalls).toBe(before + 2);
    expect(seenPrompts.at(-1)).toMatch(/exactly one <h1>/);
    // a person's edit goes through the same checks
    pageMode = 'good';
    await runStage(env.app, 'scripty', { stage: 'pages', slug: 'index' });
    expect(() => approve(env.app, 'scripty', { stage: 'pages', slug: 'index', edit: '<h1>x</h1><p>' + 'a'.repeat(60) + '</p><img src="http://evil.test/p.png" alt="x">' })).toThrow(/images\//);
    expect(() => approve(env.app, 'scripty', { stage: 'pages', slug: 'index', edit: '<h1>x</h1><p onclick="x()">' + 'a'.repeat(60) + '</p>' })).toThrow(/event handlers/);
    expect(pageMain(env.app, 'scripty', 'index')).toContain('Page index');
  }, 30000);

  it('previews a page without any outside request', async () => {
    const html = preview(env.app, 'bakery', 'index');
    expect(html).toContain('<style>');
    expect(html).not.toContain('href="style.css"');
    expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).toContain('data-page="menu.html"');
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/);
  });
});

describe('site kit', () => {
  const plan = PLAN as unknown as Plan;
  const tokens = GOOD_TOKENS as unknown as Tokens;

  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#777777', '#ffffff')).toBeLessThan(4.6);
    expect(contrast('#767676', '#ffffff')).toBeGreaterThan(4.5);
  });

  it('escapes names and descriptions in the shell', () => {
    const evil = { ...plan, site_name: '<script>alert(1)</script>', pages: [{ ...plan.pages[0], seo_title: 'a"><img src=x onerror=alert(1)>', seo_description: "x' onmouseover='y" }, ...plan.pages.slice(1)] };
    const html = assemblePage({ plan: evil, page: evil.pages[0], main: '<h1>x</h1>' });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('uses RTL and Persian labels for Persian sites', () => {
    const fa = { ...plan, language: 'fa', rtl: true };
    const html = assemblePage({ plan: fa, page: fa.pages[0], main: '<h1>x</h1>' });
    expect(html).toContain('<html lang="fa" dir="rtl">');
    expect(html).toContain('پرش به محتوا');
    expect(buildCss(tokens)).toContain('inset-inline-start');
  });

  it('refuses markup the shell must own', () => {
    for (const bad of ['<script>x</script>' + 'a'.repeat(50), '<iframe src="x"></iframe>' + 'a'.repeat(50), '<p onclick="x()">' + 'a'.repeat(50), '<a href="javascript:x()">' + 'a'.repeat(50), '<body>' + 'a'.repeat(50), '<form action="https://evil.test/">' + 'a'.repeat(50)]) expect(() => checkMain(bad), bad).toThrow();
    expect(() => checkMain('<h1>ok</h1><p>' + 'a'.repeat(60) + '</p>')).not.toThrow();
  });

  it('extracts JSON from chatty answers', () => {
    expect(extractJson('Sure! Here you go:\n```json\n{"a":1}\n```\nEnjoy')).toEqual({ a: 1 });
    expect(extractJson('{"a":{"b":2}} trailing')).toEqual({ a: { b: 2 } });
    expect(() => extractJson('no json here')).toThrow(/valid JSON/);
  });
});

describe('audit', () => {
  const plan = PLAN as unknown as Plan;
  const tokens = GOOD_TOKENS as unknown as Tokens;
  const page = (extra: string, head = '<title>A reasonable page title</title><meta name="description" content="A description that is long enough to be useful to searchers, saying what the page is.">'): string =>
    `<!doctype html><html lang="en" dir="ltr"><head><meta name="viewport" content="width=device-width">${head}</head><body><main><h1>Hi</h1><p>${'content '.repeat(15)}</p>${extra}</main></body></html>`;

  it('finds the problems that matter', () => {
    const files = {
      'index.html': page('<img src="images/index-1.svg" alt="ok"><a href="gone.html">x</a><a href="menu.html">click here</a><a href="#nowhere">y</a><h4>skip</h4>'),
      'menu.html': page('<h1>second</h1><img src="p.png"><form><input></form>', '<title>x</title>'),
      'contact.html': '<html><body><main><p>short</p></main></body></html>',
    };
    const r = auditSite(plan, tokens, files, ['style.css']);
    const has = (rule: string, level?: string) => r.issues.some((i) => i.rule === rule && (!level || i.level === level));
    expect(has('link-broken', 'error')).toBe(true);
    expect(has('img-missing', 'error')).toBe(true);
    expect(has('h1', 'error')).toBe(true);
    expect(has('img-alt', 'error')).toBe(true);
    expect(has('form-label', 'error')).toBe(true);
    expect(has('lang', 'error')).toBe(true);
    expect(has('viewport', 'error')).toBe(true);
    expect(has('title', 'error')).toBe(true);
    expect(has('empty', 'error')).toBe(true);
    expect(has('link-text', 'warn')).toBe(true);
    expect(has('anchor-missing', 'warn')).toBe(true);
    expect(has('heading-order', 'warn')).toBe(true);
    expect(r.errors).toBeGreaterThan(5);
    expect(r.score).toBeLessThan(50);
  });

  it('flags a low-contrast design as an error', () => {
    const r = auditSite(plan, BAD_TOKENS as unknown as Tokens, { 'index.html': page(''), 'menu.html': page(''), 'contact.html': page('') }, ['style.css']);
    expect(r.issues.some((i) => i.rule === 'contrast' && i.level === 'error')).toBe(true);
  });

  it('passes a clean site', () => {
    const files = Object.fromEntries(plan.pages.map((p) => [p.slug === 'index' ? 'index.html' : `${p.slug}.html`, page('<a href="index.html">Home page</a>', `<title>${p.seo_title}</title><meta name="description" content="${p.seo_description}">`)]));
    const r = auditSite(plan, tokens, files, ['style.css']);
    expect(r.errors).toBe(0);
  });
});
