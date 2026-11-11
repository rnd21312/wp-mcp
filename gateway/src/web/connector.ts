import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../core/context.ts';
import { isLevel, type Level } from '../core/levels.ts';

/**
 * Claude.ai connector for the local panel: a temporary cloudflared quick tunnel gives this computer a public https
 * address, and OAuth approves itself (no login) at the chosen level. The address changes every time it is started.
 */

interface Running {
  child: ChildProcess;
  url: string;
  level: Level;
  before: { publicUrl: string; trustProxy: boolean };
}

let running: Running | null = null;
let starting = false;

export const parseTunnelUrl = (text: string): string | null => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text)?.[0] ?? null;

/** cloudflared on PATH, or where the Windows installer puts it (a terminal opened before the install does not see PATH changes). */
export function findCloudflared(): string | null {
  const candidates = [
    'cloudflared',
    ...(process.platform === 'win32'
      ? [
          `${process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)'}/cloudflared/cloudflared.exe`,
          `${process.env.ProgramFiles ?? 'C:/Program Files'}/cloudflared/cloudflared.exe`,
        ]
      : []),
  ];
  for (const c of candidates) {
    if (c !== 'cloudflared' && !existsSync(c)) continue;
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

export const connectorStatus = (app: App): { on: boolean; starting: boolean; installed: boolean; url?: string; level?: Level } => ({
  on: !!running,
  starting,
  installed: running ? true : findCloudflared() !== null,
  url: running ? `${running.url}/mcp` : undefined,
  level: running?.level ?? app.config.connectorLevel,
});

export function stopConnector(app: App): void {
  if (!running) return;
  const { child, before } = running;
  running = null;
  app.config.publicUrl = before.publicUrl;
  app.config.trustProxy = before.trustProxy;
  app.config.connectorLevel = undefined;
  try {
    if (process.platform === 'win32' && child.pid) execFileSync('taskkill', ['/PID', String(child.pid), '/F', '/T'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}

export async function startConnector(
  app: App,
  level: unknown,
  port: number,
): Promise<{ ok: true; url: string } | { ok: false; error: { code: string; message: string } }> {
  const fail = (code: string, message: string) => ({ ok: false as const, error: { code, message } });
  if (!app.config.localPanel) return fail('not_local', 'The connector is only available in the local panel.');
  if (running) return { ok: true, url: `${running.url}/mcp` };
  if (starting) return fail('busy', 'Already starting.');
  const bin = findCloudflared();
  if (!bin)
    return fail('no_cloudflared', 'cloudflared is not installed. Run: winget install Cloudflare.cloudflared (then restart the panel).');
  const chosen: Level = isLevel(level) ? level : 'live';
  starting = true;
  try {
    const child = spawn(bin, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${port}`], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = join(app.config.dataDir, 'tunnel.log');
    writeFileSync(log, '');
    const url = await new Promise<string | null>((resolve) => {
      let text = '';
      const done = (value: string | null): void => {
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => done(null), 30000);
      const feed = (chunk: Buffer): void => {
        appendFileSync(log, chunk);
        text += chunk.toString('utf8');
        const found = parseTunnelUrl(text);
        if (found && /Registered tunnel connection/.test(text)) done(found); // the address exists before the tunnel is connected
      };
      child.stdout?.on('data', feed);
      child.stderr?.on('data', feed);
      child.on('exit', () => done(null));
      child.on('error', () => done(null));
    });
    if (!url) {
      child.kill();
      return fail('tunnel_failed', 'The tunnel did not give an address in 30 seconds.');
    }
    running = { child, url, level: chosen, before: { publicUrl: app.config.publicUrl, trustProxy: app.config.trustProxy } };
    app.config.publicUrl = url;
    app.config.trustProxy = true;
    app.config.connectorLevel = chosen;
    child.on('exit', () => {
      if (running?.child === child) stopConnector(app);
    });
    process.once('exit', () => child.kill());

    return { ok: true, url: `${url}/mcp` };
  } finally {
    starting = false;
  }
}
