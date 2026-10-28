import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { auditSite, type AuditReport } from './audit.ts';
import type { App } from './context.ts';
import { askJson, LlmError, llm, stripFences } from './llm.ts';
import { createProject, deployProject, projectDir, ProjectError, removeProject, type DeployInput } from './projects.ts';
import { assemblePage, buildCss, checkMain, contrast, CSS_CLASSES, esc, FONT_CHOICES, HEX, pageFile, placeholderSvg, robotsTxt, sitemapXml, type Plan, type Tokens } from './sitekit.ts';

/**
 * The AI site builder: brief → sitemap → design system → pages → images → SEO → audit → publish.
 * Every stage ends in "review" and only moves on when the person approves it; the server enforces the order, so neither the
 * model nor a script can publish something nobody looked at. The model writes content; structure, SEO tags, navigation,
 * styles and checks come from code (sitekit.ts, audit.ts).
 */

export const STAGES = ['plan', 'design', 'pages', 'images', 'seo', 'audit'] as const;
export type Stage = (typeof STAGES)[number];
export type StageStatus = 'pending' | 'review' | 'approved';
export type PageStatus = 'pending' | 'review' | 'approved';

export interface BuilderState {
  version: 1;
  project: string;
  provider: string;
  brief: { text: string; language: string; tone: string; pages_hint: string; base_url: string };
  stages: Record<Stage, StageStatus>;
  plan?: Plan;
  tokens?: Tokens;
  pages: Record<string, { status: PageStatus; revision: number; feedback: string }>;
  images?: { file: string; page: string; alt: string; prompt: string }[];
  audit?: AuditReport;
  updated: number;
}

export class BuilderError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const DIR = '.wpm-builder';
const busy = new Set<string>();

const stateFile = (app: App, project: string): string => join(projectDir(app, project), DIR, 'state.json');
const mainFile = (app: App, project: string, slug: string): string => join(projectDir(app, project), DIR, 'pages', `${slug}.main.html`);

export function loadState(app: App, project: string): BuilderState {
  try {
    return JSON.parse(readFileSync(stateFile(app, project), 'utf8')) as BuilderState;
  } catch {
    throw new BuilderError('no_builder', `"${project}" was not made with the AI builder.`);
  }
}

function save(app: App, s: BuilderState): void {
  s.updated = Date.now();
  mkdirSync(dirname(stateFile(app, s.project)), { recursive: true });
  writeFileSync(stateFile(app, s.project), JSON.stringify(s, null, 2));
}

const readMain = (app: App, project: string, slug: string): string | null => {
  try {
    return readFileSync(mainFile(app, project, slug), 'utf8');
  } catch {
    return null;
  }
};

// ---- validation of what the model returns -----------------------------------------------------------------------

const str = (v: unknown, name: string, min: number, max: number): string => {
  if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) throw new Error(`"${name}" must be text of ${min}-${max} characters`);
  return v.trim();
};

const RESERVED = new Set(['style', 'sitemap', 'robots', 'images', 'app']);

