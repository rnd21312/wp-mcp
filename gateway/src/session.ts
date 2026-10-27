import type { App } from './context.ts';
import { hmacHex, safeEqual, seal, unseal } from './crypto.ts';
import { randomBytes } from 'node:crypto';

const COOKIE = 'wpm_session';
const TTL = 7 * 86400;

export interface Session {
  exp: number;
  n: string;
}

export function newSessionCookie(app: App): string {
  const secure = app.config.publicUrl.startsWith('https://') ? '; Secure' : '';
  const value = seal(app.config.masterKey, { exp: Math.floor(Date.now() / 1000) + TTL, n: randomBytes(12).toString('base64url') });
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL}${secure}`;
}

export const clearSessionCookie = (): string => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export function readSession(app: App, cookieHeader: string | undefined): Session | null {
  const match = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookieHeader ?? '');
  return match ? unseal<Session & Record<string, unknown>>(app.config.masterKey, match[1]) : null;
}

export const csrfToken = (app: App, session: Session): string => hmacHex(app.config.masterKey, `csrf:${session.n}`);

export const checkCsrf = (app: App, session: Session, given: unknown): boolean => typeof given === 'string' && safeEqual(csrfToken(app, session), given);
