import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildStatus, findNpm, hasBuildScript, runner, startBuild } from '../src/build.ts';
import { createProject, projectDir, projectFramework, publishDir } from '../src/projects.ts';
import { FRAMEWORKS } from '../src/templates.ts';
import { createEnv, type Env } from './helpers.ts';

const until = async (project: string, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const job = buildStatus(project);
    if (job && job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('build did not finish');
};

describe('framework templates', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv([], { dataDir: mkdtempSync(join(tmpdir(), 'wpm-fw-')) }, { owner: false });
  });
  afterAll(() => env.stop());

  it.each(Object.keys(FRAMEWORKS))('%s makes a consistent project', (id) => {
    const t = FRAMEWORKS[id];
    const row = createProject(env.app, { name: `t-${id}`, template: id, title: 'Café "Nur" <b>', rtl: id === 'vite-vue' });
    const dir = projectDir(env.app, row.name);
    expect(row.kind).toBe(t.kind);
    expect(row.publish).toBe(t.publish);
    expect(projectFramework(env.app, row.name)).toBe(id);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toBeTruthy();
    expect(pkg.name).toMatch(/^[a-z0-9-]+$/);
    expect(hasBuildScript(dir)).toBe(true);
    // the title is escaped wherever it lands in markup
    // (astro and next carry the title only as a JSON string literal, which their renderers escape)
    for (const file of Object.keys(t.files('Café "Nur" <b>', false))) {
      const text = readFileSync(join(dir, file), 'utf8');
      if (id === 'astro' || id === 'next-export') expect(text.replace(JSON.stringify('Café "Nur" <b>'), '')).not.toContain('<b>');
      else expect(text).not.toContain('<b>');
    }
    // nothing is built or installed at creation
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);
    // not published until built
    expect(publishDir(env.app, row)).toBe(join(dir, t.publish));
  });

  it('vite templates keep asset links relative so they work in a sub-folder', () => {
    for (const id of ['vite-react', 'vite-vue', 'vite-svelte']) expect(FRAMEWORKS[id].files('x', false)['vite.config.js']).toContain("base: './'");
  });

  it('plain templates have no build step', () => {
    const row = createProject(env.app, { name: 'plain', template: 'landing' });
    expect(hasBuildScript(projectDir(env.app, row.name))).toBe(false);
    expect(() => startBuild(env.app, 'plain')).toThrow(/no build step/);
  });
});

describe('local build runner', () => {
  let env: Env;
  beforeAll(async () => {
    env = await createEnv([], { dataDir: mkdtempSync(join(tmpdir(), 'wpm-build-')) }, { owner: false });
  });
  afterAll(() => env.stop());

  const makeProject = (name: string, buildScript: string): string => {
    createProject(env.app, { name, template: 'blank' });
    const dir = projectDir(env.app, name);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, private: true, scripts: { build: 'node make.mjs' } }));
    writeFileSync(join(dir, 'make.mjs'), buildScript);
    env.app.store.setProjectPublish(name, 'dist');
    return dir;
  };

  it('finds npm without a shell', () => {
    const npm = findNpm();
    expect(npm).not.toBeNull();
    expect(existsSync(npm!.args[0])).toBe(true);
  });

  it('installs, builds and reports the output folder', async () => {
    const dir = makeProject('ok-site', "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('dist', { recursive: true }); writeFileSync('dist/index.html', '<h1>built</h1>'); writeFileSync('dist/app.js', '1'); console.log('compiled!');");
    const started = startBuild(env.app, 'ok-site');
    expect(started.status).toBe('running');
    expect(() => startBuild(env.app, 'ok-site')).toThrow(/already running/);
    const job = await until('ok-site');
    expect(job.status).toBe('ok');
    expect(job.error).toBe('');
    expect(job.log).toContain('npm run build');
    expect(job.log).toContain('compiled!');
    expect(job.output).toEqual({ dir: 'dist', files: 2 });
    expect(readFileSync(join(dir, 'dist', 'index.html'), 'utf8')).toBe('<h1>built</h1>');
    expect(publishDir(env.app, env.app.store.project('ok-site')!)).toBe(join(dir, 'dist'));
  }, 90000);

  it('reports a failing build with its log', async () => {
    makeProject('bad-site', "console.error('boom: syntax error'); process.exit(3);");
    startBuild(env.app, 'bad-site');
    const job = await until('bad-site');
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/build failed \(exit 3\)/);
    expect(job.log).toContain('boom: syntax error');
    // a failed build can be started again
    expect(() => startBuild(env.app, 'bad-site')).not.toThrow();
    await until('bad-site');
  }, 90000);

  it('says so when the build produced no index.html', async () => {
    makeProject('empty-site', "console.log('did nothing');");
    startBuild(env.app, 'empty-site');
    const job = await until('empty-site');
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/no index\.html/);
  }, 90000);

  it('explains a missing npm instead of crashing', () => {
    makeProject('no-npm', 'x');
    const real = runner.npm;
    runner.npm = () => null;
    try {
      expect(() => startBuild(env.app, 'no-npm')).toThrow(/npm was not found/);
    } finally {
      runner.npm = real;
    }
  });

  it('gives up on a step that runs too long', async () => {
    makeProject('slow-site', 'setInterval(() => {}, 1000);');
    const real = runner.timeoutMs;
    runner.timeoutMs = 1500;
    try {
      startBuild(env.app, 'slow-site');
      const job = await until('slow-site');
      expect(job.status).toBe('failed');
      expect(job.log).toMatch(/took more than 10 minutes|stopped/);
    } finally {
      runner.timeoutMs = real;
    }
  }, 90000);
});
