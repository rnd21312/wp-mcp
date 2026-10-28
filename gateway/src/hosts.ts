import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError, normalizeAgentUrl } from './agentclient.ts';
import type { App } from './context.ts';
import { encrypt } from './crypto.ts';
import { safeRequest } from './ssrf.ts';
import { createZip, type ZipEntry } from './zip.ts';
import type { HostRow } from './store.ts';

export const HOST_NAME = /^[a-z0-9][a-z0-9._-]{1,39}$/;

export function suggestHostName(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '').toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 40);
}

export function hostView(h: HostRow) {
  let caps: unknown = {};
  try {
    caps = JSON.parse(h.caps);
  } catch {
    /* keep empty */
  }

  return { name: h.name, url: h.url, level: h.level, status: h.status, last_ok: h.last_ok, last_error: h.last_error, agent_version: h.agent_version, caps };
}

/** Pairs with a Host Agent using the one-time code from its panel, then makes the first signed round trip. */
export async function addHost(app: App, input: { url: string; code: string; name?: string }): Promise<HostRow> {
  let url: string;
  try {
    url = normalizeAgentUrl(input.url);
  } catch {
    throw new AgentError('bad_url', 'That is not a valid address.');
  }
  const name = (input.name?.trim() || suggestHostName(url)).toLowerCase();
  if (!HOST_NAME.test(name)) throw new AgentError('bad_name', 'Host names are 2-40 characters: a-z, 0-9, dot, dash, underscore.');
  if (app.store.host(name)) throw new AgentError('name_taken', `A host named "${name}" already exists.`);
  if (app.store.hosts().some((h) => h.url === url)) throw new AgentError('url_taken', 'That agent is already connected.');

  const { base, paired } = await app.agents.pair(url, input.code, `Studio (${new URL(app.config.publicUrl).host})`);
  app.store.addHost({ name, url: base, key_id: paired.key_id, secret_enc: encrypt(app.config.masterKey, paired.secret), level: paired.level });
  const test = await testHost(app, name);
  if (!test.ok) throw new AgentError('first_call_failed', `Paired, but the first signed call failed: ${test.detail}`);

  return app.store.host(name)!;
}

