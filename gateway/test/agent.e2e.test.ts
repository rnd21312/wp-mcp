import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { agentSourceDir, buildAgentZip, releasePaths } from '../src/hosts.ts';
import { createZip } from '../src/zip.ts';
import { createEnv, type Env } from './helpers.ts';

/**
 * End to end: the real PHP agent behind `php -S`, driven by the real Studio code (pairing, signed calls,
 * chunked uploads, deploy, rollback) through the local panel API.
 */
const hasPhp = spawnSync('php', ['-v']).status === 0;
// Signed updates need the sodium extension; it is optional on some PHP builds.
const sodiumArgs = spawnSync('php', ['-r', 'exit(function_exists("sodium_crypto_sign_detached") ? 0 : 1);']).status === 0 ? [] : spawnSync('php', ['-d', 'extension=sodium', '-r', 'exit(function_exists("sodium_crypto_sign_detached") ? 0 : 1);']).status === 0 ? ['-d', 'extension=sodium'] : null;
const releaseKey = generateKeyPairSync('ed25519');

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

describe.skipIf(!hasPhp)('Host Agent end to end (php -S)', () => {
  let env: Env;
  let php: ChildProcess;
  let root: string;
  let web: string;
  let agentUrl: string;
  let origin: string;
  let setupCode: string;
  const password = 'correct horse battery staple';

  const call = async (path: string, init: RequestInit & { cookie?: string; form?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (init.cookie) headers.cookie = init.cookie;
    let body = init.body;
    if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
    }
    const res = await fetch(`${origin}/wpm-agent/index.php?r=${encodeURIComponent(path)}`, { ...init, headers, body, redirect: 'manual' });
    const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

    return { status: res.status, text: await res.text(), cookie, location: res.headers.get('location') ?? '' };
  };

  const studio = async (route: string, body?: unknown) => {
    const res = await fetch(`${env.base}/admin/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-wpm-panel': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });

    return (await res.json()) as any;
  };

  const live = async (path: string) => (await fetch(`${origin}${path}`)).text();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'wpm-e2e-'));
    web = join(root, 'public_html');
    mkdirSync(web, { recursive: true });

    // Build the real zip, unpack it with the agent's own zip reader (also proves our zip writer is readable by it).
    const built = buildAgentZip();
    setupCode = built.setupCode;
    const zipFile = join(root, 'wpm-agent.zip');
    writeFileSync(zipFile, built.zip);
    const src = agentSourceDir();
    const unpack = spawnSync('php', ['-r', `define('WPM_AGENT',1); foreach(['Util','ApiError','Store','Fs','Zip'] as $f) require ${JSON.stringify(src.replace(/\\/g, '/'))}.'/src/'.$f.'.php'; $d=${JSON.stringify(web.replace(/\\/g, '/'))}.'/wpm-agent'; mkdir($d); \\WPM\\Agent\\Zip::extract(${JSON.stringify(zipFile.replace(/\\/g, '/'))}, $d, 50000000); echo 'ok';`], { encoding: 'utf8' });
    expect(unpack.stdout).toBe('ok');
    expect(existsSync(join(web, 'wpm-agent', 'index.php'))).toBe(true);
    expect(readFileSync(join(web, 'wpm-agent', 'wpm-setup.php'), 'utf8')).toContain(setupCode);

    // The installation trusts our test release key.
    const rawPublic = createPublicKey(releaseKey.privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
    writeFileSync(join(web, 'wpm-agent', 'src', 'UpdateKey.php'), `<?php
declare(strict_types=1);
defined('WPM_AGENT') || exit;
return '${rawPublic}';
`);

    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    agentUrl = `${origin}/wpm-agent/`;
    php = spawn('php', [...(sodiumArgs ?? []), '-S', `127.0.0.1:${port}`, '-t', web], { stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(origin);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    mkdirSync(join(root, 'studio-data'), { recursive: true });
    env = await createEnv([], { localPanel: true, dataDir: join(root, 'studio-data') }, { owner: false });
  }, 60000);

  afterAll(async () => {
    php?.kill();
    await env?.stop();
    await new Promise((r) => setTimeout(r, 200));
    if (root) rmSync(root, { recursive: true, force: true });
  });

  let cookie = '';
  let csrf = '';

  it('is locked to a setup wizard until installed, and refuses API calls', async () => {
    const home = await call('/');
    expect(home.status).toBe(303);
    const wizard = await call('/setup');
    expect(wizard.status).toBe(200);
    expect(wizard.text).toContain('setup_code');
    expect(wizard.text).not.toContain(setupCode);
    const api = await call('/api/v1/hello', { method: 'POST', body: '{}' });
    expect(JSON.parse(api.text).error.code).toBe('not_installed');
  });

  it('keeps source and data files out of reach over HTTP', async () => {
    for (const path of ['/wpm-agent/src/Auth.php', '/wpm-agent/wpm-setup.php', '/wpm-agent/data-location.php']) {
      const res = await fetch(`${origin}${path}`);
      expect((await res.text()).trim()).toBe('');
    }
    expect(existsSync(join(root, 'wpm-agent-data'))).toBe(true);
    expect(existsSync(join(web, 'wpm-agent', 'data'))).toBe(false);
  });

  it('rejects a wrong setup code and weak passwords, then installs', async () => {
    const form = { username: 'owner', password, confirm: password };
    const wrong = await call('/setup', { method: 'POST', form: { ...form, setup_code: 'WPMS-WRONG' } });
    expect(wrong.status).toBe(200);
    expect(wrong.text).toContain('class="msg bad"');
    const weak = await call('/setup', { method: 'POST', form: { setup_code: setupCode, username: 'owner', password: 'short', confirm: 'short' } });
    expect(weak.text).toContain('class="msg bad"');
    const ok = await call('/setup', { method: 'POST', form: { ...form, setup_code: setupCode } });
    expect(ok.status).toBe(303);
    cookie = ok.cookie;
    expect(cookie).toMatch(/wpm_sid=/);
    expect(existsSync(join(web, 'wpm-agent', 'wpm-setup.php'))).toBe(false);
    const again = await call('/setup', { method: 'POST', form: { ...form, setup_code: setupCode } });
    expect(again.status).toBe(303); // already installed: bounced to the panel, nothing changes
    const dash = await call('/', { cookie });
    expect(dash.status).toBe(200);
    csrf = /name="csrf" value="([a-f0-9]+)"/.exec(dash.text)![1];
  });

  it('locks logins after repeated failures', async () => {
    for (let i = 0; i < 5; i++) {
      const bad = await call('/login', { method: 'POST', form: { username: 'owner', password: `wrong-password-${i}` } });
      expect(bad.text).toContain('class="msg bad"');
    }
    const locked = await call('/login', { method: 'POST', form: { username: 'owner', password } });
    expect(locked.status).toBe(200); // not redirected into the panel
    expect(locked.cookie).toBe('');
    // clear the throttle so the rest of the suite can use this address
    const dataDir = join(root, 'wpm-agent-data');
    rmSync(join(dataDir, 'throttle.json.php'), { force: true });
  });

  it('pairs the Studio with a one-time code and reads host capabilities', async () => {
    const page = await call('/connect', { method: 'POST', cookie, form: { csrf, level: 'admin' } });
    const code = /(WPMA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(page.text)![1];
    const bad = await studio('hosts/add', { url: agentUrl, code: 'WPMA-AAAA-BBBB-CCCC', name: 'mine' });
    expect(bad.ok).toBe(false);
    const added = await studio('hosts/add', { url: `${agentUrl}index.php`, code, name: 'mine' });
    expect(added.ok).toBe(true);
    expect(added.host.status).toBe('ok');
    expect(added.host.caps.php.ok).toBe(true);
    expect(added.host.caps.limits.chunk_bytes).toBeGreaterThan(100000);
    const reuse = await studio('hosts/add', { url: agentUrl, code, name: 'second' });
    expect(reuse.ok).toBe(false);
    const state = await studio('studio');
    expect(JSON.stringify(state)).not.toMatch(/secret/i);
    expect(state.hosts).toHaveLength(1);
  });

  it('deploys a project as a new site, then a second release, and rolls back', async () => {
    const created = await studio('projects/create', { name: 'demo', kind: 'static', template: 'landing', title: 'Version One' });
    expect(created.ok).toBe(true);
    const first = await studio('projects/deploy', { project: 'demo', host: 'mine', folder: 'demo', url: `${origin}/demo/` });
    expect(first.error ?? first.ok).toBe(true);
    expect(first.site).toBe('demo');
    expect(first.release.mode).toBe(process.platform === 'win32' ? 'sync' : first.release.mode);
    expect(await live('/demo/index.html')).toContain('Version One');
    expect(await live('/demo/style.css')).toContain('--accent');

    const read = await studio('projects/read', { project: 'demo', path: 'index.html' });
    await studio('projects/write', { project: 'demo', path: 'index.html', content: read.content.replace('Version One', 'Version Two') });
    await studio('projects/write', { project: 'demo', path: 'extra/new.txt', content: 'hello' });
    await studio('projects/delete-file', { project: 'demo', path: 'app.js' });
    const second = await studio('projects/deploy', { project: 'demo', host: 'mine', note: 'second' });
    expect(second.error ?? second.ok).toBe(true);
    expect(second.release.previous).toBe(first.release.id);
    expect(await live('/demo/index.html')).toContain('Version Two');
    expect(await live('/demo/extra/new.txt')).toBe('hello');
    expect(existsSync(join(web, 'demo', 'app.js'))).toBe(false); // (php -S answers unknown paths with the folder index, so check the disk)

    const releases = await studio('hosts/releases', { host: 'mine', site: 'demo' });
    expect(releases.releases).toHaveLength(2);
    expect(releases.current).toBe(second.release.id);

    const back = await studio('hosts/rollback', { host: 'mine', site: 'demo' });
    expect(back.error ?? back.ok).toBe(true);
    expect(await live('/demo/index.html')).toContain('Version One');
    expect(existsSync(join(web, 'demo', 'extra'))).toBe(false);
    expect(existsSync(join(web, 'demo', 'app.js'))).toBe(true);
  });

  it('streams a large upload in several chunks and verifies it', async () => {
    await studio('projects/create', { name: 'big', kind: 'static', template: 'blank' });
    const dir = join(env.config.dataDir, 'projects', 'big');
    writeFileSync(join(dir, 'blob.bin'), randomBytes(10 * 1024 * 1024)); // incompressible: the zip is larger than one chunk
    const done = await studio('projects/deploy', { project: 'big', host: 'mine', folder: 'big' });
    expect(done.ok).toBe(true);
    expect(done.bytes).toBeGreaterThan(10 * 1024 * 1024);
    const served = Buffer.from(await (await fetch(`${origin}/big/blob.bin`)).arrayBuffer());
    expect(served.equals(readFileSync(join(dir, 'blob.bin')))).toBe(true);
  }, 60000);

  it('refuses unsafe archives and leaves the live site untouched', async () => {
    const dir = join(env.config.dataDir, 'projects', 'demo');
    writeFileSync(join(dir, 'shell.php'), '<?php echo "pwned";');
    const refused = await studio('projects/deploy', { project: 'demo', host: 'mine' });
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe('zip_rejected');
    expect(existsSync(join(web, 'demo', 'shell.php'))).toBe(false);
    expect(await live('/demo/index.html')).toContain('Version One');
    rmSync(join(dir, 'shell.php'));
  });

  it('rejects tampered, replayed and wrongly signed requests', async () => {
    const host = env.app.store.host('mine')!;
    const { decrypt } = await import('../src/crypto.ts');
    const { signAgentRequest, agentEndpoint } = await import('../src/agentclient.ts');
    const secret = decrypt(env.config.masterKey, host.secret_enc);
    const body = '{}';
    const ts = Math.floor(Date.now() / 1000);
    const send = (sigSecret: string, nonce: string, t = ts, route = '/api/v1/hello') =>
      fetch(agentEndpoint(host.url, route), { method: 'POST', headers: { 'x-wpm-key': host.key_id, 'x-wpm-time': String(t), 'x-wpm-nonce': nonce, 'x-wpm-signature': signAgentRequest(sigSecret, host.key_id, t, nonce, route, body) }, body }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));

    const n1 = randomBytes(16).toString('hex');
    expect((await send(secret, n1)).status).toBe(200);
    const replay = await send(secret, n1);
    expect(replay.status).toBe(401);
    expect(replay.json.error.code).toBe('replay');
    expect((await send(secret, randomBytes(16).toString('hex'), ts - 1000)).json.error.code).toBe('stale_request');
    expect((await send('not-the-secret', randomBytes(16).toString('hex'))).json.error.code).toBe('bad_signature');
    // signature made for another route does not carry over
    const nonce = randomBytes(16).toString('hex');
    const swapped = await fetch(agentEndpoint(host.url, '/api/v1/sites.create'), { method: 'POST', headers: { 'x-wpm-key': host.key_id, 'x-wpm-time': String(ts), 'x-wpm-nonce': nonce, 'x-wpm-signature': signAgentRequest(secret, host.key_id, ts, nonce, '/api/v1/hello', body) }, body });
    expect(((await swapped.json()) as any).error.code).toBe('bad_signature');
  });

  it('keeps a record of what happened', async () => {
    const audit = await studio('hosts/audit', { host: 'mine' });
    const actions = audit.entries.map((e: any) => e.action);
    for (const a of ['setup', 'pair', 'site.create', 'deploy', 'rollback']) expect(actions).toContain(a);
    expect(JSON.stringify(audit.entries)).not.toContain(password);
    const sites = await studio('hosts/sites', { host: 'mine' });
    expect(sites.sites.map((s: any) => s.id).sort()).toEqual(['big', 'demo']);
  });

  it('deploys a Node.js app outside the web root with env, Passenger config and a server script', async () => {
    mkdirSync(join(root, 'nodeapps'), { recursive: true });
    await studio('projects/create', { name: 'api', template: 'node-http', title: 'My API' });
    const done = await studio('projects/deploy', { project: 'api', host: 'mine', folder: 'api', node: { app_root: join(root, 'nodeapps'), docroot: 'api-public', port: 24123, env: { GREETING: 'salam "dost"' } } });
    expect(done.error ?? done.ok).toBe(true);
    const appDir = join(root, 'nodeapps', 'api');
    expect(readFileSync(join(appDir, 'server.js'), 'utf8')).toContain('createServer');
    expect(existsSync(join(appDir, 'tmp', 'restart.txt'))).toBe(true);
    const ht = readFileSync(join(web, 'api-public', '.htaccess'), 'utf8');
    expect(ht).toContain('PassengerAppType node');
    expect(ht).toContain(`PassengerAppRoot "${appDir.replace(/\\/g, '/')}"`);
    expect(ht).toContain('SetEnv GREETING "salam \\"dost\\""');
    const envFile = readFileSync(join(root, 'wpm-agent-data', 'sites', 'api', 'env'), 'utf8');
    expect(envFile).toContain('GREETING="salam \\"dost\\""');
    expect(existsSync(join(web, 'api'))).toBe(false); // the source is not under the web root
    const forbidden = await studio('hosts/env', { host: 'mine', site: 'api', env: { NODE_OPTIONS: '--require /tmp/x.js' } });
    expect(forbidden.ok).toBe(false);
    expect(forbidden.error.code).toBe('env_forbidden');
    const script = await studio('hosts/node-script', { host: 'mine', site: 'api', domain: 'api.example.com', user: 'appuser' });
    if (process.platform === 'win32') {
      expect(script.error.code).toBe('bad_path'); // Windows paths cannot go into a Linux script; refused rather than mangled
    } else {
      expect(script.error ?? script.ok).toBe(true);
      expect(script.script).toContain('proxy_pass http://127.0.0.1:24123;');
      expect(script.script).toContain('server_name api.example.com;');
    }
    const bad = await studio('hosts/node-script', { host: 'mine', site: 'api', domain: 'x.com; reboot', user: 'u' });
    expect(bad.error.code).toBe('bad_domain');
  });

  it('checks the host from inside and outside', async () => {
    const r = await studio('hosts/check', { name: 'mine' });
    expect(r.error ?? r.ok).toBe(true);
    const by = Object.fromEntries(r.checks.map((c: any) => [c.id, c]));
    expect(by.data_dir.status).toBe('ok');
    expect(by.atomic_rename.status).toBe('ok');
    expect(by.zlib.status).toBe('ok');
    expect(r.checks.some((c: any) => c.status === 'fail')).toBe(false);
    for (const e of r.exposure) expect(e.safe, `${e.path}: ${e.note}`).toBe(true);
    expect(r.exposure.map((e: any) => e.path)).toContain('src/Auth.php');
  });

  it.skipIf(!sodiumArgs)('updates the agent with a signed release, refusing a bad signature and a downgrade', async () => {
    const src = agentSourceDir();
    const files = ['index.php', '.htaccess', ...readdirSync(join(src, 'src')).map((f) => `src/${f}`)];
    const build = (version: string) =>
      createZip(
        files.map((name) => {
          let data = readFileSync(name === 'src/UpdateKey.php' ? join(web, 'wpm-agent', name) : join(src, name));
          if (name === 'src/Agent.php') data = Buffer.from(data.toString('utf8').replace(/const VERSION = '[^']+'/, `const VERSION = '${version}'`));
          return { name, data };
        }),
      );
    const signed = (zip: Buffer, key = releaseKey.privateKey) => sign(null, Buffer.from(`wpm-agent-update
${createHash('sha256').update(zip).digest('hex')}`), key).toString('base64');
    const dir = join(root, 'release');
    mkdirSync(dir, { recursive: true });
    releasePaths.dirs = [dir];

    // no release shipped
    expect((await studio('hosts/update-agent', { name: 'mine' })).error.code).toBe('no_release');
    // a release signed with the wrong key is refused by the agent itself
    const v2 = build('2.0.1');
    writeFileSync(join(dir, 'wpm-agent.zip'), v2);
    writeFileSync(join(dir, 'wpm-agent.version'), '2.0.1');
    writeFileSync(join(dir, 'wpm-agent.zip.sig'), signed(v2, generateKeyPairSync('ed25519').privateKey));
    const bad = await studio('hosts/update-agent', { name: 'mine' });
    expect(bad.error.code).toBe('bad_signature');
    expect(readFileSync(join(web, 'wpm-agent', 'src', 'Agent.php'), 'utf8')).toContain("'2.0.0'");
    // the real signature works
    writeFileSync(join(dir, 'wpm-agent.zip.sig'), signed(v2));
    const ok = await studio('hosts/update-agent', { name: 'mine' });
    expect(ok.error ?? ok.ok).toBe(true);
    expect(ok.to).toBe('2.0.1');
    expect(readFileSync(join(web, 'wpm-agent', 'src', 'Agent.php'), 'utf8')).toContain("'2.0.1'");
    expect(env.app.store.host('mine')!.agent_version).toBe('2.0.1');
    // the data stayed, the site still deploys through the updated agent
    expect(existsSync(join(web, 'wpm-agent', 'data-location.php'))).toBe(true);
    const again = await studio('projects/deploy', { project: 'demo', host: 'mine', note: 'after update' });
    expect(again.error ?? again.ok).toBe(true);
    // the same version again is "up to date" on the Studio side, and a signed downgrade is refused by the agent
    expect((await studio('hosts/update-agent', { name: 'mine' })).error.code).toBe('up_to_date');
    const v1 = build('1.0.0');
    writeFileSync(join(dir, 'wpm-agent.zip'), v1);
    writeFileSync(join(dir, 'wpm-agent.version'), '1.0.0');
    writeFileSync(join(dir, 'wpm-agent.zip.sig'), signed(v1));
    env.app.store.hostHealth('mine', true, '', { version: '0.0.1' }); // pretend the Studio thinks it is old
    expect((await studio('hosts/update-agent', { name: 'mine' })).error.code).toBe('not_newer');
    releasePaths.dirs = undefined;
    await studio('hosts/test', { name: 'mine' });
  }, 60000);

  it('the Studio detects a wrong secret and a revoked connection', async () => {
    // revoke in the agent panel, then the Studio must fail with a clear error
    const page = await call('/security', { cookie });
    const keyId = /<code>(k[a-f0-9]+)<\/code>/.exec(page.text)![1];
    const res = await call('/security/revoke', { method: 'POST', cookie, form: { csrf, key: keyId } });
    expect(res.status).toBe(200);
    const test = await studio('hosts/test', { name: 'mine' });
    expect(test.ok).toBe(false);
    expect(test.detail).toMatch(/revoked|Unknown/i);
    expect(readdirSync(web).includes('demo')).toBe(true); // sites stay online
  });
});
