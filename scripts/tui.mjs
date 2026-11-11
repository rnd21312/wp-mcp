// Terminal control panel for WP MCP: start/stop the panel, see and update your sites, connect new ones, rebuild, check
// everything, build and publish releases. No dependencies. Run: wpmcp.cmd  (or: npm run tui)
// The same actions work without the menu:  node scripts/tui.mjs status | start | stop | restart | sites | doctor | rebuild
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const PORT = Number(process.env.WPMCP_PORT || process.env.PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const WIN = process.platform === 'win32';
const RUN_DIR = join(ROOT, 'wpmcp-run');
const LOG = join(RUN_DIR, 'panel.log');
const BRIDGE = 'wp-mcp-bridge/wp-mcp-bridge.php';

const color = process.env.NO_COLOR ? () => (s) => s : (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const bold = color('1');
const dim = color('2');
const red = color('31');
const green = color('32');
const yellow = color('33');
const cyan = color('36');

/* ------------------------------------------------------------------ pure helpers */

export const olderThan = (a, b) => {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);

  return false;
};

/** PIDs listening on a port from `netstat -ano` output (Windows). */
export const parseNetstat = (text, port) => [
  ...new Set(
    text
      .split(/\r?\n/)
      .map((l) => /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(l))
      .filter((m) => m && Number(m[1]) === port)
      .map((m) => Number(m[2])),
  ),
];

export const pad = (s, n) => (String(s).length >= n ? String(s).slice(0, n - 1) + ' ' : String(s) + ' '.repeat(n - String(s).length));

const version = () => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'gateway', 'package.json'), 'utf8')).version;
  } catch {
    return '?';
  }
};
const built = () =>
  existsSync(join(ROOT, 'gateway', 'dist', 'index.js')) && existsSync(join(ROOT, 'gateway', 'dist', 'panel', 'index.html'));
const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ panel process */

