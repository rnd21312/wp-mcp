import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const blocked = new net.BlockList();
for (const [net4, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net4, bits, 'ipv4');
for (const [net6, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64]] as const) blocked.addSubnet(net6, bits, 'ipv6');

/** True for loopback, private, link-local, metadata, multicast and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '');
  const family = net.isIP(ip);
  if (family === 0) return true;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return isPrivateAddress(mapped[1]);
    return blocked.check(ip, 'ipv6');
  }
  return blocked.check(ip, 'ipv4');
}

export interface UrlPolicy {
  allowPrivate: boolean;
  allowHttp: boolean;
}

export class SsrfError extends Error {}

/** Cheap checks that need no DNS: scheme, credentials, literal IPs, obviously local names. */
export function assertUrlShape(raw: string, policy: UrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('Invalid URL.');
  }
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) throw new SsrfError('Only https:// URLs are allowed.');
  if (url.username || url.password) throw new SsrfError('URLs with credentials are not allowed.');
  if (!policy.allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new SsrfError('Local host names are not allowed.');
    if (net.isIP(host) && isPrivateAddress(host)) throw new SsrfError('Private or reserved addresses are not allowed.');
  }
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

/** DNS lookup that rejects private answers at connect time, which also defeats DNS rebinding. */
function guardedLookup(policy: UrlPolicy) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as dns.LookupAddress[];
      if (!policy.allowPrivate && list.some((entry) => isPrivateAddress(entry.address))) {
        return callback(Object.assign(new Error('Address is private or reserved.'), { code: 'ESSRF' }) as NodeJS.ErrnoException);
      }
      if (options.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

export interface SafeRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface SafeResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** One HTTP request. Redirects are never followed: a 3xx comes back as-is. */
export function safeRequest(raw: string, policy: UrlPolicy, init: SafeRequest = {}): Promise<SafeResponse> {
  const url = assertUrlShape(raw, policy);
  const client = url.protocol === 'https:' ? https : http;
  const maxBytes = init.maxBytes ?? 20 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      { method: init.method ?? 'GET', headers: init.headers, lookup: guardedLookup(policy) as never, timeout: init.timeoutMs ?? 25000, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooBig = false;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            tooBig = true;
            req.destroy(new Error('Response too large.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => (tooBig ? reject(new Error('Response too large.')) : resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('Request timed out.'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
