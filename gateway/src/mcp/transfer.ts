import { randomBytes } from 'node:crypto';
import { canUseSite, type Principal } from '../auth.ts';
import type { App } from '../context.ts';
import { canonical, seal, sha256, unseal } from '../crypto.ts';
import { atLeast, minLevel, type Level } from '../levels.ts';
import type { OpSpec } from '../registry.ts';
import type { SiteRow } from '../store.ts';
import { SiteError } from '../wpclient.ts';

export interface Helpers {
  text: (body: unknown, isError?: boolean) => { content: { type: 'text'; text: string }[]; isError?: boolean };
  fail: (code: string, message: string, extra?: Record<string, unknown>) => { content: { type: 'text'; text: string }[]; isError?: boolean };
  log: (site: string, op: string, level: string, status: string, summary: string, revision?: number) => void;
}

type Result = ReturnType<Helpers['text']>;
type Json = Record<string, any>;

const KINDS = ['terms', 'posts', 'menus', 'design'];
const CONFIRM_TTL = 300;

export async function runTransfer(app: App, principal: Principal, op: OpSpec, args: Json, input: Json, h: Helpers): Promise<Result> {
  const requestId = randomBytes(6).toString('hex');
  const accessible = app.store.sites().filter((s) => canUseSite(principal, s.name));
  const find = (name: string): SiteRow | undefined => accessible.find((s) => s.name.toLowerCase() === String(name).toLowerCase());
  const from = find(args.from);
  const to = find(args.to);
  if (!from || !to) return h.fail('unknown_site', `Both "from" and "to" must be sites you can use. Available: ${accessible.map((s) => s.name).join(', ') || '(none)'}.`);
  if (from.name === to.name) return h.fail('same_site', 'from and to are the same site.');

  const lvFrom: Level = minLevel(principal.level, from.max_level);
  const lvTo: Level = minLevel(principal.level, to.max_level);
  const files = op.id === 'site.transfer_files';
  const kinds: string[] = files ? [] : (args.kinds as string[] | undefined) ?? ['terms', 'posts'];
  if (!files && kinds.some((k) => !KINDS.includes(k))) return h.fail('bad_arguments', `kinds may contain: ${KINDS.join(', ')}.`);

  const needTo: Level = files ? 'admin' : args.overwrite || args.publish || kinds.includes('menus') || kinds.includes('design') ? 'live' : 'draft';
  const needFrom: Level = files ? 'admin' : 'draft';
  if (!atLeast(lvFrom, needFrom)) return h.fail('level_too_low', `Reading from ${from.name} needs level ${needFrom}; yours is ${lvFrom}.`, { site: from.name });
  if (!atLeast(lvTo, needTo)) return h.fail('level_too_low', `Writing to ${to.name} needs level ${needTo} for this request; yours is ${lvTo}.`, { site: to.name });

  const gate = app.limiter.take(`w:${principal.id}`, app.config.limits.writePerMin, app.config.limits.writePerMin, 2);
  if (!gate.ok) return h.fail('rate_limited', `Too many requests. Wait ${gate.retryAfter}s and retry.`, { retry_after: gate.retryAfter });

  const call = (site: SiteRow, level: Level, opId: string, a: Json, write: boolean, key?: string) =>
    app.sites.call(site, opId, a, { level, actor: principal.name, client: principal.id, requestId, write, idempotencyKey: write ? key ?? `gw-${requestId}-${opId}-${sha256(canonical(a)).slice(0, 10)}` : undefined });

  /* confirmation for risky copies */
  const risky = files || !!args.overwrite || !!args.publish;
  const hash = sha256(canonical({ ...args, id_map: undefined, page: undefined, pages: undefined }));
  const given = typeof input.confirm_token === 'string' ? input.confirm_token : '';
  const claim = given ? unseal<{ p: string; s: string; o: string; h: string }>(app.config.masterKey, given) : null;
  const valid = !!claim && claim.p === principal.id && claim.s === `${from.name}>${to.name}` && claim.o === op.id && claim.h === hash;
  if (given && !valid) return h.fail('bad_confirm_token', 'The confirm_token is expired or does not match these exact arguments. Call again without it.');

  try {
    if (files) return await copyFiles(app, principal, args, input, h, { from, to, lvFrom, lvTo, call, hash, valid, op });

    /* a dry run only counts */
    if (input.dry_run === true) {
      const totals: Json = {};
      for (const kind of kinds) {
        const exp = (await call(from, lvFrom, 'transfer.export', { kind, post_type: args.post_type ?? 'page', per_page: 1 }, false)).data as Json;
        totals[kind] = exp.total;
      }
      return h.text({ ok: true, dry_run: true, from: from.name, to: to.name, would_copy: totals, note: 'Nothing was changed. Existing slugs on the target are skipped unless overwrite is set.' });
    }
    if (risky && !valid) {
      const token = seal(app.config.masterKey, { p: principal.id, s: `${from.name}>${to.name}`, o: op.id, h: hash, exp: Math.floor(Date.now() / 1000) + CONFIRM_TTL });
      h.log(`${from.name}>${to.name}`, op.id, lvTo, 'pending', 'needs confirmation');
      return h.text({ ok: true, needs_confirmation: true, action: op.id, preview: { from: from.name, to: to.name, kinds, overwrite: !!args.overwrite, publish: !!args.publish, effect: `${args.overwrite ? 'Existing items with the same slug on ' + to.name + ' will be REPLACED. ' : ''}${args.publish ? 'Items keep their published status and go live on ' + to.name + '.' : ''}` }, confirm_token: token, expires_in: CONFIRM_TTL, next: 'Nothing was changed. Explain this to the person and wait for their yes, then repeat the call with the same args plus this confirm_token.' });
    }

    const idMap: Json = { posts: {}, media: {}, urls: {}, ...(args.id_map ?? {}) };
    const report: Json = {};
    let next: Json | null = null;
    const merge = (data: Json): void => {
      for (const k of ['posts', 'media', 'urls']) Object.assign((idMap[k] ??= {}), data.id_map?.[k] ?? {});
    };
    const tally = (kind: string, data: Json): void => {
      const r = (report[kind] ??= { created: 0, skipped: 0, failed: [] as Json[] });
      r.created += data.created?.length ?? 0;
      r.skipped += data.skipped?.length ?? 0;
      r.failed.push(...(data.failed ?? []).slice(0, 10));
    };

    for (const kind of kinds) {
      const type = args.post_type ?? 'page';
      let page = kind === 'posts' ? Number(args.page ?? 1) : 1;
      const last = page + Number(args.pages ?? 3) - 1;
      for (;;) {
        const exp = (await call(from, lvFrom, 'transfer.export', { kind, post_type: type, page, per_page: kind === 'posts' ? 10 : 25, ...(args.ids ? { ids: args.ids } : {}) }, false)).data as Json;
        if (exp.items?.length) {
          const imp = (await call(to, lvTo, 'transfer.import', { kind, items: exp.items, id_map: idMap, source_url: exp.home_url ?? from.url, overwrite: !!args.overwrite, publish: !!args.publish }, true, `gw-${requestId}-${kind}-${page}`)).data as Json;
          merge(imp);
          tally(kind, imp);
        }
        const more = page < (exp.pages ?? 1) && !args.ids;
        if (!more) break;
        if (page >= last) {
          next = { kind, page: page + 1, id_map: idMap };
          break;
        }
        page++;
      }
      if (next) break;
    }

    app.store.siteHealth(from.name, true);
    app.store.siteHealth(to.name, true);
    const summary = Object.entries(report).map(([k, r]: [string, Json]) => `${k}: ${r.created} created, ${r.skipped} skipped, ${r.failed.length} failed`).join('; ');
    h.log(`${from.name}>${to.name}`, op.id, lvTo, 'ok', summary);
    return h.text({
      ok: true,
      action: op.id,
      from: from.name,
      to: to.name,
      report,
      id_map: idMap,
      ...(next ? { next, continue_with: `Call site.transfer again with the same from/to/kinds, page=${next.page} and id_map from this result to copy the rest.` } : { done: true }),
      note: 'New items are drafts on the target (unless publish was confirmed). Review them there, then publish. Each created item can be undone with activity.undo on the target site.',
    });
  } catch (error) {
    const err = error instanceof SiteError ? error : new SiteError('error', error instanceof Error ? error.message : 'Unexpected error.');
    h.log(`${from.name}>${to.name}`, op.id, lvTo, 'error', `${err.code}: ${err.message}`);
    return h.fail(err.code, err.message, { from: from.name, to: to.name });
  }
}

