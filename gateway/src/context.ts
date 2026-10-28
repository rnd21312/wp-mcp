import type { Config } from './config.ts';
import { RateLimiter } from './ratelimit.ts';
import { SiteClient } from './wpclient.ts';
import type { Store } from './store.ts';

/** Everything a request handler needs. Built once per process (or per test). */
export interface App {
  config: Config;
  store: Store;
  limiter: RateLimiter;
  sites: SiteClient;
}

export function createApp(config: Config, store: Store, parts: Partial<Pick<App, 'limiter' | 'sites'>> = {}): App {
  return { config, store, limiter: parts.limiter ?? new RateLimiter(), sites: parts.sites ?? new SiteClient(config) };
}

/** What a handler returns; the HTTP layer turns it into a response. */
export interface Reply {
  status: number;
  headers?: Record<string, string>;
  cookies?: string[];
  json?: unknown;
  html?: string;
  body?: Buffer;
  text?: string;
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({ status, json: body, headers: { 'cache-control': 'no-store', ...headers } });
