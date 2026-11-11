import { randomBytes } from 'node:crypto';
import { canUseSite, type Principal } from '../auth/auth.ts';
import type { App } from '../core/context.ts';
import { canonical, seal, sha256, unseal } from '../core/crypto.ts';
import { atLeast, minLevel, type Level } from '../core/levels.ts';
import type { SiteRow } from '../core/store.ts';
import { OPS, type OpSpec } from '../sites/registry.ts';
import { SiteError } from '../sites/wpclient.ts';
import type { Helpers } from './transfer.ts';

type Json = Record<string, any>;

const CONFIRM_TTL = 300;
const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const TOP = ['plugins', 'theme', 'tokens', 'pages', 'menu', 'homepage', 'branding', 'options', 'sync_tokens', 'publish_pages'];
const INTERNAL = ['page_ids'];

export interface StepContext {
  /** Page ids by map key: from earlier steps of this run, or passed back in page_ids when resuming. */
  pageIds: Record<string, number>;
  /** Calls the site (reads and writes); the build code never talks to the bridge any other way. */
  call: (op: string, args: Json) => Promise<Json>;
}

export interface Step {
  label: string;
  /** Operations the step uses, to check levels before anything runs. */
  ops: string[];
  run: (ctx: StepContext) => Promise<Json>;
}

export interface Plan {
  steps: Step[];
  errors: string[];
}

const asList = (v: unknown): Json[] =>
  Array.isArray(v) ? v.filter((x): x is Json => !!x && typeof x === 'object' && !Array.isArray(x)) : [];

/** Menu items of the map with page keys turned into page ids (bridge format: {title, url | object:"page"+object_id, children}). */
function menuItems(items: Json[], ids: Record<string, number>): Json[] {
  return items.map((item) => {
    const out: Json = { title: String(item.title ?? '') };
    if (typeof item.page === 'string') {
      const id = ids[item.page];
      if (!id) throw new Error(`Menu item "${out.title}" points to the page "${item.page}", which was not created.`);
      out.object = 'page';
      out.object_id = id;
    } else if (typeof item.url === 'string') out.url = item.url;
    if (Array.isArray(item.children) && item.children.length) out.children = menuItems(asList(item.children), ids);
    return out;
  });
}

