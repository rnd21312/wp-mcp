import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError, normalizeAgentUrl } from './agentclient.ts';
import type { App } from './context.ts';
import { encrypt } from './crypto.ts';
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
