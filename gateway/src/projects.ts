import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { AgentError, type Release } from './agentclient.ts';
import type { App } from './context.ts';
import { needHost } from './hosts.ts';
import type { ProjectRow } from './store.ts';
import { FRAMEWORKS } from './templates.ts';
import { zipDirectory } from './zip.ts';

export const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const PROJECT_KINDS = ['static', 'spa'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];
const TEXT_LIMIT = 2 * 1024 * 1024;
const META = '.wpm-project.json';

export const projectFramework = (app: App, name: string): string => {
  try {
    return String((JSON.parse(readFileSync(join(projectDir(app, name), META), 'utf8')) as { framework?: string }).framework ?? '');
  } catch {
    return '';
  }
};

export const projectDir = (app: App, name: string): string => join(app.config.dataDir, 'projects', name);

export class ProjectError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function needProject(app: App, name: string): ProjectRow {
  const row = app.store.project(name);
  if (!row) throw new ProjectError('no_project', `Unknown project "${name}".`);

  return row;
}

/** Resolves a path given by the UI or the AI inside the project folder only. */
export function safePath(root: string, rel: string): string {
  if (!rel || rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) throw new ProjectError('bad_path', 'That path is not allowed.');
  const parts = rel.split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.some((p) => p === '..')) throw new ProjectError('bad_path', 'That path is not allowed.');
  const full = resolve(root, ...parts);
  if (full !== root && !full.startsWith(root + sep)) throw new ProjectError('bad_path', 'That path leaves the project.');
  // A symlink inside the project must not lead out of it.
  let probe = full;
  while (!existsSync(probe) && probe !== root) probe = dirname(probe);
  const real = realpathSync(probe);
  const realRoot = realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new ProjectError('bad_path', 'That path leaves the project.');

  return full;
}

// ---- templates --------------------------------------------------------------------------------------------------

const page = (title: string, body: string, rtl: boolean): string => `<!doctype html>
<html lang="${rtl ? 'fa' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
${body}
<script src="app.js"></script>
</body>
</html>
`;

export const TEMPLATES: Record<string, { label: string; files: (title: string, rtl: boolean) => Record<string, string> }> = {
  blank: {
    label: 'Blank page',
    files: (title, rtl) => ({
      'index.html': page(title, `<main><h1>${title}</h1></main>`, rtl),
      'style.css': 'body{font-family:system-ui,Tahoma,sans-serif;margin:0;padding:2rem;line-height:1.7}\n',
      'app.js': '// your code\n',
    }),
  },
  landing: {
    label: 'Landing page',
    files: (title, rtl) => ({
      'index.html': page(
        title,
        `<header class="hero"><h1>${title}</h1><p>${rtl ? 'یک جمله‌ی کوتاه درباره‌ی کسب‌وکار شما.' : 'One short sentence about what you do.'}</p><a class="btn" href="#contact">${rtl ? 'تماس با ما' : 'Contact us'}</a></header>
<section class="features"><article><h2>${rtl ? 'ویژگی اول' : 'Feature one'}</h2><p>…</p></article><article><h2>${rtl ? 'ویژگی دوم' : 'Feature two'}</h2><p>…</p></article><article><h2>${rtl ? 'ویژگی سوم' : 'Feature three'}</h2><p>…</p></article></section>
<footer id="contact"><p>${rtl ? 'ایمیل' : 'Email'}: hello@example.com</p></footer>`,
        rtl,
      ),
      'style.css': `:root{--fg:#14213d;--accent:#2563eb}*{box-sizing:border-box}body{margin:0;font-family:system-ui,Tahoma,sans-serif;color:var(--fg);line-height:1.7}
.hero{padding:6rem 1.5rem;text-align:center;background:linear-gradient(135deg,#e0ecff,#fff)}.hero h1{font-size:clamp(2rem,6vw,3.5rem);margin:0 0 .5rem}
.btn{display:inline-block;margin-top:1rem;padding:.7rem 1.4rem;border-radius:.6rem;background:var(--accent);color:#fff;text-decoration:none}
.features{display:grid;gap:1.5rem;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));max-width:960px;margin:3rem auto;padding:0 1.5rem}
footer{padding:2rem;text-align:center;border-top:1px solid #e5e7eb}
`,
      'app.js': 'document.documentElement.classList.add("js");\n',
    }),
  },
};

