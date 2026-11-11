import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLevel, type Level } from './levels.ts';

export interface Config {
  publicUrl: string;
  host: string;
  port: number;
  dataDir: string;
  masterKey: Buffer;
  /** Allow sites on private/loopback addresses (development only). */
  allowPrivateSites: boolean;
  /** Allow http:// site URLs (development only). */
  allowInsecureSites: boolean;
  /** Accept self-signed or otherwise untrusted TLS certificates from sites (the signed replies still authenticate the bridge). */
  allowSelfSignedSites: boolean;
  trustProxy: boolean;
  /** Passwordless panel for this computer only (command "local"). */
  localPanel: boolean;
  /** Remote connector without a login (Claude.ai through a tunnel): OAuth approves itself at this level for every site. Only with the local panel. */
  connectorLevel?: Level;
  accessTtl: number;
  refreshTtl: number;
  refreshGrace: number;
  limits: { clientPerMin: number; writePerMin: number; sitePerMin: number; tokenPerMin: number; registerPerHour: number; loginPer10Min: number };
  adminPassword?: string;
}

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

function masterKey(dataDir: string, env: NodeJS.ProcessEnv): Buffer {
  const fromEnv = env.WPMCP_MASTER_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, /^[0-9a-f]{64}$/i.test(fromEnv) ? 'hex' : 'base64');
    if (key.length !== 32) throw new Error('WPMCP_MASTER_KEY must be 32 bytes (64 hex chars or base64).');
    return key;
  }
  const file = join(dataDir, 'master.key');
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  const key = randomBytes(32);
  writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  return key;
}

/** One fixed folder next to the project (gateway/dist -> ../../wpmcp-data), never the current directory, so every way of starting WP MCP sees the same sites. */
const DEFAULT_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'wpmcp-data');

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = resolve(overrides.dataDir ?? env.WPMCP_DATA_DIR ?? DEFAULT_DATA_DIR);
  mkdirSync(dataDir, { recursive: true });
  const port = overrides.port ?? num(env.PORT ?? env.WPMCP_PORT, 8787);
  const publicUrl = (overrides.publicUrl ?? env.WPMCP_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  return {
    publicUrl,
    host: env.WPMCP_HOST ?? '0.0.0.0',
    port,
    dataDir,
    masterKey: overrides.masterKey ?? masterKey(dataDir, env),
    allowPrivateSites: env.WPMCP_ALLOW_PRIVATE_SITES === '1',
    allowInsecureSites: env.WPMCP_ALLOW_INSECURE_SITES === '1',
    allowSelfSignedSites: env.WPMCP_ALLOW_SELF_SIGNED === '1',
    trustProxy: env.WPMCP_TRUST_PROXY === '1',
    localPanel: env.WPMCP_LOCAL_PANEL === '1',
    connectorLevel: env.WPMCP_LOCAL_PANEL === '1' && isLevel(env.WPMCP_CONNECTOR_LEVEL) ? env.WPMCP_CONNECTOR_LEVEL : undefined,
    accessTtl: num(env.WPMCP_ACCESS_TTL, 3600),
    refreshTtl: num(env.WPMCP_REFRESH_TTL, 180 * 86400),
    refreshGrace: num(env.WPMCP_REFRESH_GRACE, 600),
    limits: { clientPerMin: 240, writePerMin: 60, sitePerMin: 400, tokenPerMin: 30, registerPerHour: 10, loginPer10Min: 10 },
    adminPassword: env.WPMCP_ADMIN_PASSWORD,
    ...overrides,
  };
}
