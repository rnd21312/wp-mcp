import spec from './generated/ops.json' with { type: 'json' };
import type { Level } from './levels.ts';
import { LEVELS, rank } from './levels.ts';

export interface OpSpec {
  id: string;
  tool: string;
  action: string;
  level: Level;
  summary: string;
  params: Record<string, string>;
  required: string[];
  write: boolean;
  /** true = always two-step; 'maybe' = the site decides from the arguments (previewed first). */
  confirm: boolean | 'maybe';
  untrusted: boolean;
  escalates: Level | null;
  /** Handled by the gateway itself, never sent to a site. */
  local?: boolean;
}

const LOCAL: OpSpec[] = [
  { id: 'site.sites', tool: 'site', action: 'sites', level: 'read', summary: 'Every site you can use: name, URL, status, your effective level on it. Start here when several sites are connected.', params: {}, required: [], write: false, confirm: false, untrusted: false, escalates: null, local: true },
  { id: 'site.whoami', tool: 'site', action: 'whoami', level: 'read', summary: 'Who you are connected as: level, sites, rate limits, token kind.', params: {}, required: [], write: false, confirm: false, untrusted: false, escalates: null, local: true },
  { id: 'site.describe', tool: 'site', action: 'describe', level: 'read', summary: 'Full parameter schema of one action (or all actions of one tool).', params: { 'tool': 'string|Tool name', action: 'string|Action name; omit to list the tool' }, required: ['tool'], write: false, confirm: false, untrusted: false, escalates: null, local: true },
  { id: 'site.transfer', tool: 'site', action: 'transfer', level: 'draft', summary: 'Copy content from one site to another through the gateway (nothing passes through the AI): terms, posts/pages with meta, SEO, builder data and images, menus, design settings. Creates drafts, skips existing slugs, resumable by page.', params: { from: 'string|Source site name', to: 'string|Target site name', kinds: 'array|terms, posts, menus, design, users, options (default terms+posts; users and options need admin)', prefixes: 'array|For kind options: option name prefixes such as ["woocommerce_"]', post_type: 'string|Post type for posts (default page)', ids: 'array|Only these source post IDs', page: 'int|First page (default 1)', pages: 'int|How many pages of 10 per call (default 3)', id_map: 'object|Pass back the id_map of the previous call to continue', overwrite: 'bool|Replace existing slugs (confirm)', publish: 'bool|Keep source status (confirm, live level)' }, required: ['from', 'to'], write: true, confirm: 'maybe', untrusted: false, escalates: 'live', local: true },
  { id: 'site.transfer_files', tool: 'site', action: 'transfer_files', level: 'admin', summary: 'Copy files (a theme folder, a plugin folder, uploads) from one site to another through the gateway. Needs admin on both sites and confirmation.', params: { from: 'string|Source site name', to: 'string|Target site name', root: 'string|e.g. themes/my-child-theme', path: 'string|Subfolder or file inside the root', skip_existing: 'bool|Do not overwrite files that exist on the target' }, required: ['from', 'to', 'root'], write: true, confirm: true, untrusted: false, escalates: null, local: true },
  { id: 'activity.log', tool: 'activity', action: 'log', level: 'read', summary: 'Gateway log of calls made by AI clients (who, which tool, which site, result). Combine with activity.list for what the site itself recorded.', params: { limit: 'int|Default 30, max 100', mine: 'bool|Only calls of this connection' }, required: [], write: false, confirm: false, untrusted: false, escalates: null, local: true },
];

export const OPS: Record<string, OpSpec> = {};
for (const op of [...(spec.ops as unknown as OpSpec[]), ...LOCAL]) OPS[op.id] = op;

export interface ToolInfo {
  name: string;
  title: string;
  intro: string;
}

