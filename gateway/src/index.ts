#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { createApiKey, type Principal } from './auth.ts';
import { prepareSetup } from './admin.ts';
import { loadConfig } from './config.ts';
import { createApp } from './context.ts';
import { hashPassword } from './crypto.ts';
import { startServer } from './http.ts';
import { isLevel } from './levels.ts';
import { handleMessage } from './mcp/server.ts';
import { addSite } from './siteadmin.ts';
import { Store } from './store.ts';
import { join } from 'node:path';

let [command = 'serve', ...rest] = process.argv.slice(2);
const localMode = command === 'local';
if (localMode) {
  // Panel on this computer only: listens on 127.0.0.1, nothing is exposed to the network.
  process.env.WPMCP_HOST = '127.0.0.1';
  command = 'serve';
}

const flag = (name: string, fallback = ''): string => {
  const at = rest.indexOf(`--${name}`);
  return at !== -1 && rest[at + 1] ? rest[at + 1] : fallback;
};

const HELP = `wp-mcp <command>
  serve                           Run the gateway (default)
  local                           Run the web panel for this computer only (127.0.0.1) and open it
  stdio                           MCP over stdin/stdout for a local client (level: WPMCP_STDIO_LEVEL, default live)
  add-site <url> <code> [--name n] [--max-level admin]
  create-key --name n --level read|draft|live|admin [--sites a,b] [--days 90]
  set-password                    Reads WPMCP_NEW_PASSWORD
  sites                           List connected sites
Environment: WPMCP_PUBLIC_URL, PORT, WPMCP_DATA_DIR, WPMCP_ADMIN_PASSWORD, WPMCP_MASTER_KEY, WPMCP_TRUST_PROXY=1
Development only: WPMCP_ALLOW_PRIVATE_SITES=1, WPMCP_ALLOW_INSECURE_SITES=1`;

async function main(): Promise<void> {
  if (['help', '--help', '-h'].includes(command)) return void console.log(HELP);

  const config = loadConfig();
  const store = new Store(join(config.dataDir, 'gateway.sqlite'));
  const app = createApp(config, store);
  store.purge();

  switch (command) {
    case 'serve': {
      const token = prepareSetup(app);
      const server = await startServer(app);
      console.log(`WP MCP gateway listening on ${config.host}:${config.port}`);
      console.log(`MCP endpoint: ${config.publicUrl}/mcp`);
      console.log(`Admin panel:  ${config.publicUrl}/admin`);
      if (token) console.log(`First run: open the admin panel and enter this setup token: ${token}`);
      if (localMode) {
        const { spawn } = await import('node:child_process');
        const target = `http://127.0.0.1:${config.port}/admin`;
        const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]] : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
        spawn(opener[0] as string, opener[1] as string[], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
      }
      if (!config.publicUrl.startsWith('https://')) console.warn('WARNING: WPMCP_PUBLIC_URL is not https. Put the gateway behind HTTPS before connecting Claude.ai or real sites.');
      setInterval(() => store.purge(), 3600_000).unref();
      const stop = (): void => {
        server.close(() => {
          store.close();
          process.exit(0);
        });
        setTimeout(() => process.exit(0), 5000).unref();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }

    case 'stdio': {
      const level = isLevel(process.env.WPMCP_STDIO_LEVEL) ? process.env.WPMCP_STDIO_LEVEL : 'live';
      const principal: Principal = { id: 'stdio', kind: 'stdio', name: 'local stdio', level, sites: '*' };
      const lines = createInterface({ input: process.stdin });
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          const replies = [];
          for (const item of Array.isArray(message) ? message : [message]) {
            const reply = await handleMessage(app, principal, item);
            if (reply) replies.push(reply);
          }
          if (replies.length) process.stdout.write(JSON.stringify(Array.isArray(message) ? replies : replies[0]) + '\n');
        } catch {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
        }
      }
      return;
    }

    case 'add-site': {
      const [url, code] = rest;
      if (!url || !code) throw new Error('Usage: wp-mcp add-site <url> <pairing-code> [--name n]');
      const maxLevel = flag('max-level', 'admin');
      const site = await addSite(app, { url, code, name: flag('name'), maxLevel: isLevel(maxLevel) ? maxLevel : 'admin' });
      console.log(`Connected "${site.name}" (${site.url}), ceiling ${site.max_level}.`);
      return;
    }

    case 'create-key': {
      const level = flag('level', 'read');
      if (!isLevel(level)) throw new Error('--level must be read, draft, live or admin.');
      const names = flag('sites');
      const key = createApiKey(app, { name: flag('name', 'CLI key'), level, sites: names ? names.split(',').map((s) => s.trim()) : '*', expiresInDays: Number(flag('days', '0')) || undefined });
      console.log(key.token);
      console.error('Store this key now; it is not shown again.');
      return;
    }

    case 'set-password': {
      const password = process.env.WPMCP_NEW_PASSWORD ?? '';
      if (password.length < 12) throw new Error('Set WPMCP_NEW_PASSWORD (12+ characters).');
      store.setOwnerHash(hashPassword(password));
      console.log('Owner password updated.');
      return;
    }

    case 'sites':
      for (const s of store.sites()) console.log(`${s.name}\t${s.url}\t${s.status}\tceiling=${s.max_level}`);
      return;

    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().then(
  () => {
    if (!['serve', 'stdio'].includes(command)) process.exit(process.exitCode ?? 0);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
