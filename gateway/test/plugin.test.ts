import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { responseSignature, signRequest } from '../src/wpclient.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const php = spawnSync('php', ['-v'], { encoding: 'utf8' });
const hasPhp = php.status === 0;

describe.skipIf(!hasPhp)('WordPress plugin (PHP, no WordPress needed)', () => {
  it('signs exactly like the gateway (cross-language vector)', () => {
    const out = spawnSync('php', [`${root}plugin/tests/vector.php`], { encoding: 'utf8' });
    const php = JSON.parse(out.stdout) as { request: string; response: string };
    const secret = 'cd'.repeat(32);
    const nonce = '9a'.repeat(16);
    const body = '{"op":"content.save","args":{"title":"Salam – سلام"},"level":"live"}';
    expect(php.request).toBe(signRequest(secret, 'kABC', '1700000123', nonce, body));
    expect(php.response).toBe(responseSignature(secret, nonce, body));
  });

  it('passes its own unit tests (policies, signatures, spec coverage)', () => {
    const out = spawnSync('php', [`${root}plugin/tests/run.php`], { encoding: 'utf8' });
    const failures = out.stdout.split('\n').filter((l) => l.startsWith('not ok'));
    expect(failures).toEqual([]);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/\d+ passed, 0 failed/);
  });

  it('every PHP file is syntactically valid', () => {
    const list = spawnSync(process.platform === 'win32' ? 'cmd' : 'find', process.platform === 'win32' ? ['/c', `dir /s /b ${root}plugin\\*.php`] : [`${root}plugin`, '-name', '*.php'], { encoding: 'utf8' });
    const files = list.stdout.split(/\r?\n/).filter((f) => f.endsWith('.php'));
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const lint = spawnSync('php', ['-l', file], { encoding: 'utf8' });
      expect(lint.status, `${file}: ${lint.stdout}${lint.stderr}`).toBe(0);
    }
  });
});
