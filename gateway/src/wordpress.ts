import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError } from './agentclient.ts';
import type { App } from './context.ts';
import { needHost } from './hosts.ts';
import { addSite, SITE_NAME, suggestName } from './siteadmin.ts';
import { safeRequest } from './ssrf.ts';
import type { SiteRow } from './store.ts';
import { createZip, type ZipEntry } from './zip.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** The bridge plugin sources: next to the build (dist/plugin) or in the repository. */
export function bridgeSourceDir(): string {
  const found = [resolve(here, 'plugin'), resolve(here, '..', '..', 'plugin', 'wp-mcp-bridge'), resolve(here, '..', 'plugin', 'wp-mcp-bridge')].find((d) => existsSync(join(d, 'wp-mcp-bridge.php')));
  if (!found) throw new Error('The WP MCP Bridge plugin sources were not found next to the Studio.');

  return found;
}

export function buildBridgeZip(): Buffer {
  const root = bridgeSourceDir();
  const entries: ZipEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else entries.push({ name: `wp-mcp-bridge/${relative(root, full).split(sep).join('/')}`, data: readFileSync(full) });
    }
  };
  walk(root);

  return createZip(entries);
}

export type DbSpec =
  | { method: 'manual'; host?: string; name: string; user: string; pass: string }
  | { method: 'mysql_root'; host?: string; root_user?: string; root_pass: string }
  | { method: 'cpanel'; url: string; user: string; token: string }
  | { method: 'directadmin'; url: string; user: string; key: string };

export interface WordPressInput {
  host: string;
  /** Studio name for the new site (also its id on the host). */
  name?: string;
  folder?: string;
  /** Public address of the new site; derived from the agent address when omitted. */
  url?: string;
  title: string;
  adminUser?: string;
  adminEmail: string;
  adminPassword?: string;
  searchEngines?: boolean;
  locale?: string;
  db: DbSpec;
}

export interface WordPressResult {
  site: SiteRow;
  url: string;
  admin_user: string;
  admin_password: string;
  wp_version: string;
}

export const timing = { retryMs: 1500 };
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Where the new site will be reachable: the agent's web-root address plus the folder. */
export function deriveSiteUrl(agentUrl: string, scriptDir: string, folder: string): string {
  const u = new URL(agentUrl);
  const path = u.pathname.replace(/\/+$/, '');
  const root = scriptDir && path.endsWith(scriptDir) ? path.slice(0, path.length - scriptDir.length) : path.replace(/\/[^/]*$/, '');

  return `${u.origin}${root}/${folder ? folder.replace(/^\/+|\/+$/g, '') + '/' : ''}`.replace(/([^:])\/{2,}/g, '$1/');
}

export async function createWordPress(app: App, input: WordPressInput): Promise<WordPressResult> {
  const host = needHost(app, input.host);
  const caps = JSON.parse(host.caps || '{}') as { server?: { script_dir?: string }; script_dir?: string };
  const name = (input.name?.trim() || suggestName(host.url)).toLowerCase();
  if (!SITE_NAME.test(name)) throw new AgentError('bad_name', 'Site names are 2-40 characters: a-z, 0-9, dot, dash, underscore.');
  if (app.store.site(name)) throw new AgentError('name_taken', `A site named "${name}" is already connected.`);
  const folder = (input.folder ?? name).trim();
  const url = input.url?.trim() || deriveSiteUrl(host.url, caps.script_dir ?? '', folder);
  const adminUser = input.adminUser?.trim() || 'admin-' + randomBytes(2).toString('hex');
  const adminPassword = input.adminPassword || randomBytes(15).toString('base64url');
  if (!/^[A-Za-z0-9_.@-]{3,60}$/.test(adminUser)) throw new AgentError('bad_admin', 'Administrator name: 3-60 letters, digits or . _ - @');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.adminEmail)) throw new AgentError('bad_email', 'Enter a valid administrator email.');
  if (adminPassword.length < 12) throw new AgentError('weak_password', 'The administrator password must be at least 12 characters (leave it empty to generate one).');

  // 1. the site slot on the host
  const created = await app.agents.call<{ site: { id: string } }>(host, 'sites.create', { name, kind: 'wordpress', folder, url });
  const siteId = created.site.id;
  const cleanup = async (): Promise<void> => {
    await app.agents.call(host, 'sites.delete', { site: siteId, purge: false }).catch(() => undefined);
  };

  // 2. files + database + wp-config + bridge (database first on the host: no files if it fails)
  let installed: { wp_version: string };
  try {
    const bridge = await app.agents.upload(host, buildBridgeZip());
    installed = await app.agents.call<{ wp_version: string }>(host, 'wp.install', { site: siteId, db: input.db, bridge_upload: bridge }, { timeoutMs: 600000 });
  } catch (error) {
    await cleanup();
    throw error;
  }

  // 3. the standard WordPress installer, run from here over HTTP (the host often cannot call itself)
  const policy = { allowPrivate: app.config.allowPrivateSites, allowHttp: app.config.allowInsecureSites };
  const form = new URLSearchParams({ weblog_title: input.title, user_name: adminUser, admin_password: adminPassword, admin_password2: adminPassword, admin_email: input.adminEmail, blog_public: input.searchEngines === false ? '0' : '1', pw_weak: '1', Submit: 'Install WordPress', language: input.locale ?? '' }).toString();
  let done = false;
  let lastStatus = 0;
  for (let attempt = 0; attempt < 5 && !done; attempt++) {
    if (attempt) await sleep(timing.retryMs * attempt);
    try {
      const res = await safeRequest(`${url}wp-admin/install.php?step=2`, policy, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(form)) }, body: form, timeoutMs: 120000, maxBytes: 2 * 1024 * 1024 });
      lastStatus = res.status;
      const text = res.body.toString('utf8');
      if (res.status === 200 && /Success!|already installed|نصب شد|وردپرس قبلاً/i.test(text)) done = true;
      else if (res.status >= 300 && res.status < 400) throw new AgentError('site_redirects', `The new site redirects (HTTP ${res.status}). Give the final address (https, www) in the URL field and try again.`);
    } catch (error) {
      if (error instanceof AgentError) throw error;
      lastStatus = 0;
    }
  }
  if (!done) throw new AgentError('wp_install_failed', `WordPress files are on the host, but its installer did not answer correctly at ${url} (last HTTP status ${lastStatus || 'none'}). Open ${url}wp-admin/install.php in a browser to finish by hand; the files and database are ready.`);

  // 4. activate the bridge and let it hand over a pairing code, then pair like any other site
  const finished = await app.agents.call<{ pairing_code: string }>(host, 'wp.finish', { site: siteId, admin_user: adminUser, ceiling: 'admin' });
  const site = await addSite(app, { url: url.replace(/\/$/, ''), code: finished.pairing_code, name });
  app.store.log({ principal: 'studio', principal_name: 'Studio', tool: 'wordpress', action: 'create', site: name, level: 'admin', status: 'ok', summary: `WordPress ${installed.wp_version} created on ${host.name}/${siteId}`, request_id: siteId, revision: 0 });

  return { site, url, admin_user: adminUser, admin_password: adminPassword, wp_version: installed.wp_version };
}