export function validatePlan(raw: unknown, fallbackLang = 'en'): Plan {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') throw new Error('expected a JSON object');
  const pagesRaw = o.pages;
  if (!Array.isArray(pagesRaw) || pagesRaw.length < 1 || pagesRaw.length > 12) throw new Error('"pages" must list 1-12 pages');
  const seen = new Set<string>();
  const pages = pagesRaw.map((p: any, i) => {
    const slug = str(p?.slug, `pages[${i}].slug`, 1, 40).toLowerCase();
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`pages[${i}].slug "${slug}" may only use a-z, 0-9 and dashes`);
    if (RESERVED.has(slug)) throw new Error(`pages[${i}].slug "${slug}" is reserved`);
    if (seen.has(slug)) throw new Error(`duplicate slug "${slug}"`);
    seen.add(slug);
    const sections = Array.isArray(p?.sections) ? p.sections.map((x: unknown) => str(x, 'section', 2, 120)) : [];
    if (sections.length < 1 || sections.length > 10) throw new Error(`pages[${i}].sections must list 1-10 section ideas`);
    return { slug, title: str(p?.title, `pages[${i}].title`, 1, 40), purpose: str(p?.purpose, `pages[${i}].purpose`, 5, 300), sections, seo_title: str(p?.seo_title, `pages[${i}].seo_title`, 10, 70), seo_description: str(p?.seo_description, `pages[${i}].seo_description`, 50, 165) };
  });
  if (pages[0].slug !== 'index') throw new Error('the first page must have slug "index" (the home page)');
  const language = typeof o.language === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(o.language) ? o.language : fallbackLang;

  return { site_name: str(o.site_name, 'site_name', 1, 60), tagline: str(o.tagline ?? '', 'tagline', 0, 160), language, rtl: typeof o.rtl === 'boolean' ? o.rtl : /^(fa|ar|he|ur)/.test(language), tone: str(o.tone ?? 'clear and friendly', 'tone', 0, 120), audience: str(o.audience ?? '', 'audience', 0, 200), pages, footer_note: str(o.footer_note ?? `© ${new Date().getFullYear()}`, 'footer_note', 1, 200) };
}

export function validateTokens(raw: unknown): Tokens {
  const o = raw as Record<string, any> | null;
  if (!o || typeof o !== 'object' || !o.palette) throw new Error('expected {"palette":{...},"fonts":{...},"radius":n,"maxWidth":n}');
  const names = ['primary', 'secondary', 'accent', 'background', 'surface', 'text', 'muted'] as const;
  const palette = {} as Tokens['palette'];
  for (const k of names) {
    const v = o.palette[k];
    if (typeof v !== 'string' || !HEX.test(v)) throw new Error(`palette.${k} must be a #rrggbb colour`);
    palette[k] = v.toLowerCase();
  }
  const fonts = { heading: String(o.fonts?.heading ?? 'system'), body: String(o.fonts?.body ?? 'system') };
  for (const f of [fonts.heading, fonts.body]) if (!FONT_CHOICES.includes(f)) throw new Error(`fonts must be one of: ${FONT_CHOICES.join(', ')}`);
  const radius = Number(o.radius ?? 8);
  const maxWidth = Number(o.maxWidth ?? 1100);
  if (!(radius >= 0 && radius <= 32)) throw new Error('radius must be 0-32');
  if (!(maxWidth >= 640 && maxWidth <= 1440)) throw new Error('maxWidth must be 640-1440');
  for (const [fg, bg, label] of [[palette.text, palette.background, 'text on background'], [palette.text, palette.surface, 'text on surface']] as const) {
    const c = contrast(fg, bg);
    if (c < 4.5) throw new Error(`${label} has contrast ${c.toFixed(1)}:1; it must be at least 4.5:1 (darker text or lighter background)`);
  }
  if (contrast(palette.primary, palette.background) < 3) throw new Error('primary has less than 3:1 contrast with the background');

  return { palette, fonts, radius, maxWidth };
}

function validatePageMain(html: string, plan: Plan, slug: string): string {
  const body = checkMain(html);
  const h1 = (body.match(/<h1\b/gi) ?? []).length;
  if (h1 !== 1) throw new Error(`the page must have exactly one <h1> (found ${h1})`);
  const files = new Set(plan.pages.map((p) => pageFile(p.slug)));
  for (const m of body.matchAll(/<a\b[^>]*\shref\s*=\s*"([^"]*)"/gi)) {
    const href = m[1];
    if (!href || /^(https?:|mailto:|tel:|#)/i.test(href)) continue;
    const target = href.split('#')[0];
    if (target && !files.has(target)) throw new Error(`the link "${href}" goes to a page that does not exist; pages are: ${[...files].join(', ')}`);
  }
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
    const src = /\ssrc\s*=\s*"([^"]*)"/i.exec(m[0])?.[1] ?? '';
    if (!new RegExp(`^images/${slug}-\\d{1,2}\\.svg$`).test(src)) throw new Error(`every <img> must use src="images/${slug}-1.svg", "images/${slug}-2.svg" and so on (found "${src}")`);
    if (!/\salt\s*=\s*"[^"]+"/i.test(m[0])) throw new Error('every <img> needs a descriptive alt attribute');
  }
  return body;
}

