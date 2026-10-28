import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentError, type RemoteSite, type Release } from './agentclient.ts';
import type { App, Reply } from './context.ts';
import { addHost, agentRelease, buildAgentZip, checkHost, hostView, needHost, testHost, updateAgent } from './hosts.ts';
import { buildStatus, hasBuildScript, startBuild } from './build.ts';
import * as projects from './projects.ts';
import { FRAMEWORKS } from './templates.ts';
import { approve, pageMain, preview, publish, runStage, startBuilder, STAGES, stateView, BuilderError, type Stage } from './builder.ts';
import { createWordPress, type DbSpec } from './wordpress.ts';
import { ProjectError } from './projects.ts';

const json = (status: number, body: unknown): Reply => ({ status, json: body, headers: { 'cache-control': 'no-store' } });

const projectView = (app: App, p: ReturnType<App['store']['projects']>[number]) => ({ name: p.name, kind: p.kind, host: p.host, site: p.site, publish: p.publish, last_deploy: p.last_deploy, last_release: p.last_release, framework: projects.projectFramework(app, p.name), has_build: hasBuildScript(projects.projectDir(app, p.name)), builder: existsSync(join(projects.projectDir(app, p.name), '.wpm-builder', 'state.json')) });

/**
 * Studio v2 endpoints of the local panel: Host Agents (connect, sites, releases, rollback) and projects (files, deploy).
 * Returns null for routes that are not ours so the caller can carry on.
 */