/** Signed hello + capability report; updates what the Studio knows about the host. */
export async function testHost(app: App, name: string): Promise<{ ok: boolean; detail: string }> {
  const host = app.store.host(name);
  if (!host) return { ok: false, detail: 'Unknown host.' };
  try {
    const hello = await app.agents.call<{ version: string }>(host, 'hello', {}, { retry: true });
    const caps = await app.agents.call<Record<string, any>>(host, 'host.info', {}, { retry: true });
    app.store.hostHealth(name, true, '', { version: hello.version, caps });
    return { ok: true, detail: `Agent ${hello.version}, PHP ${caps.php?.version ?? '?'}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed.';
    app.store.hostHealth(name, false, message);
    return { ok: false, detail: message };
  }
}

export function needHost(app: App, name: string): HostRow {
  const host = app.store.host(name);
  if (!host) throw new AgentError('no_host', `Unknown host "${name}".`, 404);
  if (host.status === 'error' && !host.last_ok) throw new AgentError('host_down', host.last_error || 'The host is not reachable.');

  return host;
}

// ---- the agent zip ----------------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));

/** Where the agent sources live: next to the build (dist/agent) or in the repository (agent/wpm-agent). */
export function agentSourceDir(): string {
  const candidates = [resolve(here, 'agent'), resolve(here, '..', '..', 'agent', 'wpm-agent'), resolve(here, '..', 'agent', 'wpm-agent')];
  const found = candidates.find((dir) => existsSync(join(dir, 'index.php')));
  if (!found) throw new Error('The Host Agent sources were not found next to the Studio. Reinstall or download wpm-agent.zip from the releases page.');

  return found;
}

/** The setup code is baked into the zip so the person never has to dig for a file on the host. */
export function newSetupCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  const groups = Array.from({ length: 4 }, (_, g) => Array.from({ length: 4 }, (_, i) => alphabet[bytes[g * 4 + i] % alphabet.length]).join(''));

  return `WPMS-${groups.join('-')}`;
}

export function buildAgentZip(setupCode = newSetupCode()): { zip: Buffer; setupCode: string; files: number } {
  const root = agentSourceDir();
  const entries: ZipEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (name === 'data' || name === 'data-location.php' || name === 'wpm-setup.php' || name === '.DS_Store') continue;
      if (readdirSyncSafe(full)) walk(full);
      else entries.push({ name: `wpm-agent/${relative(root, full).split(sep).join('/')}`, data: readFileSync(full) });
    }
  };
  walk(root);
  const plugin = [resolve(here, 'plugin'), resolve(here, '..', '..', 'plugin', 'wp-mcp-bridge'), resolve(here, '..', 'plugin', 'wp-mcp-bridge')].find((d) => existsSync(join(d, 'wp-mcp-bridge.php')));
  if (plugin) {
    const walkPlugin = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        if (readdirSyncSafe(full)) walkPlugin(full);
        else entries.push({ name: `wpm-agent/bridge/wp-mcp-bridge/${relative(plugin, full).split(sep).join('/')}`, data: readFileSync(full) });
      }
    };
    walkPlugin(plugin);
  }
  entries.push({ name: 'wpm-agent/wpm-setup.php', data: Buffer.from(`<?php\ndefined('WPM_AGENT') || exit;\nreturn '${setupCode}';\n`) });
  entries.push({ name: 'wpm-agent/README.txt', data: Buffer.from(AGENT_README) });

  return { zip: createZip(entries), setupCode, files: entries.length };
}

const readdirSyncSafe = (path: string): boolean => {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
};

const AGENT_README = `WPM Host Agent
==============
1. Upload this folder (wpm-agent) to your hosting, next to your site files (for example inside public_html).
   Easiest: upload wpm-agent.zip in your hosting file manager and click Extract.
2. Open https://YOUR-DOMAIN/wpm-agent/ in a browser.
3. Enter the setup code from the Studio, choose a username and a strong password. Done.
4. In the agent panel press "Make a pairing code" and enter it in the Studio (Hosts page).

Needs PHP 8.1 or newer. Use HTTPS. The agent never runs shell commands and only writes inside the folders you let it manage.
Open source (MIT).
`;

// ---- signed updates and host checks -----------------------------------------------------------------------------

export interface AgentRelease {
  version: string;
  zip: string;
  sig: string;
}

/** The signed agent release shipped with this Studio (scripts/release.mjs), or null on an unsigned/dev build. */
export const releasePaths: { dirs?: string[] } = {};

export function agentRelease(): AgentRelease | null {
  const dirs = releasePaths.dirs ?? [resolve(here, 'agent-release'), resolve(here, '..', 'dist', 'agent-release'), resolve(here, '..', '..', 'dist')];
  for (const dir of dirs) {
    const zip = join(dir, 'wpm-agent.zip');
    const sig = join(dir, 'wpm-agent.zip.sig');
    if (!existsSync(zip) || !existsSync(sig)) continue;
    // release.mjs writes the version of the signed zip next to it; fall back to the sources for hand-made releases
    const versionFile = join(dir, 'wpm-agent.version');
    const version = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : (/const VERSION = '([^']+)'/.exec(readFileSync(join(agentSourceDir(), 'src', 'Agent.php'), 'utf8'))?.[1] ?? '');
    return { version, zip, sig };
  }

  return null;
}

const newer = (a: string, b: string): boolean => {
  const parts = (v: string): number[] => v.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/** Sends the signed release; the agent verifies the signature itself and refuses anything else. */
export async function updateAgent(app: App, name: string): Promise<{ from: string; to: string }> {
  const host = needHost(app, name);
  const release = agentRelease();
  if (!release) throw new AgentError('no_release', 'This Studio has no signed agent release (it is a development build). Download the agent zip and upload it by hand.');
  if (!newer(release.version, host.agent_version)) throw new AgentError('up_to_date', `The agent is already at ${host.agent_version}.`);
  const uploadId = await app.agents.upload(host, readFileSync(release.zip));
  const out = await app.agents.call<{ from: string; to: string }>(host, 'agent.update', { upload_id: uploadId, signature: readFileSync(release.sig, 'utf8').trim() }, { timeoutMs: 120000 });
  await testHost(app, name);
  app.store.log({ principal: 'studio', principal_name: 'Studio', tool: 'agent', action: 'update', site: name, level: 'admin', status: 'ok', summary: `${out.from} -> ${out.to}`, request_id: out.to, revision: 0 });

  return out;
}

export interface Exposure {
  path: string;
  status: number;
  safe: boolean;
  note: string;
}

/** The agent's own self-test plus a look from outside: can the web reach files it must not? */
export async function checkHost(app: App, name: string): Promise<{ checks: { id: string; status: string; msg: string }[]; exposure: Exposure[] }> {
  const host = needHost(app, name);
  const { checks } = await app.agents.call<{ checks: { id: string; status: string; msg: string }[] }>(host, 'host.selftest', { online: true }, { timeoutMs: 90000 });
  const policy = { allowPrivate: app.config.allowPrivateSites, allowHttp: app.config.allowInsecureSites };
  const exposure: Exposure[] = [];
  for (const path of ['src/Auth.php', 'src/Store.php', 'data-location.php', 'wpm-setup.php', '.htaccess', 'data/config.json.php', 'README.txt']) {
    try {
      const res = await safeRequest(`${host.url}${path}`, policy, { timeoutMs: 15000, maxBytes: 200000 });
      const text = res.body.toString('utf8');
      const leaks = res.status === 200 && /<\?php|defined\(|namespace |"hash"/i.test(text) && text.trim().length > 0;
      exposure.push({ path, status: res.status, safe: !leaks, note: leaks ? 'The web server returned the contents of this file. Block it in the server configuration or move the agent.' : res.status === 200 ? 'Reachable but harmless (no secrets or code).' : 'Not served.' });
    } catch (error) {
      exposure.push({ path, status: 0, safe: true, note: `Not reachable (${error instanceof Error ? error.message.slice(0, 60) : 'error'}).` });
    }
  }

  return { checks, exposure };
}