// ---- writing the site ------------------------------------------------------------------------------------------

/** Rebuilds every generated page, the stylesheet and the SEO files from the stored plan, tokens and page content. */
export function writeSite(app: App, s: BuilderState): void {
  const dir = projectDir(app, s.project);
  if (s.tokens) writeFileSync(join(dir, 'style.css'), buildCss(s.tokens));
  if (!s.plan) return;
  const base = s.brief.base_url ? s.brief.base_url.replace(/\/+$/, '') : undefined;
  for (const page of s.plan.pages) {
    const main = readMain(app, s.project, page.slug);
    if (main !== null) writeFileSync(join(dir, pageFile(page.slug)), assemblePage({ plan: s.plan, page, main, baseUrl: s.stages.seo !== 'pending' ? base : undefined }));
  }
  if (s.stages.seo !== 'pending') {
    writeFileSync(join(dir, 'robots.txt'), robotsTxt(base));
    if (base) writeFileSync(join(dir, 'sitemap.xml'), sitemapXml(s.plan, base));
  }
}

function resetAfter(s: BuilderState, stage: Stage): void {
  for (const later of STAGES.slice(STAGES.indexOf(stage) + 1)) {
    s.stages[later] = later === 'pages' ? s.stages.pages : 'pending';
  }
  if (stage === 'plan' || stage === 'design') delete s.audit;
}

function need(s: BuilderState, stage: Stage): void {
  for (const before of STAGES.slice(0, STAGES.indexOf(stage))) {
    if (s.stages[before] !== 'approved') throw new BuilderError('not_approved', `Approve the "${before}" step first.`);
  }
}

// ---- starting ---------------------------------------------------------------------------------------------------

export interface StartInput {
  name: string;
  brief: string;
  language?: string;
  tone?: string;
  pagesHint?: string;
  baseUrl?: string;
  provider: string;
}

export function startBuilder(app: App, input: StartInput): BuilderState {
  if (!app.store.aiProvider(input.provider)) throw new BuilderError('no_provider', 'Choose an AI provider first (AI assistant page → add a key).');
  const brief = input.brief.trim();
  if (brief.length < 20) throw new BuilderError('short_brief', 'Describe the site in a few sentences: what it is for, who it is for, what visitors should do.');
  if (brief.length > 6000) throw new BuilderError('long_brief', 'Keep the brief under 6000 characters.');
  let baseUrl = '';
  if (input.baseUrl?.trim()) {
    try {
      const u = new URL(input.baseUrl.trim());
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      baseUrl = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      throw new BuilderError('bad_url', 'The public address must look like https://example.com');
    }
  }
  createProject(app, { name: input.name, kind: 'static', template: 'blank', title: input.name });
  const dir = projectDir(app, input.name.trim().toLowerCase());
  for (const f of ['index.html', 'style.css', 'app.js']) rmSync(join(dir, f), { force: true });
  const s: BuilderState = {
    version: 1,
    project: input.name.trim().toLowerCase(),
    provider: input.provider,
    brief: { text: brief, language: (input.language || 'en').trim(), tone: (input.tone || '').trim(), pages_hint: (input.pagesHint || '').trim(), base_url: baseUrl },
    stages: { plan: 'pending', design: 'pending', pages: 'pending', images: 'pending', seo: 'pending', audit: 'pending' },
    pages: {},
    updated: Date.now(),
  };
  save(app, s);

  return s;
}

