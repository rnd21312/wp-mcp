import { AgentError, type RemoteSite, type Release } from './agentclient.ts';
import type { App, Reply } from './context.ts';
import { addHost, buildAgentZip, hostView, needHost, testHost } from './hosts.ts';
import * as projects from './projects.ts';
import { ProjectError } from './projects.ts';

const json = (status: number, body: unknown): Reply => ({ status, json: body, headers: { 'cache-control': 'no-store' } });

const projectView = (p: ReturnType<App['store']['projects']>[number]) => ({ name: p.name, kind: p.kind, host: p.host, site: p.site, publish: p.publish, last_deploy: p.last_deploy, last_release: p.last_release });

/**
 * Studio v2 endpoints of the local panel: Host Agents (connect, sites, releases, rollback) and projects (files, deploy).
 * Returns null for routes that are not ours so the caller can carry on.
 */
export async function studioApi(app: App, method: string, route: string, body: Record<string, any>): Promise<Reply | null> {
  try {
    if (method === 'GET' && route === 'studio') {
      return json(200, { hosts: app.store.hosts().map(hostView), projects: app.store.projects().map(projectView), templates: Object.entries(projects.TEMPLATES).map(([id, t]) => ({ id, label: t.label })) });
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
      case 'projects/create':
        return json(200, { ok: true, project: projectView(projects.createProject(app, { name: str('name'), kind: str('kind') || 'static', template: str('template') || 'landing', title: str('title'), rtl: !!body.rtl })) });
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
        const done = await projects.deployProject(app, { project: str('project'), host: str('host'), site: body.site ? str('site') : undefined, folder: body.folder === undefined ? undefined : str('folder'), url: str('url'), note: str('note') });
        return json(200, { ok: true, ...done });
      }
      default:
        return null;
    }
  } catch (error) {
    if (error instanceof AgentError || error instanceof ProjectError) return json(200, { ok: false, error: { code: error.code, message: error.message } });
    throw error;
  }
}