/** Checks a site map and turns it into ordered steps. Pure: nothing is called until a step runs. */
export function planBuild(map: Json): Plan {
  const errors: string[] = [];
  const steps: Step[] = [];
  const unknown = Object.keys(map).filter((k) => !TOP.includes(k) && !INTERNAL.includes(k));
  if (unknown.length) errors.push(`Unknown map keys: ${unknown.join(', ')}. Allowed: ${TOP.join(', ')}.`);

  const pages = asList(map.pages);
  if (map.pages !== undefined && (!Array.isArray(map.pages) || pages.length !== (map.pages as unknown[]).length))
    errors.push('pages must be a list of objects.');
  if (pages.length > 40) errors.push('At most 40 pages per build.');
  const keys = new Set<string>();
  for (const p of pages) {
    if (typeof p.key !== 'string' || !KEY.test(p.key))
      errors.push(`Every page needs a key of lowercase letters, digits, - or _ (got ${JSON.stringify(p.key)}).`);
    else if (keys.has(p.key)) errors.push(`The page key "${p.key}" is used twice.`);
    else keys.add(p.key);
    if (typeof p.title !== 'string' || !p.title.trim()) errors.push(`Page "${p.key}" needs a title.`);
    if (p.content !== undefined && p.patterns !== undefined) errors.push(`Page "${p.key}": use content or patterns, not both.`);
    if (p.patterns !== undefined && asList(p.patterns).length !== (Array.isArray(p.patterns) ? p.patterns.length : -1))
      errors.push(`Page "${p.key}": patterns must be a list of {name, text?}.`);
    if (typeof p.parent === 'string' && !pages.some((q) => q.key === p.parent))
      errors.push(`Page "${p.key}": parent "${p.parent}" is not in pages.`);
  }
  const known = (key: unknown): boolean => typeof key === 'string' && (keys.has(key) || Object.hasOwn(map.page_ids ?? {}, key));
  const walk = (items: Json[]): void => {
    for (const item of items) {
      if (typeof item.title !== 'string' || !item.title) errors.push('Every menu item needs a title.');
      if (typeof item.page === 'string' && !known(item.page)) errors.push(`Menu item "${item.title}": no page "${item.page}" in pages.`);
      if (item.page === undefined && typeof item.url !== 'string') errors.push(`Menu item "${item.title}" needs page or url.`);
      walk(asList(item.children));
    }
  };
  if (map.menu) {
    if (typeof map.menu.name !== 'string' || !map.menu.name) errors.push('menu needs a name.');
    walk(asList(map.menu.items));
  }
  for (const role of ['front', 'posts'] as const)
    if (map.homepage?.[role] !== undefined && !known(map.homepage[role]))
      errors.push(`homepage.${role}: no page "${map.homepage[role]}" in pages.`);
  if (errors.length) return { steps, errors };

  /* plugins */
  for (const plugin of asList(map.plugins)) {
    if (typeof plugin.wporg === 'string')
      steps.push({
        label: `install plugin ${plugin.wporg}`,
        ops: ['plugins.install'],
        run: (c) => c.call('plugins.install', { slug: plugin.wporg, activate: plugin.activate !== false }),
      });
    else if (typeof plugin.zip_url === 'string')
      steps.push({
        label: `install plugin from ${plugin.zip_url}`,
        ops: ['plugins.install_zip'],
        run: (c) => c.call('plugins.install_zip', { url: plugin.zip_url, activate: plugin.activate !== false }),
      });
    else if (plugin.scaffold && typeof plugin.scaffold === 'object')
      steps.push({
        label: `create plugin ${plugin.scaffold.slug}`,
        ops: plugin.activate ? ['plugins.scaffold', 'plugins.activate'] : ['plugins.scaffold'],
        run: async (c) => {
          const made = await c.call('plugins.scaffold', { ...plugin.scaffold, install: true });
          if (plugin.activate) await c.call('plugins.activate', { plugin: `${plugin.scaffold.slug}/${plugin.scaffold.slug}.php` });
          return made;
        },
      });
    else if (typeof plugin.activate === 'string')
      steps.push({
        label: `activate plugin ${plugin.activate}`,
        ops: ['plugins.activate'],
        run: (c) => c.call('plugins.activate', { plugin: plugin.activate }),
      });
    else errors.push('Every plugins entry needs wporg, zip_url, scaffold or activate.');
  }

  /* theme */
  const theme = map.theme as Json | undefined;
  if (theme) {
    if (theme.scaffold)
      steps.push({
        label: `build theme ${theme.scaffold.slug} from ${theme.scaffold.base}`,
        ops: ['design.theme_scaffold'],
        run: (c) => c.call('design.theme_scaffold', { ...theme.scaffold, activate: theme.activate !== false }),
      });
    else if (typeof theme.wporg === 'string')
      steps.push({
        label: `install theme ${theme.wporg}`,
        ops: ['design.theme_install'],
        run: (c) => c.call('design.theme_install', { slug: theme.wporg, activate: theme.activate !== false }),
      });
    else if (typeof theme.activate === 'string')
      steps.push({
        label: `activate theme ${theme.activate}`,
        ops: ['design.theme_activate'],
        run: (c) => c.call('design.theme_activate', { slug: theme.activate }),
      });
    else errors.push('theme needs scaffold, wporg or activate.');
  }
  if (map.tokens && typeof map.tokens === 'object')
    steps.push({ label: 'set design tokens', ops: ['design.tokens_set'], run: (c) => c.call('design.tokens_set', map.tokens) });

  /* pages: parents first */
  const ordered = [...pages].sort((a, b) => Number(typeof a.parent === 'string') - Number(typeof b.parent === 'string'));
  for (const p of ordered) {
    const patterns = asList(p.patterns);
    steps.push({
      label: `page ${p.key} (${p.title})`,
      ops: patterns.length ? ['content.save', 'design.pattern_get'] : ['content.save'],
      run: async (c) => {
        let content = typeof p.content === 'string' ? p.content : undefined;
        if (patterns.length) {
          const parts: string[] = [];
          for (const pat of patterns)
            parts.push(
              String((await c.call('design.pattern_get', { name: pat.name, ...(pat.text ? { text: pat.text } : {}) })).content ?? ''),
            );
          content = parts.join('\n\n');
        }
        const args: Json = {
          post_type: 'page',
          title: p.title,
          status: p.status ?? (map.publish_pages ? 'publish' : 'draft'),
          ...(p.slug ? { slug: p.slug } : {}),
          ...(content !== undefined ? { content } : {}),
          ...(p.template !== undefined ? { template: p.template } : {}),
          ...(typeof p.parent === 'string' ? { parent: c.pageIds[p.parent] } : {}),
        };
        const saved = await c.call('content.save', args);
        c.pageIds[p.key] = Number(saved.id);
        return { id: saved.id, status: saved.status, url: saved.url };
      },
    });
  }

  if (map.menu)
    steps.push({
      label: `menu ${map.menu.name}`,
      ops: ['design.menu_save'],
      run: (c) =>
        c.call('design.menu_save', {
          name: map.menu.name,
          items: menuItems(asList(map.menu.items), c.pageIds),
          ...(map.menu.location ? { locations: [map.menu.location] } : {}),
        }),
    });
  if (map.homepage)
    steps.push({
      label: 'home page and blog page',
      ops: ['design.homepage_set'],
      run: (c) =>
        c.call('design.homepage_set', {
          show_on_front: map.homepage.front ? 'page' : 'posts',
          ...(map.homepage.front ? { front_page_id: c.pageIds[map.homepage.front] } : {}),
          ...(map.homepage.posts ? { posts_page_id: c.pageIds[map.homepage.posts] } : {}),
        }),
    });
  if (map.branding)
    steps.push({ label: 'site title and tagline', ops: ['design.branding_set'], run: (c) => c.call('design.branding_set', map.branding) });
  if (map.options) steps.push({ label: 'options', ops: ['options.set'], run: (c) => c.call('options.set', { values: map.options }) });
  if (map.sync_tokens)
    steps.push({
      label: 'sync tokens to theme.json and Elementor',
      ops: ['design.tokens_sync'],
      run: (c) => c.call('design.tokens_sync', {}),
    });
  if (!steps.length && !errors.length) errors.push('The map is empty: give at least one of ' + TOP.join(', ') + '.');

  return { steps, errors };
}