// ---- running a stage --------------------------------------------------------------------------------------------

const PLAN_SYSTEM = `You are a senior information architect and web copywriter. You plan small and medium websites.
Reply with ONLY a JSON object, no explanation, in exactly this shape:
{"site_name":"","tagline":"","language":"en","rtl":false,"tone":"","audience":"","footer_note":"",
 "pages":[{"slug":"index","title":"","purpose":"","sections":["short idea of each section, top to bottom"],"seo_title":"max 65 chars","seo_description":"110-160 chars"}]}
Rules: the first page has slug "index"; slugs use a-z 0-9 and dashes only; 3-7 pages unless the brief needs more; page titles are short navigation labels (max 25 characters); write every text field in the site's language; never invent facts (prices, addresses, phone numbers, awards, customers) that the brief does not state.`;

const DESIGN_SYSTEM = `You are a brand and UI designer. Choose a design system for the site.
Reply with ONLY a JSON object: {"palette":{"primary":"#rrggbb","secondary":"#rrggbb","accent":"#rrggbb","background":"#rrggbb","surface":"#rrggbb","text":"#rrggbb","muted":"#rrggbb"},"fonts":{"heading":"system|system-fa|serif|mono","body":"system|system-fa|serif|mono"},"radius":8,"maxWidth":1100,"rationale":"one sentence"}
Rules: text on background and on surface must have at least 4.5:1 contrast (WCAG AA); primary must be visible on the background (3:1 or more); fonts are system stacks only (use "system-fa" for Persian or Arabic sites); the palette must fit the brand and audience.`;

const briefBlock = (s: BuilderState): string => `Brief:\n${s.brief.text}\n\nLanguage: ${s.brief.language}\nTone: ${s.brief.tone || 'your choice'}\nPages the owner expects: ${s.brief.pages_hint || 'your choice'}`;
const feedbackBlock = (fb?: string): string => (fb?.trim() ? `\n\nThe owner reviewed the previous version and asks for these changes. Apply them:\n${fb.trim().slice(0, 2000)}` : '');

export interface RunInput {
  stage: Stage;
  /** Pages stage: one page; omitted = every page not generated yet. */
  slug?: string;
  feedback?: string;
}

export async function runStage(app: App, project: string, input: RunInput): Promise<BuilderState> {
  if (busy.has(project)) throw new BuilderError('busy', 'This project is already working on a step.');
  busy.add(project);
  try {
    const s = loadState(app, project);
    const { stage } = input;
    need(s, stage);
    if (stage === 'plan') {
      const prev = s.plan ? `\n\nPrevious plan (revise it, keep what works):\n${JSON.stringify(s.plan)}` : '';
      s.plan = await askJson(app, s.provider, PLAN_SYSTEM, `${briefBlock(s)}${prev}${feedbackBlock(input.feedback)}`, (raw) => validatePlan(raw, s.brief.language));
      s.pages = {};
      rmSync(join(projectDir(app, project), DIR, 'pages'), { recursive: true, force: true });
      for (const f of readdirSync(projectDir(app, project))) if (/\.html$/.test(f)) rmSync(join(projectDir(app, project), f));
      s.stages.plan = 'review';
      resetAfter(s, 'plan');
      s.stages.pages = 'pending';
    } else if (stage === 'design') {
      const plan = s.plan!;
      const prev = s.tokens ? `\n\nPrevious design (revise it):\n${JSON.stringify(s.tokens)}` : '';
      s.tokens = await askJson(app, s.provider, DESIGN_SYSTEM, `${briefBlock(s)}\nSite: ${plan.site_name} - ${plan.tagline}\nAudience: ${plan.audience}\nTone: ${plan.tone}\nDirection: ${plan.rtl ? 'right-to-left' : 'left-to-right'}${prev}${feedbackBlock(input.feedback)}`, validateTokens);
      s.stages.design = 'review';
      resetAfter(s, 'design');
    } else if (stage === 'pages') {
      await runPages(app, s, input);
    } else if (stage === 'images') {
      buildImages(app, s);
      s.stages.images = 'review';
      resetAfter(s, 'images');
    } else if (stage === 'seo') {
      s.stages.seo = 'review';
      writeSite(app, s);
      resetAfter(s, 'seo');
    } else {
      writeSite(app, s);
      s.audit = runAudit(app, s);
      s.stages.audit = 'review';
    }
    writeSite(app, s);
    save(app, s);

    return s;
  } catch (error) {
    if (error instanceof LlmError) throw new BuilderError(error.code, error.message);
    throw error;
  } finally {
    busy.delete(project);
  }
}