export const TOOLS: ToolInfo[] = [
  { name: 'site', title: 'Site overview and connections', intro: 'START HERE. Which sites exist, what a site contains (theme, plugins, content types, SEO plugin, WooCommerce), who you are, and the schema of any action.' },
  { name: 'content', title: 'Posts, pages, terms, comments', intro: 'Blog posts, pages, custom post types, categories/tags, comments. Content is block markup or HTML.' },
  { name: 'design', title: 'Design: templates, CSS, tokens, menus, themes', intro: 'Header/footer and templates (block themes), additional CSS in named sections, design tokens, menus, homepage, branding, themes and theme files.' },
  { name: 'media', title: 'Media library', intro: 'List, upload (base64 or https URL), describe and delete images and files.' },
  { name: 'seo', title: 'SEO', intro: 'Per-page SEO fields (Yoast, Rank Math, AIOSEO, SEOPress or built-in), page audit, robots.txt, sitemap, redirects, JSON-LD schema.' },
  { name: 'inspect', title: 'Inspect rendered pages', intro: 'See what visitors get: rendered HTML, structure outline, stylesheets. No browser: for pixels use a browser tool.' },
  { name: 'maintain', title: 'Maintenance', intro: 'Health, updates, backups, error logs, caches, database cleanup, search-replace, cron, maintenance mode.' },
  { name: 'plugins', title: 'Plugins', intro: 'List, search, install, activate, deactivate, delete plugins. Use rest for other plugins\' own APIs.' },
  { name: 'users', title: 'Users', intro: 'Public authors (read) and full user management (admin).' },
  { name: 'options', title: 'Site options', intro: 'WordPress options. Safe settings at live level, the rest admin. Secrets are never returned.' },
  { name: 'rest', title: 'Generic REST layer', intro: 'Discover and call any REST route (WooCommerce, forms, SEO plugins, custom endpoints). Level is derived from method and route.' },
  { name: 'shop', title: 'WooCommerce', intro: 'Products, stock, coupons, orders (orders are personal data: admin).' },
  { name: 'forms', title: 'Forms', intro: 'Contact Form 7, Gravity Forms, WPForms, Fluent Forms: list, read, edit (CF7) and entries (admin).' },
  { name: 'files', title: 'Files in wp-content', intro: 'Browse, read, write and delete files of themes, plugins, mu-plugins and uploads (admin; writes are confirmed and PHP is syntax-checked).' },
  { name: 'transfer', title: 'Export and import content', intro: 'Portable JSON export/import of posts, terms, menus, media and design settings. To copy between two sites in one go use site.transfer.' },
  { name: 'activity', title: 'Activity and undo', intro: 'What was done on the site and by whom; undo a change by revision ID.' },
];

export const opsOf = (tool: string): OpSpec[] => Object.values(OPS).filter((op) => op.tool === tool);

export interface ParamDef {
  type: string;
  enum?: string[];
  description: string;
}

export function parseParam(def: string): ParamDef {
  const bar = def.indexOf('|');
  const type = bar === -1 ? def : def.slice(0, bar);
  const description = bar === -1 ? '' : def.slice(bar + 1);
  return type.startsWith('enum:') ? { type: 'enum', enum: type.slice(5).split(','), description } : { type, description };
}

export function paramSchema(op: OpSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(op.params)) {
    const p = parseParam(def);
    const jsonType = p.type === 'int' ? 'integer' : p.type === 'bool' ? 'boolean' : p.type === 'enum' ? 'string' : p.type === 'any' ? undefined : p.type;
    properties[name] = { ...(jsonType ? { type: jsonType } : {}), ...(p.enum ? { enum: p.enum } : {}), description: p.description };
  }
  return { type: 'object', properties, required: op.required, additionalProperties: false };
}

/** Compact one-line signature: name(arg*, arg…). Required arguments are starred. */
export function signature(op: OpSpec): string {
  const names = Object.keys(op.params).map((n) => (op.required.includes(n) ? `${n}*` : n));
  return `${op.action}(${names.join(',')})`;
}

export interface Checked {
  args: Record<string, unknown>;
  errors: string[];
}

/** Validates and gently coerces arguments (LLMs often send "5" or "true"). */
export function checkArgs(op: OpSpec, input: unknown): Checked {
  const errors: string[] = [];
  const source = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const args: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(source)) {
    const def = op.params[name];
    if (!def) {
      errors.push(`Unknown argument "${name}". Allowed: ${Object.keys(op.params).join(', ') || '(none)'}.`);
      continue;
    }
    const p = parseParam(def);
    let v: unknown = value;
    if (v === null || v === undefined) continue;
    switch (p.type) {
      case 'string':
        if (typeof v === 'number') v = String(v);
        if (typeof v !== 'string') errors.push(`"${name}" must be a string.`);
        break;
      case 'int':
        if (typeof v === 'string' && /^-?\d+$/.test(v)) v = Number(v);
        if (!Number.isInteger(v)) errors.push(`"${name}" must be an integer.`);
        break;
      case 'bool':
        if (v === 'true' || v === 1) v = true;
        if (v === 'false' || v === 0) v = false;
        if (typeof v !== 'boolean') errors.push(`"${name}" must be true or false.`);
        break;
      case 'object':
        if (typeof v === 'string') {
          try { v = JSON.parse(v); } catch { /* reported below */ }
        }
        if (!v || typeof v !== 'object' || Array.isArray(v)) errors.push(`"${name}" must be an object.`);
        break;
      case 'array':
        if (typeof v === 'string') {
          try { v = JSON.parse(v); } catch { v = (v as string).split(',').map((part: string) => part.trim()).filter(Boolean); }
        }
        if (!Array.isArray(v)) errors.push(`"${name}" must be an array.`);
        break;
      case 'enum':
        if (typeof v !== 'string' || !p.enum!.includes(v)) errors.push(`"${name}" must be one of: ${p.enum!.join(', ')}.`);
        break;
      default:
        break;
    }
    args[name] = v;
  }
  for (const name of op.required) if (args[name] === undefined) errors.push(`Missing required argument "${name}".`);
  return { args, errors };
}

export const highestLevel = (ops: OpSpec[]): Level => ops.reduce<Level>((top, op) => (rank(op.level) > rank(top) ? op.level : top), LEVELS[0]);
