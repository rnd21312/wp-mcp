import { canUseSite, type Principal } from '../auth.ts';
import type { App } from '../context.ts';
import { INSTRUCTIONS, opsMarkdown, PROMPTS, resourceList, resourceTemplates, TOPICS } from './guide.ts';
import { callTool, listTools, type Input } from './tools.ts';

export const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const VERSION = '2.1.0';

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type Response = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const ok = (id: Message['id'], result: unknown): Response => ({ jsonrpc: '2.0', id: id ?? null, result });
const err = (id: Message['id'], code: number, message: string): Response => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** Handles one JSON-RPC message. Stateless: nothing is remembered between calls. Returns null for notifications. */
export async function handleMessage(app: App, principal: Principal, message: Message): Promise<Response | null> {
  const id = message.id;
  const params = message.params ?? {};
  if (message.method === undefined) return id === undefined ? null : err(id, -32600, 'Invalid request.');
  if (id === undefined || id === null) return null;

  switch (message.method) {
    case 'initialize': {
      const asked = String(params.protocolVersion ?? '');
      return ok(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false }, logging: {} },
        serverInfo: { name: 'wp-mcp', title: 'WordPress MCP gateway', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
    case 'logging/setLevel':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: listTools(principal) });
    case 'tools/call': {
      const name = String(params.name ?? '');
      return ok(id, await callTool(app, principal, name, (params.arguments ?? {}) as Input));
    }
    case 'resources/list':
      return ok(id, { resources: resourceList() });
    case 'resources/templates/list':
      return ok(id, { resourceTemplates: resourceTemplates() });
    case 'resources/read': {
      const uri = String(params.uri ?? '');
      const read = readResource(app, principal, uri);
      return read ? ok(id, { contents: [{ uri, mimeType: read.mime, text: read.text }] }) : err(id, -32002, `Resource not found: ${uri}`);
    }
    case 'prompts/list':
      return ok(id, { prompts: PROMPTS.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args })) });
    case 'prompts/get': {
      const prompt = PROMPTS.find((p) => p.name === params.name);
      if (!prompt) return err(id, -32602, `Unknown prompt: ${String(params.name)}`);
      const args = Object.fromEntries(Object.entries((params.arguments ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
      return ok(id, { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text: prompt.build(args) } }] });
    }
    case 'completion/complete':
      return ok(id, { completion: { values: [], hasMore: false } });
    default:
      return err(id, -32601, `Method not found: ${message.method}`);
  }
}

function readResource(app: App, principal: Principal, uri: string): { mime: string; text: string } | null {
  if (uri.startsWith('wpmcp://guide/')) {
    const topic = TOPICS[uri.slice('wpmcp://guide/'.length)];
    return topic ? { mime: 'text/markdown', text: topic.text() } : null;
  }
  if (uri === 'wpmcp://ops') return { mime: 'text/markdown', text: opsMarkdown(principal) };
  if (uri === 'wpmcp://sites') {
    const sites = app.store.sites().filter((s) => canUseSite(principal, s.name)).map((s) => ({ name: s.name, url: s.url, title: s.title, status: s.status }));
    return { mime: 'application/json', text: JSON.stringify({ sites }) };
  }
  const activity = /^wpmcp:\/\/(?:activity|site\/([^/]+)\/activity)$/.exec(uri);
  if (activity) {
    const site = activity[1] ? decodeURIComponent(activity[1]) : undefined;
    if (site && !canUseSite(principal, site)) return null;
    const rows = app.store.activity({ site, limit: 50 }).filter((r) => !r.site || canUseSite(principal, r.site));
    return { mime: 'application/json', text: JSON.stringify({ entries: rows.map((r) => ({ id: r.id, at: new Date(r.ts * 1000).toISOString(), by: r.principal_name, site: r.site, op: `${r.tool}.${r.action}`, status: r.status, summary: r.summary })) }) };
  }
  return null;
}