async function runPages(app: App, s: BuilderState, input: RunInput): Promise<void> {
  const plan = s.plan!;
  const todo = input.slug ? plan.pages.filter((p) => p.slug === input.slug) : plan.pages.filter((p) => readMain(app, s.project, p.slug) === null);
  if (input.slug && !todo.length) throw new BuilderError('no_page', `There is no page "${input.slug}" in the plan.`);
  const files = plan.pages.map((p) => pageFile(p.slug)).join(', ');
  for (const page of todo) {
    const previous = readMain(app, s.project, page.slug);
    const system = `You write the content of the <main> element for ONE page of a static website. Output ONLY the HTML that goes inside <main> (no <html>, <head>, <body>, no code fences, no explanation).
Rules:
- Exactly one <h1>, then logical <h2>/<h3>. Wrap each section as <section class="section"><div class="container">...</div></section> (use class "section alt" for every other section; the first section of the home page is <section class="hero">).
- Use only these CSS classes: ${CSS_CLASSES}.
- Pictures: <figure class="img"><img src="images/${page.slug}-1.svg" alt="descriptive alt text" data-image-prompt="what the real picture should show" width="1200" height="675"></figure> and number them -1, -2, ... on this page.
- Link to other pages only with these files: ${files}. External links must be https.
- No scripts, styles, iframes, inline event handlers, or forms that post to other sites. A contact form may use action="#" with labels.
- Write real, specific copy in the site's language (${plan.language}); no lorem ipsum. Never invent facts the brief does not state (prices, addresses, phone numbers, reviews, awards). Where a fact is needed and unknown, write a visible placeholder in square brackets like [phone number].`;
    const user = `Site: ${plan.site_name} - ${plan.tagline}\nAudience: ${plan.audience}\nTone: ${plan.tone}\nLanguage: ${plan.language} (${plan.rtl ? 'right-to-left' : 'left-to-right'})\n\n${briefBlock(s)}\n\nPage to write: ${page.title} (${pageFile(page.slug)})\nPurpose: ${page.purpose}\nSections, top to bottom:\n${page.sections.map((x, i) => `${i + 1}. ${x}`).join('\n')}${previous ? `\n\nCurrent version (revise it):\n${previous.slice(0, 20000)}` : ''}${feedbackBlock(input.feedback)}`;
    let note = '';
    let html = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = stripFences(await llm.complete(app, s.provider, system, note ? `${user}\n\nYour previous answer was rejected: ${note}\nAnswer again with only the corrected HTML.` : user));
      try {
        html = validatePageMain(text, plan, page.slug);
        break;
      } catch (error) {
        note = error instanceof Error ? error.message : 'invalid';
        if (attempt === 1) throw new BuilderError('bad_answer', `The AI page for "${page.title}" was not usable (${note}). Try again, or pick a stronger model.`);
      }
    }
    mkdirSync(join(projectDir(app, s.project), DIR, 'pages'), { recursive: true });
    writeFileSync(mainFile(app, s.project, page.slug), html);
    s.pages[page.slug] = { status: 'review', revision: (s.pages[page.slug]?.revision ?? 0) + 1, feedback: input.feedback ?? '' };
  }
  s.stages.pages = plan.pages.every((p) => s.pages[p.slug]) ? (plan.pages.every((p) => s.pages[p.slug].status === 'approved') ? 'approved' : 'review') : 'pending';
  for (const later of ['images', 'seo', 'audit'] as Stage[]) s.stages[later] = 'pending';
  delete s.audit;
}

