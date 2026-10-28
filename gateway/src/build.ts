import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { App } from './context.ts';
import { ProjectError, projectDir, publishDir } from './projects.ts';
import { listFiles } from './projects.ts';

/**
 * Local builds. The only commands ever run are `npm install` and `npm run build`, with fixed arguments, inside the project
 * folder, started by an explicit action in the panel. The project's own scripts and dependencies do execute (that is what a
 * build is), so only build projects you trust. No shell is involved.
 */

export interface BuildJob {
  project: string;
  status: 'running' | 'ok' | 'failed';
  step: 'install' | 'build' | 'done';
  started: number;
  finished: number;
  log: string;
  error: string;
  output: { dir: string; files: number } | null;
}

const jobs = new Map<string, BuildJob>();
const LOG_CAP = 200_000;
const STEP_TIMEOUT_MS = 10 * 60 * 1000;

export const runner = {
  /** How to start npm without a shell; replaced in tests. */
  npm: (): { cmd: string; args: string[] } | null => findNpm(),
  timeoutMs: STEP_TIMEOUT_MS,
};

/** npm is a script of Node itself; run it with this Node so no `.cmd` shim or shell is needed (also safe on Windows). */
export function findNpm(): { cmd: string; args: string[] } | null {
  const bin = dirname(process.execPath);
  const candidates = [join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(bin, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const cli = process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath) ? process.env.npm_execpath : candidates.find((c) => existsSync(c));

  return cli ? { cmd: process.execPath, args: [cli] } : null;
}

export const buildStatus = (project: string): BuildJob | null => jobs.get(project) ?? null;

const append = (job: BuildJob, text: string): void => {
  job.log += text;
  if (job.log.length > LOG_CAP) job.log = '…(earlier output cut)…\n' + job.log.slice(-LOG_CAP);
};

function runNpm(job: BuildJob, cwd: string, extra: string[]): Promise<number> {
  const npm = runner.npm();
  if (!npm) return Promise.reject(new ProjectError('no_npm', 'npm was not found next to Node on this computer. Install Node.js (nodejs.org), then try again.'));
  append(job, `\n$ npm ${extra.join(' ')}\n`);

  return new Promise((resolve, reject) => {
    const child = spawn(npm.cmd, [...npm.args, ...extra], {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', ADBLOCK: '1', NEXT_TELEMETRY_DISABLED: '1', ASTRO_TELEMETRY_DISABLED: '1', npm_config_update_notifier: 'false' },
    });
    const timer = setTimeout(() => {
      append(job, '\n[stopped: this step took more than 10 minutes]\n');
      child.kill();
    }, runner.timeoutMs);
    child.stdout.on('data', (d: Buffer) => append(job, d.toString()));
    child.stderr.on('data', (d: Buffer) => append(job, d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

export function hasBuildScript(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    return typeof pkg.scripts?.build === 'string';
  } catch {
    return false;
  }
}

/** Starts a build in the background and returns at once; poll buildStatus(). */
export function startBuild(app: App, name: string): BuildJob {
  const row = app.store.project(name);
  if (!row) throw new ProjectError('no_project', `Unknown project "${name}".`);
  const dir = projectDir(app, name);
  if (!hasBuildScript(dir)) throw new ProjectError('no_build', 'This project has no build step (no "build" script in package.json). It can be published as it is.');
  if (jobs.get(name)?.status === 'running') throw new ProjectError('busy', 'A build is already running for this project.');
  if (!runner.npm()) throw new ProjectError('no_npm', 'npm was not found next to Node on this computer. Install Node.js (nodejs.org), then try again.');

  const job: BuildJob = { project: name, status: 'running', step: 'install', started: Date.now(), finished: 0, log: '', error: '', output: null };
  jobs.set(name, job);
  void (async () => {
    try {
      const fresh = !existsSync(join(dir, 'node_modules')) || statSync(join(dir, 'package.json')).mtimeMs > (existsSync(join(dir, 'node_modules', '.package-lock.json')) ? statSync(join(dir, 'node_modules', '.package-lock.json')).mtimeMs : 0);
      if (fresh) {
        const code = await runNpm(job, dir, ['install', '--no-audit', '--no-fund', '--loglevel=error']);
        if (code !== 0) throw new Error(`npm install failed (exit ${code}). See the log.`);
      }
      job.step = 'build';
      const code = await runNpm(job, dir, ['run', 'build']);
      if (code !== 0) throw new Error(`The build failed (exit ${code}). See the log.`);
      const out = publishDir(app, row);
      if (!existsSync(join(out, 'index.html'))) throw new Error(`The build finished but there is no index.html in "${out.slice(dir.length + 1) || '.'}". Check the output folder of your tool.`);
      const files = listFiles(app, name).filter((f) => f.path.startsWith(out.slice(dir.length + 1).replace(/\\/g, '/') + '/')).length;
      job.output = { dir: out.slice(dir.length + 1).replace(/\\/g, '/') || '.', files };
      job.status = 'ok';
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Build failed.';
    } finally {
      job.step = 'done';
      job.finished = Date.now();
    }
  })();

  return job;
}
