import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../src/auth/auth.ts';
import { callTool } from '../src/mcp/tools.ts';
import { createEnv, key, tool, type Env } from './helpers.ts';

describe('uploading files from this computer (local_path)', () => {
  let env: Env;
  let dir: string;
  let elsewhere: string;
  const local: Principal = { id: 'stdio', kind: 'stdio', name: 'local stdio', level: 'admin', sites: '*' };
  const small = randomBytes(5000);
  const big = randomBytes(3_300_000);

  const call = async (name: string, input: Record<string, unknown>) => {
    const r = await callTool(env.app, local, name, input);
    return { isError: !!r.isError, data: JSON.parse(r.content[0]!.text) };
  };
  const calls = (op: string) => env.sites.alpha.calls.filter((c) => c.op === op && !c.dry_run);

  beforeAll(async () => {
    env = await createEnv(['alpha']);
    dir = mkdtempSync(join(tmpdir(), 'wpm-up-'));
    elsewhere = mkdtempSync(join(tmpdir(), 'wpm-else-'));
    env.app.config.uploadDirs = [dir];
    mkdirSync(join(dir, '.ssh'));
    writeFileSync(join(dir, 'logo.png'), small);
    writeFileSync(join(dir, 'video.mp4'), big);
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    writeFileSync(join(dir, 'server.pem'), 'x');
    writeFileSync(join(dir, '.ssh', 'notes.txt'), 'x');
    writeFileSync(join(elsewhere, 'photo.jpg'), small);
    env.sites.alpha.answers['files.write'] = (args, c) => (c.dry_run ? { will_write: args.path } : { path: args.path });
    env.sites.alpha.answers['files.upload_part'] = (args, c) =>
      c.dry_run ? { will_write: args.path } : { path: args.path, done: !!args.last };
    env.sites.alpha.answers['media.upload'] = (args) => ({ id: 9, filename: args.filename });
  });
  afterAll(async () => {
    await env.stop();
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('sends a small file as its bytes, named after the file, and never the local path', async () => {
    const first = await call('files', { action: 'write', args: { root: 'uploads', local_path: join(dir, 'logo.png') } });
    expect(first.data.needs_confirmation).toBe(true);
    const done = await call('files', { action: 'write', confirm_token: first.data.confirm_token });
    expect(done.isError).toBe(false);
    const sent = calls('files.write').at(-1)!.args;
    expect(sent).toEqual({ root: 'uploads', path: 'logo.png', data_base64: small.toString('base64') });
  });

  it('fills the media file name from the path', async () => {
    const r = await call('media', { action: 'upload', args: { local_path: join(dir, 'logo.png'), alt: 'Logo' } });
    expect(r.data.data).toEqual({ id: 9, filename: 'logo.png' });
    expect(calls('media.upload').at(-1)!.args).toEqual({ filename: 'logo.png', alt: 'Logo', data_base64: small.toString('base64') });
  });

  it('sends a large file in ordered pieces that join back exactly', async () => {
    const first = await call('files', {
      action: 'write',
      args: { root: 'uploads/2026', path: 'clip.mp4', local_path: join(dir, 'video.mp4') },
    });
    expect(first.data.preview).toMatchObject({ will_upload: 'clip.mp4', bytes: big.length, pieces: 3 });
    expect(calls('files.upload_part')).toHaveLength(0);
    const done = await call('files', { action: 'write', confirm_token: first.data.confirm_token });
    expect(done.data.data).toEqual({ path: 'clip.mp4', done: true });
    const parts = calls('files.upload_part');
    expect(parts.map((p) => p.args.last)).toEqual([false, false, true]);
    expect(new Set(parts.map((p) => p.args.upload)).size).toBe(1);
    expect(new Set(parts.map((p) => p.idempotency_key)).size).toBe(3);
    let offset = 0;
    for (const p of parts) {
      expect(p.args.offset).toBe(offset);
      offset += Buffer.from(String(p.args.data_base64), 'base64').length;
    }
    expect(Buffer.concat(parts.map((p) => Buffer.from(String(p.args.data_base64), 'base64'))).equals(big)).toBe(true);
    expect(calls('files.write').every((c) => c.args.local_path === undefined)).toBe(true);
  });

  it('refuses files outside the upload folders, private files and missing files', async () => {
    const code = async (path: string) =>
      (await call('files', { action: 'write', args: { root: 'uploads', local_path: path } })).data.error.code;
    expect(await code(join(elsewhere, 'photo.jpg'))).toBe('outside_upload_dirs');
    expect(await code(join(dir, '..', 'nope.png'))).toBe('not_found');
    expect(await code(join(dir, '.env'))).toBe('private_file');
    expect(await code(join(dir, 'server.pem'))).toBe('private_file');
    expect(await code(join(dir, '.ssh', 'notes.txt'))).toBe('private_file');
  });

  it('is only for a connection on this computer', async () => {
    const before = env.sites.alpha.calls.length;
    const r = await tool(env, key(env, 'admin'), 'files', {
      action: 'write',
      args: { root: 'uploads', local_path: join(dir, 'logo.png') },
    });
    expect(r.data.error.code).toBe('not_local');
    expect(env.sites.alpha.calls.length).toBe(before);
  });

  it('takes local files inside write_many', async () => {
    const first = await call('files', {
      action: 'write_many',
      args: {
        root: 'themes/child',
        files: [
          { path: 'style.css', content: 'a{}' },
          { path: 'assets/logo.png', local_path: join(dir, 'logo.png') },
        ],
      },
    });
    await call('files', { action: 'write_many', confirm_token: first.data.confirm_token });
    expect(calls('files.write_many').at(-1)!.args.files).toEqual([
      { path: 'style.css', content: 'a{}' },
      { path: 'assets/logo.png', data_base64: small.toString('base64') },
    ]);
  });
});
