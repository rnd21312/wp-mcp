import type { App } from './context.ts';
import { sha256, token } from './crypto.ts';
import type { Level } from './levels.ts';
import { isLevel, minLevel } from './levels.ts';
import { encodeScope, parseScope, type SiteScope } from './store.ts';

export interface Principal {
  /** Stable id used for rate limits, idempotency and the activity log. */
  id: string;
  kind: 'key' | 'oauth' | 'stdio';
  name: string;
  level: Level;
  sites: SiteScope;
  clientId?: string;
}

/**
 * Level of the stdio connection (AI apps started on this computer, e.g. Claude Code or Claude Desktop). The panel can change
 * it; the process reads it on every call, so a change applies at once without restarting the AI app. WPMCP_STDIO_LEVEL is the
 * default when the panel has not set one.
 */
export function stdioLevel(app: App, env: NodeJS.ProcessEnv = process.env): Level {
  const chosen = app.store.setting('stdio_level');
  if (chosen && isLevel(chosen)) return chosen;

  return isLevel(env.WPMCP_STDIO_LEVEL) ? env.WPMCP_STDIO_LEVEL : 'live';
}

export function stdioPrincipal(app: App): Principal {
  return {
    id: 'stdio',
    kind: 'stdio',
    name: 'local stdio',
    sites: '*',
    get level(): Level {
      return stdioLevel(app);
    },
  };
}

export type AuthResult = { principal: Principal } | { error: 'missing' | 'invalid' | 'expired' };

export const KEY_PREFIX = 'wpmk_';
export const ACCESS_PREFIX = 'wpmat_';
export const REFRESH_PREFIX = 'wpmrt_';

export function bearerFrom(headers: Record<string, string | string[] | undefined>): string {
  const auth = String(headers.authorization ?? '');
  if (/^bearer /i.test(auth)) return auth.slice(7).trim();
  return String(headers['x-api-key'] ?? '').trim();
}

export function authenticate(app: App, bearer: string): AuthResult {
  if (!bearer) return { error: 'missing' };
  const hash = sha256(bearer);
  const now = app.store.clock();

  if (bearer.startsWith(KEY_PREFIX)) {
    const key = app.store.keyByHash(hash);
    if (!key || key.revoked) return { error: 'invalid' };
    if (key.expires && key.expires < now) return { error: 'expired' };
    if (now - key.last_used > 60) app.store.touchKey(key.id);
    return { principal: { id: `key:${key.id}`, kind: 'key', name: key.name, level: key.level, sites: parseScope(key.sites) } };
  }

  if (bearer.startsWith(ACCESS_PREFIX)) {
    const row = app.store.token(hash);
    if (!row || row.kind !== 'access') return { error: 'invalid' };
    if (row.expires < now) return { error: 'expired' };
    const grant = app.store.grant(row.client_id);
    const client = app.store.client(row.client_id);
    if (!grant || !client) return { error: 'invalid' };
    if (now - client.last_used > 60) app.store.touchClient(client.id);
    // The owner's current grant wins over what the token was issued with, so lowering or revoking takes effect at once.
    return { principal: { id: `oauth:${client.id}`, kind: 'oauth', name: client.name, level: minLevel(row.level, grant.level), sites: parseScope(grant.sites), clientId: client.id } };
  }

  return { error: 'invalid' };
}

export function canUseSite(principal: Principal, site: string): boolean {
  return principal.sites === '*' || principal.sites.includes(site);
}

export function createApiKey(app: App, input: { name: string; level: Level; sites: SiteScope; expiresInDays?: number }): { id: string; token: string } {
  if (!isLevel(input.level)) throw new Error('Invalid level.');
  const secret = token(KEY_PREFIX);
  const id = token('', 6);
  app.store.addKey({
    id,
    name: input.name.slice(0, 80) || 'API key',
    hash: sha256(secret),
    prefix: secret.slice(0, 9),
    level: input.level,
    sites: encodeScope(input.sites),
    expires: input.expiresInDays ? app.store.clock() + input.expiresInDays * 86400 : 0,
  });
  return { id, token: secret };
}