export function createProject(app: App, input: { name: string; kind?: string; template?: string; title?: string; rtl?: boolean }): ProjectRow {
  const name = input.name.trim().toLowerCase();
  if (!PROJECT_NAME.test(name)) throw new ProjectError('bad_name', 'Project names are 2-40 characters: a-z, 0-9 and dash.');
  if (app.store.project(name)) throw new ProjectError('name_taken', `A project named "${name}" already exists.`);
  const wanted = input.template ?? 'landing';
  const framework = FRAMEWORKS[wanted];
  const template = framework ?? TEMPLATES[wanted];
  if (!template) throw new ProjectError('bad_template', 'Unknown template.');
  const kind = (framework ? framework.kind : input.kind ?? 'static') as ProjectKind;
  if (!PROJECT_KINDS.includes(kind)) throw new ProjectError('bad_kind', `Project type must be one of: ${PROJECT_KINDS.join(', ')}.`);
  const dir = projectDir(app, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(template.files(input.title?.trim() || name, !!input.rtl))) {
    const target = join(dir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  if (framework) writeFileSync(join(dir, META), JSON.stringify({ framework: framework.framework, kind, publish: framework.publish }, null, 2));
  app.store.addProject({ name, kind, publish: framework ? framework.publish : '.' });

  return app.store.project(name)!;
}

export function removeProject(app: App, name: string, deleteFiles: boolean): void {
  needProject(app, name);
  app.store.removeProject(name);
  if (deleteFiles) rmSync(projectDir(app, name), { recursive: true, force: true });
}

// ---- files ------------------------------------------------------------------------------------------------------

export interface FileInfo {
  path: string;
  bytes: number;
}

export function listFiles(app: App, name: string): FileInfo[] {
  needProject(app, name);
  const root = projectDir(app, name);
  const out: FileInfo[] = [];
  const skip = new Set(['node_modules', '.git']);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (!skip.has(entry) && out.length < 5000) walk(full);
      } else out.push({ path: relative(root, full).split(sep).join('/'), bytes: info.size });
    }
  };
  walk(root);

  return out;
}

export function readFile(app: App, name: string, rel: string): { path: string; content: string; binary: boolean; bytes: number } {
  needProject(app, name);
  const full = safePath(projectDir(app, name), rel);
  if (!existsSync(full) || !statSync(full).isFile()) throw new ProjectError('no_file', 'That file does not exist.');
  const data = readFileSync(full);
  const binary = data.includes(0) || data.length > TEXT_LIMIT;

  return { path: rel, content: binary ? '' : data.toString('utf8'), binary, bytes: data.length };
}

export function writeFile(app: App, name: string, rel: string, content: string): void {
  needProject(app, name);
  if (Buffer.byteLength(content) > TEXT_LIMIT) throw new ProjectError('too_large', 'That file is too large to edit here.');
  const full = safePath(projectDir(app, name), rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export function deleteFile(app: App, name: string, rel: string): void {
  needProject(app, name);
  const full = safePath(projectDir(app, name), rel);
  if (!existsSync(full)) throw new ProjectError('no_file', 'That file does not exist.');
  rmSync(full, { recursive: true, force: true });
}

// ---- deploy -----------------------------------------------------------------------------------------------------

/** The folder that goes live: a build output (dist/) when there is one, otherwise the project root. */
export function publishDir(app: App, row: ProjectRow): string {
  const root = projectDir(app, row.name);
  if (row.publish && row.publish !== '.') return safePath(root, row.publish);
  const dist = join(root, 'dist');

  return existsSync(join(dist, 'index.html')) ? dist : root;
}

export interface DeployInput {
  project: string;
  host: string;
  /** Existing site id on the host; created when omitted. */
  site?: string;
  /** Folder under the host's web root for a new site ('' = the web root itself). */
  folder?: string;
  url?: string;
  note?: string;
}

export async function deployProject(app: App, input: DeployInput): Promise<{ site: string; release: Release & { previous: string | null; mode: string }; files: number; bytes: number }> {
  const row = needProject(app, input.project);
  const host = needHost(app, input.host);
  const dir = publishDir(app, row);
  if (!existsSync(join(dir, 'index.html'))) throw new ProjectError('no_index', `There is no index.html in ${relative(projectDir(app, row.name), dir) || 'the project'}. Build the project first, or add an index.html.`);

  let site = input.site || (row.host === host.name ? row.site : '');
  if (!site) {
    const created = await app.agents.call<{ site: { id: string } }>(host, 'sites.create', { name: row.name, kind: row.kind, folder: input.folder ?? row.name, url: input.url ?? '' });
    site = created.site.id;
  }
  const packed = zipDirectory(dir);
  const release = await app.agents.deploy(host, site, packed.buffer, input.note ?? `Studio deploy of ${row.name}`);
  app.store.projectDeployed(row.name, host.name, site, release.id);
  app.store.log({ principal: 'studio', principal_name: 'Studio', tool: 'deploy', action: 'push', site: host.name, level: 'live', status: 'ok', summary: `${row.name} -> ${host.name}/${site} (${packed.files} files, release ${release.id})`, request_id: release.id, revision: 0 });

  return { site, release, files: packed.files, bytes: packed.bytes };
}

export const isAgentError = (e: unknown): e is AgentError => e instanceof AgentError;