export async function studioApi(app: App, method: string, route: string, body: Record<string, any>): Promise<Reply | null> {
  try {
    if (method === 'GET' && route === 'studio') {
      return json(200, { agent_release: agentRelease()?.version ?? '', hosts: app.store.hosts().map(hostView), projects: app.store.projects().map((p) => projectView(app, p)), templates: [...Object.entries(projects.TEMPLATES).map(([id, t]) => ({ id, label: t.label, build: false, note: '' })), ...Object.entries(FRAMEWORKS).map(([id, t]) => ({ id, label: t.label, build: true, note: t.note }))] });
    }
    if (method !== 'POST') return null;
    const str = (key: string): string => String(body[key] ?? '');

    switch (route) {
      case 'agent/zip': {
        const built = buildAgentZip();
        return json(200, { ok: true, filename: 'wpm-agent.zip', setup_code: built.setupCode, files: built.files, base64: built.zip.toString('base64') });
      }
      case 'hosts/add': {
        const host = await addHost(app, { url: str('url'), code: str('code'), name: str('name') });
        return json(200, { ok: true, host: hostView(host) });
      }
      case 'hosts/check':
        return json(200, { ok: true, ...(await checkHost(app, str('name'))) });
      case 'hosts/update-agent':
        return json(200, { ok: true, ...(await updateAgent(app, str('name'))) });
      case 'hosts/test':
        return json(200, await testHost(app, str('name')));
      case 'hosts/remove':
        app.store.removeHost(str('name'));
        return json(200, { ok: true });
      case 'hosts/sites': {
        const out = await app.agents.call<{ sites: RemoteSite[] }>(needHost(app, str('host')), 'sites.list', {}, { retry: true });
        return json(200, { ok: true, sites: out.sites });
      }
      case 'hosts/sites/create': {
        const out = await app.agents.call<{ site: RemoteSite }>(needHost(app, str('host')), 'sites.create', { name: body.name, kind: body.kind, folder: body.folder, url: body.url, mode: body.mode });
        return json(200, { ok: true, site: out.site });
      }
      case 'hosts/sites/delete':
        await app.agents.call(needHost(app, str('host')), 'sites.delete', { site: str('site'), purge: !!body.purge });
        return json(200, { ok: true });
      case 'hosts/releases': {
        const out = await app.agents.call<{ current: string | null; releases: Release[] }>(needHost(app, str('host')), 'releases.list', { site: str('site') }, { retry: true });
        return json(200, { ok: true, ...out });
      }
      case 'hosts/rollback': {
        const host = needHost(app, str('host'));
        const out = await app.agents.call<{ current: string; previous: string | null }>(host, 'rollback', { site: str('site'), release: body.release ? str('release') : undefined });
        app.store.log({ principal: 'studio', principal_name: 'Studio', tool: 'deploy', action: 'rollback', site: host.name, level: 'live', status: 'ok', summary: `${str('site')}: ${out.previous} -> ${out.current}`, request_id: out.current, revision: 0 });
        return json(200, { ok: true, ...out });
      }
      case 'hosts/audit': {
        const out = await app.agents.call<{ entries: unknown[] }>(needHost(app, str('host')), 'audit', { limit: 100 }, { retry: true });
        return json(200, { ok: true, ...out });
      }
      case 'hosts/wordpress/create': {
        const r = await createWordPress(app, { host: str('host'), name: str('name') || undefined, folder: body.folder === undefined ? undefined : str('folder'), url: str('url') || undefined, title: str('title') || str('name'), adminUser: str('admin_user') || undefined, adminEmail: str('admin_email'), adminPassword: str('admin_password') || undefined, searchEngines: body.search_engines !== false, locale: str('locale') || undefined, db: (body.db ?? { method: 'manual' }) as DbSpec });
        return json(200, { ok: true, site: { name: r.site.name, url: r.site.url }, url: r.url, admin_user: r.admin_user, admin_password: r.admin_password, wp_version: r.wp_version });
      }
      case 'hosts/env': {
        const out = await app.agents.call(needHost(app, str('host')), 'sites.env', { site: str('site'), env: body.env ?? {} });
        return json(200, { ok: true, ...out });
      }
      case 'hosts/node-script': {
        const out = await app.agents.call<{ script: string }>(needHost(app, str('host')), 'node.script', { site: str('site'), domain: str('domain'), user: str('user'), install_db: !!body.install_db });
        return json(200, { ok: true, ...out });
      }
      case 'builder/start': {
        const s = startBuilder(app, { name: str('name'), brief: str('brief'), language: str('language') || 'en', tone: str('tone'), pagesHint: str('pages_hint'), baseUrl: str('base_url'), provider: str('provider') });
        return json(200, { ok: true, project: s.project });
      }
      case 'builder/state':
        return json(200, { ok: true, state: stateView(app, str('project')) });
      case 'builder/run': {
        if (!STAGES.includes(str('stage') as Stage)) return json(200, { ok: false, error: { code: 'bad_stage', message: 'Unknown step.' } });
        await runStage(app, str('project'), { stage: str('stage') as Stage, slug: body.slug ? str('slug') : undefined, feedback: str('feedback') });
        return json(200, { ok: true, state: stateView(app, str('project')) });
      }
      case 'builder/approve': {
        if (!STAGES.includes(str('stage') as Stage)) return json(200, { ok: false, error: { code: 'bad_stage', message: 'Unknown step.' } });
        approve(app, str('project'), { stage: str('stage') as Stage, slug: body.slug ? str('slug') : undefined, edit: body.edit });
        return json(200, { ok: true, state: stateView(app, str('project')) });
      }
      case 'builder/page':
        return json(200, { ok: true, main: pageMain(app, str('project'), str('slug')) });
      case 'builder/preview':
        return json(200, { ok: true, html: preview(app, str('project'), str('slug')) });
      case 'builder/publish': {
        const done = await publish(app, str('project'), { host: str('host'), site: body.site ? str('site') : undefined, folder: body.folder === undefined ? undefined : str('folder'), url: str('url') || undefined, note: str('note') || undefined });
        return json(200, { ok: true, ...done });
      }
      case 'projects/create':
        return json(200, { ok: true, project: projectView(app, projects.createProject(app, { name: str('name'), kind: str('kind') || 'static', template: str('template') || 'landing', title: str('title'), rtl: !!body.rtl })) });
      case 'projects/build': {
        const job = startBuild(app, str('project'));
        return json(200, { ok: true, job });
      }
      case 'projects/build-status':
        return json(200, { ok: true, job: buildStatus(str('project')) });
      case 'projects/remove':
        projects.removeProject(app, str('name'), !!body.delete_files);
        return json(200, { ok: true });
      case 'projects/files':
        return json(200, { ok: true, files: projects.listFiles(app, str('project')) });
      case 'projects/read':
        return json(200, { ok: true, ...projects.readFile(app, str('project'), str('path')) });
      case 'projects/write':
        projects.writeFile(app, str('project'), str('path'), str('content'));
        return json(200, { ok: true });
      case 'projects/delete-file':
        projects.deleteFile(app, str('project'), str('path'));
        return json(200, { ok: true });
      case 'projects/deploy': {
        const done = await projects.deployProject(app, { project: str('project'), host: str('host'), site: body.site ? str('site') : undefined, folder: body.folder === undefined ? undefined : str('folder'), url: str('url'), note: str('note'), node: body.node ? { appRoot: body.node.app_root || undefined, docroot: body.node.docroot || undefined, port: body.node.port ? Number(body.node.port) : undefined, env: body.node.env ?? undefined, checkUrl: body.node.check_url || undefined } : undefined });
        return json(200, { ok: true, ...done });
      }
      default:
        return null;
    }
  } catch (error) {
    if (error instanceof AgentError || error instanceof ProjectError || error instanceof BuilderError) return json(200, { ok: false, error: { code: error.code, message: error.message } });
    throw error;
  }
}