function buildImages(app: App, s: BuilderState): void {
  const dir = projectDir(app, s.project);
  const out: NonNullable<BuilderState['images']> = [];
  for (const page of s.plan!.pages) {
    const main = readMain(app, s.project, page.slug) ?? '';
    for (const m of main.matchAll(/<img\b[^>]*>/gi)) {
      const src = /\ssrc\s*=\s*"([^"]*)"/i.exec(m[0])?.[1] ?? '';
      if (!/^images\/[\w-]+\.svg$/.test(src)) continue;
      const alt = /\salt\s*=\s*"([^"]*)"/i.exec(m[0])?.[1] ?? '';
      const prompt = /\sdata-image-prompt\s*=\s*"([^"]*)"/i.exec(m[0])?.[1] ?? alt;
      mkdirSync(join(dir, 'images'), { recursive: true });
      if (!existsSync(join(dir, src))) writeFileSync(join(dir, src), placeholderSvg(alt || src, s.tokens!));
      out.push({ file: src, page: page.slug, alt, prompt });
    }
  }
  s.images = out;
  writeFileSync(join(dir, 'images.json'), JSON.stringify(out, null, 2));
}

function runAudit(app: App, s: BuilderState): AuditReport {
  const dir = projectDir(app, s.project);
  const html: Record<string, string> = {};
  const others: string[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
      else if (prefix === '' && name.endsWith('.html')) html[name] = readFileSync(full, 'utf8');
      else others.push(`${prefix}${name}`);
    }
  };
  walk(dir, '');
  const report = auditSite(s.plan!, s.tokens!, html, others);
  for (const p of s.plan!.pages) {
    const body = readMain(app, s.project, p.slug) ?? '';
    if (/\[[^\]\n<>]{3,40}\]/.test(body.replace(/<[^>]+>/g, ' '))) report.issues.push({ level: 'warn', page: pageFile(p.slug), rule: 'placeholder-text', message: 'The page has [bracketed placeholders] to fill in with real facts before launch.' });
  }
  report.warnings = report.issues.filter((i) => i.level === 'warn').length;
  report.score = Math.max(0, Math.round(100 - report.errors * 12 - report.warnings * 3));

  return report;
}

// ---- human decisions --------------------------------------------------------------------------------------------

export interface ApproveInput {
  stage: Stage;
  slug?: string;
  /** The person's own edit of the plan, design tokens or a page's HTML. Validated like the model's output. */
  edit?: unknown;
}

export function approve(app: App, project: string, input: ApproveInput): BuilderState {
  if (busy.has(project)) throw new BuilderError('busy', 'This project is working on a step; wait for it to finish.');
  const s = loadState(app, project);
  const { stage } = input;
  if (stage === 'pages') {
    if (!input.slug) throw new BuilderError('need_slug', 'Approve pages one at a time (give the page).');
    if (!s.pages[input.slug]) throw new BuilderError('no_page', 'That page has not been written yet.');
  } else if (s.stages[stage] !== 'review') throw new BuilderError('not_in_review', `The "${stage}" step has nothing waiting for approval.`);
  need(s, stage);
  if (input.edit !== undefined) {
    if (stage === 'plan') {
      s.plan = validatePlan(input.edit, s.brief.language);
      s.pages = {};
    } else if (stage === 'design') s.tokens = validateTokens(input.edit);
    else if (stage === 'pages' && input.slug) {
      if (!s.plan?.pages.some((p) => p.slug === input.slug)) throw new BuilderError('no_page', 'Unknown page.');
      writeFileSync(mainFile(app, project, input.slug), validatePageMain(String(input.edit), s.plan, input.slug));
      s.pages[input.slug] = { status: 'review', revision: (s.pages[input.slug]?.revision ?? 0) + 1, feedback: 'edited by the owner' };
    } else throw new BuilderError('not_editable', 'This step cannot be edited by hand.');
  }
  if (stage === 'pages') {
    s.pages[input.slug!].status = 'approved';
    s.stages.pages = s.plan!.pages.every((p) => s.pages[p.slug]?.status === 'approved') ? 'approved' : 'review';
  } else {
    if (stage === 'audit' && (s.audit?.errors ?? 1) > 0) throw new BuilderError('audit_errors', 'The audit found errors. Fix them (regenerate the affected pages with feedback) and run the audit again.');
    s.stages[stage] = 'approved';
  }
  if (input.edit !== undefined && stage !== 'pages') resetAfter(s, stage);
  writeSite(app, s);
  save(app, s);

  return s;
}

