import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { Level } from './levels.ts';

// node:sqlite is loaded through require so bundlers and test runners do not try to resolve it.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type SiteScope = '*' | string[];

export interface SiteRow {
  name: string;
  url: string;
  key_id: string;
  secret_enc: string;
  max_level: Level;
  status: 'ok' | 'error' | 'new';
  created: number;
  last_ok: number;
  last_error: string;
  wp_version: string;
  plugin_version: string;
  title: string;
}

export interface KeyRow {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  level: Level;
  sites: string;
  created: number;
  last_used: number;
  expires: number;
  revoked: number;
}

export interface ClientRow {
  id: string;
  name: string;
  redirect_uris: string;
  created: number;
  last_used: number;
}

export interface GrantRow {
  client_id: string;
  level: Level;
  sites: string;
  created: number;
  updated: number;
}

export interface CodeRow {
  hash: string;
  client_id: string;
  redirect_uri: string;
  challenge: string;
  level: Level;
  sites: string;
  expires: number;
}

export interface TokenRow {
  hash: string;
  kind: 'access' | 'refresh';
  client_id: string;
  family: string;
  level: Level;
  sites: string;
  expires: number;
  created: number;
  rotated_at: number;
  revoked: number;
}

export interface ActivityRow {
  id: number;
  ts: number;
  principal: string;
  principal_name: string;
  tool: string;
  action: string;
  site: string;
  level: string;
  status: string;
  summary: string;
  request_id: string;
  revision: number;
}

export interface HostRow {
  name: string;
  url: string;
  key_id: string;
  secret_enc: string;
  level: string;
  status: 'ok' | 'error' | 'new';
  created: number;
  last_ok: number;
  last_error: string;
  agent_version: string;
  caps: string;
}

export interface ProjectRow {
  name: string;
  kind: string;
  host: string;
  site: string;
  publish: string;
  created: number;
  last_deploy: number;
  last_release: string;
}

export const parseScope = (raw: string): SiteScope => {
  const value = JSON.parse(raw) as unknown;
  return Array.isArray(value) && value.length === 1 && value[0] === '*' ? '*' : (value as string[]);
};

