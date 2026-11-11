export const LEVELS = ['read', 'draft', 'live', 'admin'] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_HELP: Record<Level, string> = {
  read: 'Read non-sensitive public data only (published content, design, SEO, page HTML). No users, orders, settings or drafts.',
  draft: 'Everything in read, plus drafts/private content, uploads, and writing drafts. Nothing becomes public.',
  live: 'Everything in draft, plus publishing and editing live pages, menus, CSS, SEO, redirects, products, moderation, cache.',
  admin: 'Everything: plugins, updates, users, options, database, theme files, backups, orders. Destructive steps still need confirmation.',
};

export const isLevel = (value: unknown): value is Level => typeof value === 'string' && (LEVELS as readonly string[]).includes(value);

export const rank = (level: Level): number => LEVELS.indexOf(level);

export const atLeast = (have: Level, need: Level): boolean => rank(have) >= rank(need);

export const minLevel = (a: Level, b: Level): Level => (rank(a) <= rank(b) ? a : b);
