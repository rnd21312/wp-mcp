import { createHmac, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentEndpoint, normalizeAgentUrl, signAgentRequest } from '../src/agentclient.ts';
import { buildAgentZip, newSetupCode } from '../src/hosts.ts';
import { createProject, deleteFile, listFiles, ProjectError, publishDir, readFile, removeProject, safePath, writeFile } from '../src/projects.ts';
import { zipDirectory } from '../src/zip.ts';
import { createEnv, type Env } from './helpers.ts';

const names = (zip: Buffer): string[] => {
  const out: string[] = [];
  let p = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  // walk the central directory from its start
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  p = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const nlen = zip.readUInt16LE(p + 28);
    out.push(zip.subarray(p + 46, p + 46 + nlen).toString());
    p += 46 + nlen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return out;
};

describe('agent client helpers', () => {
  it('normalises whatever address the person pastes', () => {
    expect(normalizeAgentUrl('https://example.com/wpm-agent')).toBe('https://example.com/wpm-agent/');
    expect(normalizeAgentUrl('https://example.com/wpm-agent/index.php?r=/login#x')).toBe('https://example.com/wpm-agent/');
    expect(normalizeAgentUrl(' https://example.com/ ')).toBe('https://example.com/');
    expect(agentEndpoint('https://e.com/a/', '/api/v1/hello')).toBe('https://e.com/a/index.php?r=%2Fapi%2Fv1%2Fhello');
  });

  it('signs exactly like the agent does (layout shared with the WordPress bridge)', () => {
    const body = '{"a":1}';
    const expected = createHmac('sha256', 's3').update(['1700000000', 'abcdef0123456789', 'kid', 'POST', '/api/v1/hello', createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
    expect(signAgentRequest('s3', 'kid', 1700000000, 'abcdef0123456789', '/api/v1/hello', body)).toBe(expected);
    expect(signAgentRequest('s3', 'kid', 1700000000, 'abcdef0123456789', '/api/v1/hello', Buffer.from(body))).toBe(expected);
  });
});

describe('zip writer', () => {
  it('leaves out secrets, junk, build trees and links', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpm-zip-'));
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'css'));
    writeFileSync(join(dir, 'index.html'), '<h1>x</h1>');
    writeFileSync(join(dir, 'css', 'a.css'), 'a{}');
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    writeFileSync(join(dir, '.env.production'), 'SECRET=2');
    writeFileSync(join(dir, '.DS_Store'), 'x');
    writeFileSync(join(dir, 'node_modules', 'x', 'i.js'), 'x');
    writeFileSync(join(dir, '.git', 'config'), 'x');
    try {
      symlinkSync(join(dir, 'index.html'), join(dir, 'link.html'));
    } catch {
      /* no symlink rights on this machine */
    }
    const z = zipDirectory(dir);
    expect(names(z.buffer).sort()).toEqual(['css/a.css', 'index.html']);
    expect(z.files).toBe(2);
  });

  it('refuses absurdly large trees', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpm-zip-'));
    writeFileSync(join(dir, 'a.txt'), 'x');
    writeFileSync(join(dir, 'b.txt'), 'x');
    expect(() => zipDirectory(dir, { files: 1, bytes: 100 })).toThrow(/too large/);
  });

  it('builds the agent zip with the setup code inside and no runtime state', () => {
    const code = newSetupCode();
    expect(code).toMatch(/^WPMS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const built = buildAgentZip(code);
    const list = names(built.zip);
    expect(list).toContain('wpm-agent/index.php');
    expect(list).toContain('wpm-agent/src/Auth.php');
    expect(list).toContain('wpm-agent/.htaccess');
    expect(list).toContain('wpm-agent/wpm-setup.php');
    expect(list.some((n) => n.includes('data-location') || n.includes('/data/'))).toBe(false);
  });
});

describe('projects', () => {
  let env: Env;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpm-proj-'));
    env = await createEnv([], { dataDir: dir }, { owner: false });
  });
  afterAll(() => env.stop());

  it('creates a project from a template and keeps every path inside it', () => {
    const p = createProject(env.app, { name: 'shop-site', kind: 'static', template: 'landing', title: 'My Shop', rtl: true });
    expect(p.kind).toBe('static');
    const files = listFiles(env.app, 'shop-site').map((f) => f.path);
    expect(files).toEqual(expect.arrayContaining(['index.html', 'style.css', 'app.js']));
    expect(readFile(env.app, 'shop-site', 'index.html').content).toContain('dir="rtl"');

    writeFile(env.app, 'shop-site', 'pages/about.html', '<p>about</p>');
    expect(readFile(env.app, 'shop-site', 'pages/about.html').content).toBe('<p>about</p>');
    for (const bad of ['../x.txt', '/etc/passwd', 'a/../../x', 'C:/x', 'a\\b', '', '..']) {
      expect(() => writeFile(env.app, 'shop-site', bad, 'x'), bad).toThrow(ProjectError);
      expect(() => readFile(env.app, 'shop-site', bad), bad).toThrow(ProjectError);
    }
    expect(() => deleteFile(env.app, 'shop-site', '../projects')).toThrow(ProjectError);
    deleteFile(env.app, 'shop-site', 'pages/about.html');
    expect(existsSync(join(env.config.dataDir, 'projects', 'shop-site', 'pages', 'about.html'))).toBe(false);
  });

  it('validates names, kinds and duplicates', () => {
    for (const bad of ['', 'A', 'x', '../up', 'has space', 'UPPER_case']) expect(() => createProject(env.app, { name: bad })).toThrow(ProjectError);
    expect(() => createProject(env.app, { name: 'shop-site' })).toThrow(/already exists/);
    expect(() => createProject(env.app, { name: 'weird', kind: 'php' })).toThrow(/type must be/);
    expect(() => createProject(env.app, { name: 'weird', template: 'nope' })).toThrow(/template/);
  });

  it('publishes dist/ when a build exists, the root otherwise', () => {
    createProject(env.app, { name: 'built', template: 'blank' });
    const row = env.app.store.project('built')!;
    const root = join(env.config.dataDir, 'projects', 'built');
    expect(publishDir(env.app, row)).toBe(root);
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'index.html'), 'built');
    expect(publishDir(env.app, row)).toBe(join(root, 'dist'));
    removeProject(env.app, 'built', true);
    expect(existsSync(root)).toBe(false);
  });

  it('safePath refuses a symlink that leads out of the project', () => {
    const root = mkdtempSync(join(tmpdir(), 'wpm-sp-'));
    const outside = mkdtempSync(join(tmpdir(), 'wpm-out-'));
    try {
      symlinkSync(outside, join(root, 'escape'), 'junction');
    } catch {
      return;
    }
    expect(() => safePath(root, 'escape/evil.txt')).toThrow(ProjectError);
    expect(randomBytes(1).length).toBe(1);
  });
});
