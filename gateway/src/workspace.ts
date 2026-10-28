import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { App } from './context.ts';
import { minLevel } from './levels.ts';

/**
 * Local workspace for VS Code: the active theme of a site as real files on this computer. Edit them in VS Code (or any
 * editor); with live sync on, every save is pushed to the site (PHP is syntax-checked there and reverted if it breaks the site).
 */

const MANIFEST = '.wpm-manifest.json';
const TEXT = /\.(php|css|js|mjs|json|html|htm|txt|svg|md|twig)$/i;
const sha = (s: string): string => createHash('sha1').update(s).digest('hex');

interface Manifest {
  site: string;
  theme: string;
  pulledAt: number;
  files: Record<string, string>;
}

export interface WsEvent {
  at: number;
  path: string;
  ok: boolean;
  message: string;
}

const watchers = new Map<string, { watcher: FSWatcher; timers: Map<string, NodeJS.Timeout> }>();
const events = new Map<string, WsEvent[]>();

export const wsDir = (app: App, site: string): string => join(app.config.dataDir, 'workspaces', site.replace(/[^a-z0-9._-]/gi, '_'), 'theme');

const readManifest = (dir: string): Manifest | null => {
  try { return JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as Manifest; } catch { return null; }
};
const writeManifest = (dir: string, m: Manifest): void => writeFileSync(join(dir, MANIFEST), JSON.stringify(m));

function siteCall(app: App, name: string, op: string, args: Record<string, unknown>, write: boolean) {
  const site = app.store.site(name);
  if (!site) throw new Error(`Unknown site "${name}".`);
  if (site.max_level !== 'admin') throw new Error(`Theme file access needs the site ceiling "admin" (now "${site.max_level}"). Raise it on the Sites page.`);

  return app.sites.call(site, op, args, { level: minLevel('admin', site.max_level), actor: 'workspace', client: 'workspace', requestId: 'ws', write, idempotencyKey: write ? `ws-${sha(JSON.stringify([op, args])).slice(0, 16)}-${Date.now()}` : undefined });
}

/** Downloads the active theme into the workspace. */
export async function pull(app: App, site: string): Promise<{ dir: string; files: number; theme: string }> {
  const dir = wsDir(app, site);
  const listing = (await siteCall(app, site, 'design.theme_files', {}, false)).data as { theme: string; files: { path: string; bytes: number }[] };
  mkdirSync(dir, { recursive: true });
  const manifest: Manifest = { site, theme: listing.theme, pulledAt: Date.now(), files: {} };
  let count = 0;
  for (const f of listing.files.slice(0, 500)) {
    if (!TEXT.test(f.path) || f.bytes > 400_000) continue;
    const read = (await siteCall(app, site, 'design.theme_file_read', { path: f.path }, false)).data as { content: string; truncated: boolean };
    if (read.truncated) continue;
    const target = resolve(dir, f.path);
    if (!target.startsWith(dir + sep)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, read.content);
    manifest.files[f.path] = sha(read.content);
    count++;
  }
  writeManifest(dir, manifest);

  return { dir, files: count, theme: listing.theme };
}

export function openInVsCode(dir: string): { ok: boolean; vscodeUrl: string } {
  try {
    const child = spawn('code', [dir], { shell: true, detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    /* VS Code CLI not installed: the link below still works */
  }

  return { ok: true, vscodeUrl: `vscode://file/${dir.replace(/\\/g, '/')}` };
}

const push = async (app: App, site: string, dir: string, rel: string): Promise<void> => {
  const log = (ok: boolean, message: string): void => { const list = events.get(site) ?? []; list.unshift({ at: Date.now(), path: rel, ok, message }); events.set(site, list.slice(0, 30)); };
  try {
    const full = resolve(dir, rel);
    if (!full.startsWith(dir + sep) || !existsSync(full) || !statSync(full).isFile() || !TEXT.test(rel)) return;
    const content = readFileSync(full, 'utf8');
    const manifest = readManifest(dir);
    if (!manifest) return;
    if (manifest.files[rel] === sha(content)) return;
    await siteCall(app, site, 'design.theme_file_write', { path: rel, content }, true);
    manifest.files[rel] = sha(content);
    writeManifest(dir, manifest);
    app.store.log({ principal: 'workspace', principal_name: 'Workspace sync', tool: 'design', action: 'theme_file_write', site, level: 'admin', status: 'ok', summary: `live sync ${rel}`, request_id: 'ws', revision: 0 });
    log(true, 'pushed');
  } catch (error) {
    log(false, error instanceof Error ? error.message : 'failed');
  }
};

export function startWatch(app: App, site: string): { dir: string } {
  const dir = wsDir(app, site);
  if (!readManifest(dir)) throw new Error('Pull the theme first.');
  if (watchers.has(site)) return { dir };
  const timers = new Map<string, NodeJS.Timeout>();
  const watcher = watch(dir, { recursive: true }, (_event, name) => {
    if (!name || name.startsWith('.') || name.includes(`${sep}.`)) return;
    const rel = name.split(sep).join('/');
    clearTimeout(timers.get(rel));
    timers.set(rel, setTimeout(() => { timers.delete(rel); void push(app, site, dir, rel); }, 450));
  });
  watchers.set(site, { watcher, timers });

  return { dir };
}

export function stopWatch(site: string): void {
  const w = watchers.get(site);
  w?.watcher.close();
  w?.timers.forEach(clearTimeout);
  watchers.delete(site);
}

export const status = (app: App, site: string): { watching: boolean; dir: string; pulled: boolean; events: WsEvent[]; files: number } => {
  const dir = wsDir(app, site);
  const m = readManifest(dir);

  return { watching: watchers.has(site), dir, pulled: !!m, events: events.get(site) ?? [], files: m ? Object.keys(m.files).length : 0 };
};

export const stopAll = (): void => { for (const s of [...watchers.keys()]) stopWatch(s); };
