import type { App } from './context.ts';
import { encrypt } from './crypto.ts';
import type { Level } from './levels.ts';
import { isLevel, minLevel } from './levels.ts';
import type { SiteRow } from './store.ts';
import { normalizeSiteUrl, SiteError } from './wpclient.ts';

export const SITE_NAME = /^[a-z0-9][a-z0-9._-]{1,39}$/;

export function suggestName(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, '');
  return host.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 40);
}

/** Pairs with the WordPress plugin using a one-time code and stores the signing secret encrypted. */
export async function addSite(app: App, input: { url: string; code: string; name?: string; maxLevel?: Level }): Promise<SiteRow> {
  let url: string;
  try {
    url = normalizeSiteUrl(input.url);
  } catch {
    throw new SiteError('bad_url', 'That is not a valid site URL.');
  }
  const name = (input.name?.trim() || suggestName(url)).toLowerCase();
  if (!SITE_NAME.test(name)) throw new SiteError('bad_name', 'Site names are 2-40 characters: a-z, 0-9, dot, dash, underscore.');
  if (app.store.site(name)) throw new SiteError('name_taken', `A site named "${name}" already exists. Names must be unique.`);
  if (app.store.sites().some((s) => s.url === url)) throw new SiteError('url_taken', 'That site is already connected.');

  const paired = await app.sites.pair(url, input.code, new URL(app.config.publicUrl).host);
  const ceiling = input.maxLevel && isLevel(input.maxLevel) ? input.maxLevel : 'admin';
  app.store.addSite({
    name,
    url,
    key_id: paired.key_id,
    secret_enc: encrypt(app.config.masterKey, paired.secret),
    max_level: minLevel(ceiling, isLevel(paired.ceiling) ? paired.ceiling : 'admin'),
    title: paired.site_title ?? '',
    wp_version: paired.wp_version ?? '',
    plugin_version: paired.plugin_version ?? '',
  });
  await testSite(app, name); // First signed round trip: proves the secret, the clock and the route work.

  return app.store.site(name)!;
}

/** Checks the signed channel and refreshes the stored versions. */
export async function testSite(app: App, name: string): Promise<{ ok: boolean; detail: string }> {
  const site = app.store.site(name);
  if (!site) return { ok: false, detail: 'Unknown site.' };
  try {
    const result = await app.sites.call(site, 'site.ping', {}, { level: 'read', actor: 'gateway', client: 'gateway', requestId: 'test', write: false });
    const data = result.data as { wp_version?: string; plugin_version?: string; title?: string };
    app.store.siteHealth(name, true, '', { wp: data.wp_version, plugin: data.plugin_version, title: data.title });
    return { ok: true, detail: `WordPress ${data.wp_version ?? '?'}, bridge ${data.plugin_version ?? '?'}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed.';
    app.store.siteHealth(name, false, message);
    return { ok: false, detail: message };
  }
}