export const encodeScope = (scope: SiteScope): string => JSON.stringify(scope === '*' ? ['*'] : scope);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), pass_hash TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sites (
  name TEXT PRIMARY KEY, url TEXT NOT NULL, key_id TEXT NOT NULL, secret_enc TEXT NOT NULL, max_level TEXT NOT NULL DEFAULT 'admin',
  status TEXT NOT NULL DEFAULT 'new', created INTEGER NOT NULL, last_ok INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
  wp_version TEXT NOT NULL DEFAULT '', plugin_version TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, level TEXT NOT NULL, sites TEXT NOT NULL,
  created INTEGER NOT NULL, last_used INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS oauth_grants (client_id TEXT PRIMARY KEY, level TEXT NOT NULL, sites TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_codes (hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, level TEXT NOT NULL, sites TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, family TEXT NOT NULL, level TEXT NOT NULL, sites TEXT NOT NULL,
  expires INTEGER NOT NULL, created INTEGER NOT NULL, rotated_at INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens (family);
CREATE INDEX IF NOT EXISTS oauth_tokens_client ON oauth_tokens (client_id);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, principal TEXT NOT NULL, principal_name TEXT NOT NULL, tool TEXT NOT NULL, action TEXT NOT NULL,
  site TEXT NOT NULL, level TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, request_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS activity_site ON activity (site, id);
CREATE TABLE IF NOT EXISTS ai_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, preset TEXT NOT NULL, type TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, key_enc TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hosts (
  name TEXT PRIMARY KEY, url TEXT NOT NULL, key_id TEXT NOT NULL, secret_enc TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'admin', status TEXT NOT NULL DEFAULT 'new',
  created INTEGER NOT NULL, last_ok INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', agent_version TEXT NOT NULL DEFAULT '', caps TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS projects (
  name TEXT PRIMARY KEY, kind TEXT NOT NULL, host TEXT NOT NULL DEFAULT '', site TEXT NOT NULL DEFAULT '', publish TEXT NOT NULL DEFAULT '.', created INTEGER NOT NULL,
  last_deploy INTEGER NOT NULL DEFAULT 0, last_release TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS idempotency (k TEXT PRIMARY KEY, created INTEGER NOT NULL, args_hash TEXT NOT NULL, response TEXT NOT NULL);
`;

type Row = Record<string, unknown>;

export class Store {
  readonly db: InstanceType<typeof DatabaseSync>;

  constructor(path: string, private now: () => number = () => Math.floor(Date.now() / 1000)) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  clock(): number {
    return this.now();
  }

  private one<T>(sql: string, ...params: (string | number)[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: (string | number)[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private run(sql: string, ...params: (string | number)[]): void {
    this.db.prepare(sql).run(...params);
  }

  /* owner */

  ownerHash(): string | null {
    return this.one<{ pass_hash: string }>('SELECT pass_hash FROM owner WHERE id = 1')?.pass_hash ?? null;
  }

  setOwnerHash(hash: string): void {
    this.run('INSERT INTO owner (id, pass_hash, created) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET pass_hash = excluded.pass_hash', hash, this.now());
  }

  /* sites */

  addSite(site: Pick<SiteRow, 'name' | 'url' | 'key_id' | 'secret_enc' | 'max_level' | 'title' | 'wp_version' | 'plugin_version'>): void {
    this.run(
      `INSERT INTO sites (name, url, key_id, secret_enc, max_level, status, created, title, wp_version, plugin_version, last_ok) VALUES (?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?, ?)`,
      site.name, site.url, site.key_id, site.secret_enc, site.max_level, this.now(), site.title, site.wp_version, site.plugin_version, this.now(),
    );
  }

  site(name: string): SiteRow | undefined {
    return this.one<SiteRow>('SELECT * FROM sites WHERE name = ?', name);
  }

  sites(): SiteRow[] {
    return this.all<SiteRow>('SELECT * FROM sites ORDER BY name');
  }

  removeSite(name: string): void {
    this.run('DELETE FROM sites WHERE name = ?', name);
  }

  setSiteLevel(name: string, level: Level): void {
    this.run('UPDATE sites SET max_level = ? WHERE name = ?', level, name);
  }

  siteHealth(name: string, ok: boolean, detail = '', info: { wp?: string; plugin?: string; title?: string } = {}): void {
    if (ok) {
      this.run(
        `UPDATE sites SET status = 'ok', last_ok = ?, last_error = '', wp_version = COALESCE(NULLIF(?, ''), wp_version), plugin_version = COALESCE(NULLIF(?, ''), plugin_version), title = COALESCE(NULLIF(?, ''), title) WHERE name = ?`,
        this.now(), info.wp ?? '', info.plugin ?? '', info.title ?? '', name,
      );
    } else {
      this.run(`UPDATE sites SET status = 'error', last_error = ? WHERE name = ?`, detail.slice(0, 300), name);
    }
  }

  /* api keys */

  addKey(key: Pick<KeyRow, 'id' | 'name' | 'hash' | 'prefix' | 'level' | 'sites' | 'expires'>): void {
    this.run('INSERT INTO api_keys (id, name, hash, prefix, level, sites, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', key.id, key.name, key.hash, key.prefix, key.level, key.sites, this.now(), key.expires);
  }

  keyByHash(hash: string): KeyRow | undefined {
    return this.one<KeyRow>('SELECT * FROM api_keys WHERE hash = ?', hash);
  }

  keys(): KeyRow[] {
    return this.all<KeyRow>('SELECT * FROM api_keys ORDER BY created DESC');
  }

  touchKey(id: string): void {
    this.run('UPDATE api_keys SET last_used = ? WHERE id = ?', this.now(), id);
  }

  revokeKey(id: string): void {
    this.run('UPDATE api_keys SET revoked = 1 WHERE id = ?', id);
  }

  /* oauth */

  addClient(client: Pick<ClientRow, 'id' | 'name' | 'redirect_uris'>): void {
    this.run('INSERT INTO oauth_clients (id, name, redirect_uris, created) VALUES (?, ?, ?, ?)', client.id, client.name, client.redirect_uris, this.now());
  }

  client(id: string): ClientRow | undefined {
    return this.one<ClientRow>('SELECT * FROM oauth_clients WHERE id = ?', id);
  }

  clients(): (ClientRow & { grant_level: string | null; grant_sites: string | null })[] {
    return this.all('SELECT c.*, g.level AS grant_level, g.sites AS grant_sites FROM oauth_clients c LEFT JOIN oauth_grants g ON g.client_id = c.id ORDER BY c.created DESC');
  }

  touchClient(id: string): void {
    this.run('UPDATE oauth_clients SET last_used = ? WHERE id = ?', this.now(), id);
  }

  removeClient(id: string): void {
    this.run('DELETE FROM oauth_tokens WHERE client_id = ?', id);
    this.run('DELETE FROM oauth_codes WHERE client_id = ?', id);
    this.run('DELETE FROM oauth_grants WHERE client_id = ?', id);
    this.run('DELETE FROM oauth_clients WHERE id = ?', id);
  }

  countClients(): number {
    return (this.one<{ n: number }>('SELECT COUNT(*) AS n FROM oauth_clients')?.n ?? 0) as number;
  }

  setGrant(clientId: string, level: Level, sites: string): void {
    this.run(
      'INSERT INTO oauth_grants (client_id, level, sites, created, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET level = excluded.level, sites = excluded.sites, updated = excluded.updated',
      clientId, level, sites, this.now(), this.now(),
    );
  }

  grant(clientId: string): GrantRow | undefined {
    return this.one<GrantRow>('SELECT * FROM oauth_grants WHERE client_id = ?', clientId);
  }

  putCode(code: CodeRow): void {
    this.run('INSERT INTO oauth_codes (hash, client_id, redirect_uri, challenge, level, sites, expires) VALUES (?, ?, ?, ?, ?, ?, ?)', code.hash, code.client_id, code.redirect_uri, code.challenge, code.level, code.sites, code.expires);
  }

  /** Single use: the row is gone after this call, valid or not. */
  takeCode(hash: string): CodeRow | undefined {
    const row = this.one<CodeRow>('SELECT * FROM oauth_codes WHERE hash = ?', hash);
    if (row) this.run('DELETE FROM oauth_codes WHERE hash = ?', hash);
    return row && row.expires > this.now() ? row : undefined;
  }

  putToken(row: Omit<TokenRow, 'rotated_at' | 'revoked'>): void {
    this.run('INSERT INTO oauth_tokens (hash, kind, client_id, family, level, sites, expires, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', row.hash, row.kind, row.client_id, row.family, row.level, row.sites, row.expires, row.created);
  }

  token(hash: string): TokenRow | undefined {
    return this.one<TokenRow>('SELECT * FROM oauth_tokens WHERE hash = ?', hash);
  }

  markRotated(hash: string): void {
    // Rotated tokens stay for a week so reuse can be recognised, then expire like any other row.
    this.run('UPDATE oauth_tokens SET rotated_at = ?, expires = MIN(expires, ?) WHERE hash = ?', this.now(), this.now() + 7 * 86400, hash);
  }

  revokeFamily(family: string): void {
    this.run('DELETE FROM oauth_tokens WHERE family = ?', family);
  }

  revokeClientTokens(clientId: string): void {
    this.run('DELETE FROM oauth_tokens WHERE client_id = ?', clientId);
  }

  /* activity */

  log(row: Omit<ActivityRow, 'id' | 'ts'>): number {
    const result = this.db
      .prepare('INSERT INTO activity (ts, principal, principal_name, tool, action, site, level, status, summary, request_id, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.now(), row.principal, row.principal_name, row.tool, row.action, row.site, row.level, row.status, row.summary.slice(0, 400), row.request_id, row.revision);
    return Number(result.lastInsertRowid);
  }

  activity(filter: { site?: string; principal?: string; limit?: number; before?: number } = {}): ActivityRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.site) { where.push('site = ?'); params.push(filter.site); }
    if (filter.principal) { where.push('principal = ?'); params.push(filter.principal); }
    if (filter.before) { where.push('id < ?'); params.push(filter.before); }
    params.push(Math.min(filter.limit ?? 50, 200));
    return this.all<ActivityRow>(`SELECT * FROM activity ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, ...params);
  }

  /* ai providers */

  aiProviders(): { id: string; name: string; preset: string; type: string; base_url: string; model: string; key_enc: string; created: number }[] {
    return this.all('SELECT * FROM ai_providers ORDER BY created');
  }

  aiProvider(id: string) {
    return this.aiProviders().find((p) => p.id === id);
  }

  addAiProvider(p: { id: string; name: string; preset: string; type: string; base_url: string; model: string; key_enc: string }): void {
    this.run('INSERT INTO ai_providers (id, name, preset, type, base_url, model, key_enc, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', p.id, p.name, p.preset, p.type, p.base_url, p.model, p.key_enc, this.now());
  }

  removeAiProvider(id: string): void {
    this.run('DELETE FROM ai_providers WHERE id = ?', id);
  }

  /* hosts (Host Agents) */

  addHost(h: Pick<HostRow, 'name' | 'url' | 'key_id' | 'secret_enc' | 'level'>): void {
    this.run(`INSERT INTO hosts (name, url, key_id, secret_enc, level, status, created) VALUES (?, ?, ?, ?, ?, 'new', ?)`, h.name, h.url, h.key_id, h.secret_enc, h.level, this.now());
  }

  host(name: string): HostRow | undefined {
    return this.one<HostRow>('SELECT * FROM hosts WHERE name = ?', name);
  }

  hosts(): HostRow[] {
    return this.all<HostRow>('SELECT * FROM hosts ORDER BY name');
  }

  removeHost(name: string): void {
    this.run('DELETE FROM hosts WHERE name = ?', name);
    this.run("UPDATE projects SET host = '', site = '' WHERE host = ?", name);
  }

  hostHealth(name: string, ok: boolean, detail = '', info: { version?: string; caps?: unknown } = {}): void {
    if (ok) {
      this.run(
        `UPDATE hosts SET status = 'ok', last_ok = ?, last_error = '', agent_version = COALESCE(NULLIF(?, ''), agent_version), caps = COALESCE(NULLIF(?, ''), caps) WHERE name = ?`,
        this.now(), info.version ?? '', info.caps === undefined ? '' : JSON.stringify(info.caps), name,
      );
    } else {
      this.run("UPDATE hosts SET status = 'error', last_error = ? WHERE name = ?", detail.slice(0, 300), name);
    }
  }

  /* projects */

  addProject(p: Pick<ProjectRow, 'name' | 'kind' | 'publish'>): void {
    this.run('INSERT INTO projects (name, kind, publish, created) VALUES (?, ?, ?, ?)', p.name, p.kind, p.publish, this.now());
  }

  project(name: string): ProjectRow | undefined {
    return this.one<ProjectRow>('SELECT * FROM projects WHERE name = ?', name);
  }

  projects(): ProjectRow[] {
    return this.all<ProjectRow>('SELECT * FROM projects ORDER BY name');
  }

  removeProject(name: string): void {
    this.run('DELETE FROM projects WHERE name = ?', name);
  }

  setProjectPublish(name: string, publish: string): void {
    this.run('UPDATE projects SET publish = ? WHERE name = ?', publish, name);
  }

  projectDeployed(name: string, host: string, site: string, release: string): void {
    this.run('UPDATE projects SET host = ?, site = ?, last_release = ?, last_deploy = ? WHERE name = ?', host, site, release, this.now(), name);
  }

  /* idempotency */

  idem(key: string): { args_hash: string; response: string } | undefined {
    return this.one('SELECT args_hash, response FROM idempotency WHERE k = ? AND created > ?', key, this.now() - 86400);
  }

  putIdem(key: string, argsHash: string, response: string): void {
    this.run('INSERT OR REPLACE INTO idempotency (k, created, args_hash, response) VALUES (?, ?, ?, ?)', key, this.now(), argsHash, response);
  }

  /** Housekeeping: expired codes/tokens, old idempotency rows, activity beyond the newest 20000, unused clients. */
  purge(): void {
    const now = this.now();
    this.run('DELETE FROM oauth_codes WHERE expires < ?', now);
    this.run('DELETE FROM oauth_tokens WHERE expires < ?', now);
    this.run('DELETE FROM idempotency WHERE created < ?', now - 86400);
    this.run('DELETE FROM activity WHERE id <= (SELECT COALESCE(MAX(id), 0) - 20000 FROM activity)');
    this.run('DELETE FROM oauth_clients WHERE created < ? AND id NOT IN (SELECT client_id FROM oauth_grants)', now - 86400);
  }

  close(): void {
    this.db.close();
  }
}

export type { Row };