interface Ctx {
  from: SiteRow;
  to: SiteRow;
  lvFrom: Level;
  lvTo: Level;
  call: (site: SiteRow, level: Level, opId: string, a: Json, write: boolean, key?: string) => Promise<{ data: unknown }>;
  hash: string;
  valid: boolean;
  op: OpSpec;
}

async function copyFiles(app: App, principal: Principal, args: Json, input: Json, h: Helpers, c: Ctx): Promise<Result> {
  const root = String(args.root);
  const path = args.path ? String(args.path).replace(/^\/+|\/+$/g, '') : '';
  const isFile = /\.[a-z0-9]{1,5}$/i.test(path);
  let list: { path: string; bytes: number }[];
  if (isFile) {
    list = [{ path, bytes: 0 }];
  } else {
    const l = (await c.call(c.from, c.lvFrom, 'files.list', { root, ...(path ? { path } : {}), depth: 4 }, false)).data as Json;
    list = l.files as { path: string; bytes: number }[];
  }
  list = list.slice(0, 100);
  const total = list.reduce((n, f) => n + f.bytes, 0);

  if (!c.valid) {
    const token = seal(app.config.masterKey, { p: principal.id, s: `${c.from.name}>${c.to.name}`, o: c.op.id, h: c.hash, exp: Math.floor(Date.now() / 1000) + CONFIRM_TTL });
    h.log(`${c.from.name}>${c.to.name}`, c.op.id, c.lvTo, 'pending', 'needs confirmation');
    return h.text({
      ok: true,
      needs_confirmation: true,
      action: c.op.id,
      preview: { from: c.from.name, to: c.to.name, root, files: list.length, total_bytes: total, first_files: list.slice(0, 30).map((f) => f.path), skip_existing: !!args.skip_existing, warning: 'PHP files run with full access to the target site. Existing files with the same path are replaced (undoable with activity.undo on the target).' },
      confirm_token: token,
      expires_in: CONFIRM_TTL,
      next: 'Nothing was copied. Explain this to the person and wait for their yes, then repeat the call with the same args plus this confirm_token.',
    });
  }

  let existing = new Set<string>();
  if (args.skip_existing) {
    try {
      const t = (await c.call(c.to, c.lvTo, 'files.list', { root, ...(path && !isFile ? { path } : {}), depth: 4 }, false)).data as Json;
      existing = new Set((t.files as { path: string }[]).map((f) => f.path));
    } catch {
      /* target folder missing: nothing exists */
    }
  }
  const copied: string[] = [];
  const skipped: string[] = [];
  const failed: Json[] = [];
  for (const file of list) {
    if (existing.has(file.path)) {
      skipped.push(file.path);
      continue;
    }
    try {
      const rel = file.path;
      const read = (await c.call(c.from, c.lvFrom, 'files.read', { root, path: rel }, false)).data as Json;
      if (read.truncated) throw new SiteError('too_large', 'File is larger than 2 MB.');
      await c.call(c.to, c.lvTo, 'files.write', read.encoding === 'base64' ? { root, path: rel, data_base64: read.data_base64 } : { root, path: rel, content: read.content }, true);
      copied.push(rel);
    } catch (error) {
      failed.push({ path: file.path, error: error instanceof Error ? error.message : 'failed' });
    }
  }
  h.log(`${c.from.name}>${c.to.name}`, c.op.id, c.lvTo, failed.length ? 'error' : 'ok', `${root}: ${copied.length} copied, ${skipped.length} skipped, ${failed.length} failed`);
  return h.text({ ok: true, action: c.op.id, from: c.from.name, to: c.to.name, root, copied: copied.length, skipped: skipped.length, failed: failed.slice(0, 20), note: list.length === 100 ? 'Only the first 100 files were considered; run again for the rest (use skip_existing).' : undefined });
}