/** Sends the approved site to a host. Refuses unless every step was approved by a person. */
export async function publish(app: App, project: string, input: Omit<DeployInput, 'project'>) {
  const s = loadState(app, project);
  for (const stage of STAGES) if (s.stages[stage] !== 'approved') throw new BuilderError('not_approved', `Approve the "${stage}" step before publishing.`);
  if ((s.audit?.errors ?? 1) > 0) throw new BuilderError('audit_errors', 'The audit still has errors.');

  return deployProject(app, { ...input, project, url: input.url ?? s.brief.base_url, note: input.note ?? 'AI builder' });
}

export function removeBuilderProject(app: App, project: string): void {
  removeProject(app, project, true);
}

// ---- reading ----------------------------------------------------------------------------------------------------

export function stateView(app: App, project: string): BuilderState & { pages_detail: { slug: string; title: string; status: PageStatus | 'missing'; revision: number }[] } {
  const s = loadState(app, project);

  return { ...s, pages_detail: (s.plan?.pages ?? []).map((p) => ({ slug: p.slug, title: p.title, status: s.pages[p.slug]?.status ?? 'missing', revision: s.pages[p.slug]?.revision ?? 0 })) };
}

export function pageMain(app: App, project: string, slug: string): string {
  const s = loadState(app, project);
  if (!s.plan?.pages.some((p) => p.slug === slug)) throw new BuilderError('no_page', 'Unknown page.');
  const main = readMain(app, project, slug);
  if (main === null) throw new BuilderError('no_page', 'That page has not been written yet.');

  return main;
}

/** A self-contained copy of one page for the preview frame: stylesheet and placeholder pictures inlined, no outside requests. */
export function preview(app: App, project: string, slug: string): string {
  const s = loadState(app, project);
  const dir = projectDir(app, project);
  const file = join(dir, pageFile(slug));
  if (!existsSync(file)) throw new BuilderError('no_page', 'That page has not been written yet.');
  let html = readFileSync(file, 'utf8');
  const css = existsSync(join(dir, 'style.css')) ? readFileSync(join(dir, 'style.css'), 'utf8') : '';
  html = html.replace(/<link rel="stylesheet" href="style.css">/, () => `<style>${css}</style>`);
  html = html.replace(/(<img\b[^>]*\ssrc=")(images\/[\w-]+\.svg)(")/gi, (all, a: string, src: string, b: string) => {
    const f = join(dir, src);
    return existsSync(f) ? `${a}data:image/svg+xml;base64,${readFileSync(f).toString('base64')}${b}` : all;
  });
  // keep the preview inside the frame: links to other pages do nothing there
  html = html.replace(/<a\b([^>]*)\shref="([^"#][^"]*\.html)"/gi, (_m, pre: string, href: string) => `<a${pre} href="#" data-page="${esc(href)}"`);

  return s.plan ? html : '';
}