/** The highest level any step needs. */
export const levelNeeded = (steps: Step[]): Level =>
  steps
    .flatMap((s) => s.ops)
    .map((id) => (OPS[id] as OpSpec | undefined)?.level ?? 'admin')
    .reduce<Level>((top, lv) => (atLeast(lv, top) ? lv : top), 'read');

export async function runBuild(
  app: App,
  principal: Principal,
  op: OpSpec,
  args: Json,
  input: Json,
  h: Helpers,
): Promise<ReturnType<Helpers['text']>> {
  const requestId = randomBytes(6).toString('hex');
  const accessible = app.store.sites().filter((s) => canUseSite(principal, s.name));
  const wanted = typeof input.site === 'string' ? input.site.trim() : '';
  const site: SiteRow | undefined = wanted
    ? accessible.find((s) => s.name.toLowerCase() === wanted.toLowerCase())
    : accessible.length === 1
      ? accessible[0]
      : undefined;
  if (!site) return h.fail('site_required', `Pass site. Available: ${accessible.map((s) => s.name).join(', ') || '(none)'}.`);

  let map = args.map as Json;
  if (typeof map === 'string') {
    try {
      map = JSON.parse(map) as Json;
    } catch {
      /* reported below */
    }
  }
  if (!map || typeof map !== 'object' || Array.isArray(map))
    return h.fail('bad_arguments', 'map must be an object (see site.describe site build).');
  const pageIds: Record<string, number> = { ...(args.page_ids as Record<string, number> | undefined) };
  const plan = planBuild({ ...map, page_ids: pageIds });
  if (plan.errors.length) return h.fail('bad_map', plan.errors.join(' '), { errors: plan.errors });

  const level = minLevel(principal.level, site.max_level);
  const need = levelNeeded(plan.steps);
  if (!atLeast(level, need))
    return h.fail(
      'level_too_low',
      `This map needs level ${need} on ${site.name}; yours is ${level}. Remove the plugin, theme or option steps or ask the owner to raise the level.`,
      { site: site.name, needs: need, have: level },
    );

  const labels = plan.steps.map((s, i) => `${i + 1}. ${s.label}`);
  const from = Math.max(1, Number(args.from_step ?? 1));
  if (input.dry_run === true || args.dry_run === true)
    return h.text({
      ok: true,
      site: site.name,
      dry_run: true,
      steps: labels,
      needs_level: need,
      note: 'Nothing was called. Run it without dry_run to get a confirm_token.',
    });

  const hash = sha256(canonical({ map, from }));
  const given = typeof input.confirm_token === 'string' ? input.confirm_token : '';
  const claim = given ? unseal<{ p: string; s: string; o: string; h: string }>(app.config.masterKey, given) : null;
  const valid = !!claim && claim.p === principal.id && claim.s === site.name && claim.o === op.id && claim.h === hash;
  if (given && !valid)
    return h.fail('bad_confirm_token', 'The confirm_token is expired or does not match this exact map. Call again without it.');
  if (!valid) {
    const token = seal(app.config.masterKey, {
      p: principal.id,
      s: site.name,
      o: op.id,
      h: hash,
      exp: Math.floor(Date.now() / 1000) + CONFIRM_TTL,
    });
    h.log(site.name, op.id, level, 'pending', `needs confirmation: ${labels.length} steps`);
    return h.text({
      ok: true,
      site: site.name,
      needs_confirmation: true,
      action: op.id,
      preview: {
        steps: labels,
        needs_level: need,
        effect: 'These steps change the site in this order. Pages are created as drafts unless the map says publish_pages or a status.',
      },
      confirm_token: token,
      expires_in: CONFIRM_TTL,
      next: 'Nothing was changed. Explain the steps to the person and wait for their yes, then repeat the call with the same args plus this confirm_token.',
    });
  }

  const gate = app.limiter.take(`w:${principal.id}`, app.config.limits.writePerMin, app.config.limits.writePerMin, 2);
  if (!gate.ok) return h.fail('rate_limited', `Too many requests. Wait ${gate.retryAfter}s and retry.`, { retry_after: gate.retryAfter });

  const mapHash = sha256(canonical(map)).slice(0, 10);
  let index = 0;
  const revisions: number[] = [];
  const ctx: StepContext = {
    pageIds,
    call: async (opId, a) => {
      const spec = OPS[opId];
      const write = !!spec?.write;
      const r = await app.sites.call(site, opId, a, {
        level,
        actor: principal.name,
        client: principal.id,
        requestId,
        write,
        idempotencyKey: write ? `build-${mapHash}-${index}-${sha256(canonical(a)).slice(0, 8)}` : undefined,
      });
      if (r.revision) revisions.push(r.revision);
      return (r.data ?? {}) as Json;
    },
  };
  const done: Json[] = [];
  for (index = from - 1; index < plan.steps.length; index++) {
    const step = plan.steps[index]!;
    try {
      const data = await step.run(ctx);
      done.push({ step: index + 1, label: step.label, ok: true, ...(data && Object.keys(data).length < 8 ? { result: data } : {}) });
      h.log(site.name, op.id, level, 'ok', step.label);
    } catch (error) {
      const err = error instanceof SiteError ? error : new SiteError('error', error instanceof Error ? error.message : 'Unexpected error.');
      h.log(site.name, op.id, level, 'error', `${step.label}: ${err.code}`);
      return h.text(
        {
          ok: false,
          site: site.name,
          failed_step: { step: index + 1, label: step.label, code: err.code, message: err.message },
          done,
          page_ids: ctx.pageIds,
          resume: `Fix the cause, then call again with the same map plus from_step: ${index + 1} and page_ids: ${JSON.stringify(ctx.pageIds)}. Earlier steps are not repeated. Each change can be undone with activity.undo.`,
          revisions,
        },
        true,
      );
    }
  }
  return h.text({
    ok: true,
    site: site.name,
    built: done.length,
    steps: done,
    page_ids: ctx.pageIds,
    revisions,
    next: 'Check the result with inspect.page and seo.audit; publish drafts with content.bulk when it looks right.',
  });
}
