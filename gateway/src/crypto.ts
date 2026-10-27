import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export const token = (prefix: string, bytes = 32): string => `${prefix}${randomBytes(bytes).toString('base64url')}`;

export const hmacHex = (key: string | Buffer, data: string): string => createHmac('sha256', key).update(data).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

/** AES-256-GCM; output is base64url(iv | tag | ciphertext). */
export function encrypt(masterKey: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function decrypt(masterKey: Buffer, packed: string): string {
  const raw = Buffer.from(packed, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

/** Signed, expiring blob: base64url(json).hmac. Used for cookies and confirmation tokens. */
export function seal(key: Buffer, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmacHex(key, body)}`;
}

export function unseal<T extends Record<string, unknown>>(key: Buffer, value: string): T | null {
  const [body, mac] = value.split('.');
  if (!body || !mac || !safeEqual(hmacHex(key, body), mac)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number };
    if (typeof payload.exp === 'number' && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Stable JSON (sorted keys) so the same arguments always hash the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