async function call(path, body, timeout = 120000) {
  const res = await fetch(`${BASE}/admin/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-wpm-panel': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

  return await res.json();
}

export async function isUp() {
  try {
    const r = await fetch(`${BASE}/admin/api/state`, { headers: { 'x-wpm-panel': '1' }, signal: AbortSignal.timeout(1500) });

    return r.ok;
  } catch {
    return false;
  }
}

function pidsOn(port) {
  try {
    if (WIN) return parseNetstat(execFileSync('netstat', ['-ano', '-p', 'tcp'], QUIET), port);

    return execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], QUIET)
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function isNodePid(pid) {
  try {
    const out = WIN
      ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], QUIET)
      : execFileSync('ps', ['-p', String(pid), '-o', 'comm='], QUIET);

    return /node/i.test(out);
  } catch {
    return false;
  }
}

export async function startPanel(extraEnv = {}) {
  if (await isUp()) return { ok: true, note: 'Already running.' };
  if (!built()) return { ok: false, note: 'Not built yet. Choose "Rebuild" first.' };
  const busy = [PORT, PORT + 1].filter((p) => pidsOn(p).length);
  if (busy.length) return { ok: false, note: `Port ${busy.join(' and ')} is used by another program. Stop it first.` };
  mkdirSync(RUN_DIR, { recursive: true });
  const fd = openSync(LOG, 'a');
  const child = spawn(process.execPath, [join(ROOT, 'gateway', 'dist', 'index.js'), 'local'], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, WPMCP_PUBLIC_URL: BASE, ...extraEnv },
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await isUp()) return { ok: true, note: `Started at ${BASE}/admin` };
  }

  return { ok: false, note: `It did not come up in 20 seconds. See the log: ${LOG}` };
}

export async function stopPanel() {
  stopTunnel();
  const pids = [...new Set([...pidsOn(PORT), ...pidsOn(PORT + 1)])];
  if (!pids.length) return { ok: true, note: 'Not running.' };
  const left = [];
  for (const pid of pids) {
    if (!isNodePid(pid)) {
      left.push(pid);
      continue;
    }
    try {
      if (WIN) execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore' });
      else process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  for (let i = 0; i < 20 && pidsOn(PORT).length; i++) await sleep(250);

  return left.length
    ? { ok: false, note: `Port in use by a program that is not Node (PID ${left.join(', ')}); left alone.` }
    : { ok: true, note: 'Stopped.' };
}

function openBrowser(url) {
  try {
    if (WIN) spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

/* ------------------------------------------------------------------ Claude.ai connector (tunnel) */

const TUNNEL_PID = join(RUN_DIR, 'tunnel.pid');
const TUNNEL_LOG = join(RUN_DIR, 'tunnel.log');

export const parseTunnelUrl = (text) => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text)?.[0] ?? null;

const findCloudflared = () => {
  const candidates = [
    'cloudflared',
    ...(WIN
      ? [
          join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
          join(process.env.ProgramFiles || 'C:/Program Files', 'cloudflared', 'cloudflared.exe'),
        ]
      : []),
  ];
  for (const c of candidates) {
    if (c !== 'cloudflared' && !existsSync(c)) continue;
    try {
      execFileSync(c, ['--version'], QUIET);

      return c;
    } catch {
      /* try the next one */
    }
  }

  return null;
};

export function stopTunnel() {
  try {
    const pid = Number(readFileSync(TUNNEL_PID, 'utf8'));
    if (pid) {
      if (WIN) execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore' });
      else process.kill(pid, 'SIGTERM');
    }
  } catch {
    /* no tunnel running */
  }
  try {
    unlinkSync(TUNNEL_PID);
  } catch {
    /* none */
  }
}

/** Opens a public https address for this computer and restarts the panel so Claude.ai can connect to it without a login. */
export async function startConnector(level = 'live') {
  if (!built()) return { ok: false, note: 'Not built yet. Choose "Rebuild" first.' };
  const bin = findCloudflared();
  if (!bin)
    return {
      ok: false,
      note: 'cloudflared is not installed. Install it once (winget install Cloudflare.cloudflared), reopen the terminal, and try again.',
    };
  await stopPanel();
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(TUNNEL_LOG, '');
  const fd = openSync(TUNNEL_LOG, 'a');
  const tunnel = spawn(bin, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', BASE], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  tunnel.unref();
  writeFileSync(TUNNEL_PID, String(tunnel.pid));
  let url = null;
  for (let i = 0; i < 60 && !url; i++) {
    await sleep(500);
    const text = readFileSync(TUNNEL_LOG, 'utf8');
    url = /Registered tunnel connection/.test(text) ? parseTunnelUrl(text) : null; // the address exists before the tunnel is connected
  }
  if (!url) {
    stopTunnel();

    return { ok: false, note: `The tunnel did not give an address in 30 seconds. See ${TUNNEL_LOG}` };
  }
  const r = await startPanel({ WPMCP_PUBLIC_URL: url, WPMCP_CONNECTOR_LEVEL: level, WPMCP_TRUST_PROXY: '1' });
  if (!r.ok) {
    stopTunnel();

    return r;
  }

  return { ok: true, url: `${url}/mcp`, note: `Connector address: ${url}/mcp` };
}

async function connectorScreen() {
  const pick = await menu(
    'Claude.ai connector',
    [
      { label: 'Start with level live', hint: 'recommended' },
      { label: 'Start with level admin' },
      { label: 'Start with level draft' },
      { label: 'Stop the connector', hint: 'stops the tunnel and the panel' },
      { label: dim('Back') },
    ],
    [
      dim('Opens a temporary public https address for this computer. The address changes each time.'),
      dim('No login: anyone who knows the address can use your sites. Do not share it. Stop it when done.'),
    ],
  );
  if (pick === -1 || pick === 4) return;
  if (pick === 3) return show([green((await stopPanel()).note)]);
  const r = await startConnector(pick === 0 ? 'live' : pick === 1 ? 'admin' : 'draft');
  if (!r.ok) return show([red(r.note)]);
  await show([
    green('Connector is on.'),
    '',
    `In Claude.ai: Settings → Connectors → Add custom connector, then paste:`,
    '',
    bold(r.url),
    '',
    dim(`Keep the panel running; Stop the connector when you finish.`),
  ]);
}

/* ------------------------------------------------------------------ sites */

async function loadSites(refresh) {
  let state = await call('state');
  if (refresh) {
    await Promise.all(state.sites.map((s) => call('sites/test', { name: s.name }).catch(() => null)));
    state = await call('state');
  }

  return state;
}

async function runTool(site, tool, action, args, ask) {
  const send = (token) => call('run', { site, tool, action, args, level: 'admin', confirm_token: token });
  let r = await send();
  if (r.needs_confirmation) {
    if (!(await ask(r))) return { ok: false, cancelled: true };
    r = await send(r.confirm_token);
  }

  return r;
}

/* ------------------------------------------------------------------ terminal input */

readline.emitKeypressEvents(process.stdin);
const queue = [];
let waiter = null;
process.stdin.on('keypress', (str, key) => {
  const k = { str, name: key?.name, ctrl: !!key?.ctrl, seq: key?.sequence };
  if (k.ctrl && k.name === 'c') {
    cleanup();
    process.exit(130);
  }
  if (waiter) {
    const w = waiter;
    waiter = null;
    w(k);
  } else queue.push(k);
});
process.stdin.on('end', () => {
  if (waiter) {
    const w = waiter;
    waiter = null;
    w({ name: 'escape', eof: true });
  }
});
const nextKey = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => (waiter = r)));
function startInput() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
}
function cleanup() {
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
  }
  process.stdout.write('\x1b[?25h');
}
const clear = () => process.stdout.write(process.stdout.isTTY ? '\x1b[2J\x1b[H' : '\n');
const out = (s = '') => process.stdout.write(s + '\n');

async function menu(title, items, header = []) {
  let i = 0;
  for (;;) {
    clear();
    out(bold(cyan(title)));
    for (const h of header) out(h);
    out();
    items.forEach((it, n) =>
      out(`${n === i ? cyan('›') : ' '} ${n === i ? bold(it.label) : it.label}${it.hint ? '  ' + dim(it.hint) : ''}`),
    );
    out();
    out(dim('↑/↓ move · Enter choose · 1-9 jump · q back'));
    const k = await nextKey();
    if (k.eof || k.name === 'escape' || k.name === 'q') return -1;
    if (k.name === 'up' || k.name === 'k') i = (i + items.length - 1) % items.length;
    else if (k.name === 'down' || k.name === 'j') i = (i + 1) % items.length;
    else if (k.name === 'return') return i;
    else if (/^[1-9]$/.test(k.str || '') && Number(k.str) <= items.length) return Number(k.str) - 1;
  }
}

async function ask(question, def = '') {
  process.stdout.write(`${question}${def ? dim(` [${def}]`) : ''}: `);
  let text = '';
  for (;;) {
    const k = await nextKey();
    if (k.eof || k.name === 'escape') {
      out();
      return null;
    }
    if (k.name === 'return') {
      out();
      return text || def;
    }
    if (k.name === 'backspace') {
      if (text) {
        text = text.slice(0, -1);
        process.stdout.write('\b \b');
      }
    } else if (k.str && k.str >= ' ' && !k.ctrl) {
      text += k.str;
      process.stdout.write(k.str);
    }
  }
}

async function confirm(question) {
  process.stdout.write(`${yellow(question)} ${dim('[y/N]')} `);
  const k = await nextKey();
  out(k.str === 'y' || k.str === 'Y' ? 'y' : 'n');

  return k.str === 'y' || k.str === 'Y';
}

async function pause(text = 'Press any key') {
  out(dim(text));
  await nextKey();
}

async function show(lines) {
  clear();
  for (const l of lines) out(l);
  out();
  await pause();
}

/* ------------------------------------------------------------------ screens */

async function sitesScreen() {
  if (!(await isUp())) {
    if (!(await confirm('The panel is not running. Start it?'))) return;
    const r = await startPanel();
    if (!r.ok) return show([red(r.note)]);
  }
  out(dim('Checking your sites…'));
  let state = await loadSites(true);
  for (;;) {
    const sites = state.sites;
    const header = [dim(`Latest bridge: ${state.version}`), '', dim(pad('SITE', 18) + pad('STATUS', 8) + pad('WORDPRESS', 11) + 'BRIDGE')];
    const items = sites.map((s) => ({
      label:
        pad(s.name, 18) +
        (s.status === 'ok' ? green(pad('ok', 8)) : red(pad(s.status, 8))) +
        pad(s.wp_version || '?', 11) +
        (olderThan(s.plugin_version || '0.0.0', state.version)
          ? yellow(`${s.plugin_version || '?'} → ${state.version}`)
          : green(s.plugin_version || '?')),
      hint: '',
    }));
    items.push({ label: dim('Refresh now') }, { label: dim('Back') });
    const pick = await menu('Sites', items, header);
    if (pick === -1 || pick === items.length - 1) return;
    if (pick === items.length - 2) {
      out(dim('Checking…'));
      state = await loadSites(true);
      continue;
    }
    await siteScreen(sites[pick], state);
    state = await loadSites(true);
  }
}

async function siteScreen(site, state) {
  for (;;) {
    const old = olderThan(site.plugin_version || '0.0.0', state.version);
    const items = [
      { label: 'Check connection now' },
      { label: old ? `Update bridge to ${state.version}` : 'Update bridge', hint: old ? '' : 'already current' },
      { label: 'Open the site in the browser' },
      { label: `Highest level: ${site.max_level}`, hint: 'change' },
      { label: red('Remove from WP MCP'), hint: 'the plugin stays on the site' },
      { label: dim('Back') },
    ];
    const pick = await menu(`${site.name}  ${dim(site.url)}`, items, [
      dim(`WordPress ${site.wp_version || '?'} · bridge ${site.plugin_version || '?'} · ${site.status}`),
    ]);
    if (pick === -1 || pick === 5) return;
    if (pick === 0) {
      const r = await call('sites/test', { name: site.name });
      await show([r.ok ? green('Connected.') : red(r.detail || 'Failed'), r.detail || '']);
      site = (await call('state')).sites.find((s) => s.name === site.name) || site;
    } else if (pick === 1) {
      const r = await runTool(site.name, 'maintain', 'update', { type: 'plugin', slug: BRIDGE }, async (p) => {
        out(yellow(`\n${p.summary}`));
        out(dim(JSON.stringify(p.preview?.will_update ?? p.preview)));
        return confirm('Update the bridge on this live site now?');
      });
      if (r.cancelled) continue;
      await show([
        r.ok ? green(`Updated ${r.data.from} → ${r.data.to}`) : red(r.error?.message || 'Failed'),
        r.ok
          ? ''
          : dim(
              'Bridges older than 2.3 cannot update themselves: upload the zip once in WordPress (Plugins → Add New → Upload → replace).',
            ),
      ]);
      await call('sites/test', { name: site.name }).catch(() => null);
      site = (await call('state')).sites.find((s) => s.name === site.name) || site;
    } else if (pick === 2) openBrowser(site.url);
    else if (pick === 3) {
      const levels = state.levels;
      const l = await menu(
        `Highest level on ${site.name}`,
        levels.map((x) => ({ label: x, hint: x === site.max_level ? 'current' : '' })),
      );
      if (l >= 0) {
        await call('sites/level', { name: site.name, level: levels[l] });
        site = (await call('state')).sites.find((s) => s.name === site.name) || site;
      }
    } else if (pick === 4 && (await confirm(`Remove ${site.name} from WP MCP?`))) {
      await call('sites/remove', { name: site.name });
      return;
    }
  }
}

async function connectScreen() {
  if (!(await isUp())) {
    const r = await startPanel();
    if (!r.ok) return show([red(r.note)]);
  }
  clear();
  out(bold(cyan('Connect a site')));
  out(dim('On the site: install the bridge plugin, then WP MCP Bridge → Create pairing code (valid 15 minutes).'));
  out();
  const url = await ask('Site URL (https://…)');
  if (!url) return;
  const code = await ask('Pairing code (WPMP-XXXX-…)');
  if (!code) return;
  const name = await ask('Name (optional)');
  const r = await call('sites/add', { url, code, name: name || undefined, maxLevel: 'admin' }, 60000);
  await show([
    r.ok ? green(`Connected ${r.site.name} (bridge ${r.site.plugin_version}).`) : red(r.error?.message || r.message || 'Failed'),
  ]);
}

async function logScreen() {
  if (!existsSync(LOG)) return show([dim('No log yet. Start the panel first.')]);
  const size = statSync(LOG).size;
  const text = readFileSync(LOG, 'utf8').slice(-Math.min(size, 6000)).split(/\r?\n/).slice(-30);
  await show([bold(cyan('Panel log')), dim(LOG), '', ...text]);
}

function runInherit(cmd, args, cwd = ROOT, env = {}) {
  return spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: WIN && cmd === 'npm', env: { ...process.env, ...env } }).status === 0;
}

export async function rebuild() {
  const steps = [
    ['npm', ['--prefix', 'gateway', 'ci']],
    ['npm', ['--prefix', 'panel', 'ci']],
    ['npm', ['--prefix', 'gateway', 'run', 'build']],
  ];
  for (const [cmd, args] of steps) {
    out(bold(`\n> ${cmd} ${args.join(' ')}`));
    if (!runInherit(cmd, args)) return false;
  }

  return true;
}

async function rebuildScreen() {
  clear();
  const wasUp = await isUp();
  if (wasUp) {
    out(dim('Stopping the panel first…'));
    await stopPanel();
  }
  const ok = await rebuild();
  out();
  out(ok ? green('Build finished.') : red('Build failed. Read the messages above.'));
  if (ok && wasUp) out((await startPanel()).note);
  await pause();
}

export async function doctor() {
  const lines = [];
  const add = (ok, text) => lines.push(`${ok === true ? green('✓') : ok === false ? red('✗') : yellow('!')} ${text}`);
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 20, `Node.js ${process.versions.node}${major >= 20 ? '' : ' (20 or newer needed)'}`);
  add(existsSync(join(ROOT, 'gateway', 'node_modules')) && existsSync(join(ROOT, 'panel', 'node_modules')), 'Packages installed');
  add(built(), built() ? `Built (version ${version()})` : 'Not built: choose Rebuild');
  const up = await isUp();
  add(up ? true : null, up ? `Panel running at ${BASE}/admin` : 'Panel is not running');
  if (!up) {
    const busy = [PORT, PORT + 1].filter((p) => pidsOn(p).length);
    if (busy.length) add(false, `Port ${busy.join(', ')} is taken by another program`);
  }
  if (up) {
    const state = await loadSites(true);
    add(state.sites.length > 0 ? true : null, `${state.sites.length} site(s) connected · data in ${state.dataDir}`);
    for (const s of state.sites) {
      const old = olderThan(s.plugin_version || '0.0.0', state.version);
      add(
        s.status === 'ok' && !old ? true : s.status === 'ok' ? null : false,
        `${s.name}: ${s.status}, bridge ${s.plugin_version || '?'}${old ? ` (latest ${state.version}: update it)` : ''}`,
      );
    }
  }
  const key = process.env.WPM_RELEASE_KEY || join(homedir(), 'wpm-release-key', 'wpm-release-private.pem');
  add(
    existsSync(key) ? true : null,
    existsSync(key)
      ? `Release key found (${key}). Keep a backup of it.`
      : 'No release key on this computer (only needed to publish releases)',
  );

  return lines;
}

async function releaseScreen() {
  const items = [
    { label: 'Build signed release files', hint: 'npm run release → dist/' },
    { label: 'Publish the release on GitHub', hint: 'gh release create' },
    { label: 'Open the dist folder' },
    { label: dim('Back') },
  ];
  for (;;) {
    const pick = await menu('Release tools (maintainers)', items, [dim('Signs with your release key; updates reach sites that trust it.')]);
    if (pick === -1 || pick === 3) return;
    const key = process.env.WPM_RELEASE_KEY || join(homedir(), 'wpm-release-key', 'wpm-release-private.pem');
    if (pick === 0) {
      const path = existsSync(key) ? key : await ask('Path of the private key (.pem)');
      if (!path) continue;
      clear();
      const ok = runInherit('node', [join(ROOT, 'scripts', 'release.mjs')], ROOT, { WPM_RELEASE_KEY: path });
      out(ok ? green('\nDone. Files are in dist/.') : red('\nFailed.'));
      await pause();
    } else if (pick === 1) {
      const dist = join(ROOT, 'dist');
      const files = ['wp-mcp-bridge.zip', 'bridge-latest.json', 'wpm-agent.zip', 'wpm-agent.zip.sig', 'SHA256SUMS'].filter((f) =>
        existsSync(join(dist, f)),
      );
      if (!files.includes('bridge-latest.json')) {
        await show([red('Build the signed release files first.')]);
        continue;
      }
      const ver = JSON.parse(readFileSync(join(dist, 'bridge-latest.json'), 'utf8')).version;
      out(`\nThis publishes v${ver} publicly with: ${files.join(', ')}`);
      if (!(await confirm(`Publish v${ver} on GitHub now?`))) continue;
      const ok = runInherit('gh', [
        'release',
        'create',
        `v${ver}`,
        ...files.map((f) => join(dist, f)),
        '--target',
        'master',
        '--title',
        `WP MCP ${ver}`,
        '--notes',
        `WP MCP ${ver}. See CHANGELOG.md.`,
      ]);
      out(ok ? green('\nPublished.') : red('\nFailed (is gh installed and logged in?).'));
      await pause();
    } else if (pick === 2) openBrowser(join(ROOT, 'dist'));
  }
}

async function main() {
  startInput();
  const missing = !built() || !existsSync(join(ROOT, 'gateway', 'node_modules')) || !existsSync(join(ROOT, 'panel', 'node_modules'));
  if (missing) {
    clear();
    out(bold(cyan('WP MCP')));
    out('First run: the packages are not installed or built yet.');
    if (await confirm('Install and build now? It takes a few minutes.')) {
      const ok = await rebuild();
      out();
      out(ok ? green('Ready.') : red('Build failed. Read the messages above; the menu has Rebuild to try again.'));
      await pause();
    }
  }
  for (;;) {
    const up = await isUp();
    const header = [
      up ? green(`● running  ${BASE}/admin`) : yellow('○ stopped'),
      dim(`version ${version()}${built() ? '' : ' · not built yet'}`),
    ];
    const items = [
      { label: up ? 'Stop the panel' : 'Start the panel' },
      { label: 'Open the panel in the browser' },
      { label: 'Sites', hint: 'status · update bridge · remove' },
      { label: 'Connect a new site' },
      { label: 'Claude.ai connector', hint: 'tunnel · no login' },
      { label: 'Restart the panel' },
      { label: 'Panel log' },
      { label: 'Rebuild', hint: 'after updating the code, or the first time' },
      { label: 'Check everything' },
      { label: 'Release tools', hint: 'maintainers' },
      { label: dim('Quit'), hint: up ? 'the panel keeps running' : '' },
    ];
    const pick = await menu('WP MCP', items, header);
    if (pick === -1 || pick === 10) break;
    if (pick === 0) {
      const r = up ? await stopPanel() : await startPanel();
      await show([r.ok ? green(r.note) : red(r.note)]);
    } else if (pick === 1) {
      if (!up) {
        const r = await startPanel();
        if (!r.ok) {
          await show([red(r.note)]);
          continue;
        }
      }
      openBrowser(`${BASE}/admin`);
    } else if (pick === 2) await sitesScreen();
    else if (pick === 3) await connectScreen();
    else if (pick === 4) await connectorScreen();
    else if (pick === 5) {
      await stopPanel();
      const r = await startPanel();
      await show([r.ok ? green(r.note) : red(r.note)]);
    } else if (pick === 6) await logScreen();
    else if (pick === 7) await rebuildScreen();
    else if (pick === 8) await show([bold(cyan('Check everything')), '', ...(await doctor())]);
    else if (pick === 9) await releaseScreen();
  }
  cleanup();
  clear();
  process.exit(0);
}

const cli = process.argv[2];
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!cli) await main();
  else if (cli === 'status') out((await isUp()) ? `running ${BASE}/admin` : 'stopped');
  else if (cli === 'start') out((await startPanel()).note);
  else if (cli === 'stop') out((await stopPanel()).note);
  else if (cli === 'connector') {
    const r = await startConnector(process.argv[3] || 'live');
    out(r.note);
    if (!r.ok) process.exitCode = 1;
  } else if (cli === 'restart') {
    await stopPanel();
    out((await startPanel()).note);
  } else if (cli === 'doctor') for (const l of await doctor()) out(l);
  else if (cli === 'rebuild') process.exit((await rebuild()) ? 0 : 1);
  else if (cli === 'sites') {
    if (!(await isUp())) out('The panel is not running. Start it from the menu: wpmcp');
    else {
      const s = await loadSites(true);
      for (const x of s.sites)
        out(
          `${pad(x.name, 18)}${pad(x.status, 8)}${pad(x.wp_version || '?', 11)}${x.plugin_version || '?'}${olderThan(x.plugin_version || '0.0.0', s.version) ? ` (latest ${s.version})` : ''}`,
        );
    }
  } else out('Usage: tui.mjs [status|start|stop|restart|connector [level]|sites|doctor|rebuild]');
  if (cli) process.exit(0);
}
