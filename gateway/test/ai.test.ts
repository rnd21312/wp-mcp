import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, type Env } from './helpers.ts';

/** A stand-in AI provider that plays a script: each request gets the next scripted reply. */
function fakeProvider(kind: 'openai' | 'anthropic') {
  const requests: any[] = [];
  let script: any[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ url: req.url, headers: req.headers, body });
    const next = script.shift() ?? { text: 'done' };
    const calls: any[] = next.calls ?? [];
    res.writeHead(200, { 'content-type': 'application/json' });
    if (kind === 'openai') res.end(JSON.stringify({ choices: [{ message: { content: next.text ?? null, tool_calls: calls.map((c, i) => ({ id: `c${requests.length}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] }));
    else res.end(JSON.stringify({ content: [...(next.text ? [{ type: 'text', text: next.text }] : []), ...calls.map((c, i) => ({ type: 'tool_use', id: `t${requests.length}_${i}`, name: c.name, input: c.args }))] }));
  });
  return {
    requests,
    play: (s: any[]) => { script = s; requests.length = 0; },
    start: async () => { await new Promise<void>((d) => server.listen(0, '127.0.0.1', d)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; },
    stop: () => new Promise<void>((d) => server.close(() => d())),
  };
}

describe('AI chat with provider keys kept on this computer', () => {
  let env: Env;
  const openai = fakeProvider('openai');
  const claude = fakeProvider('anthropic');
  let base = { openai: '', claude: '' };
  beforeAll(async () => {
    env = await createEnv(['alpha'], { localPanel: true }, { owner: false });
    base = { openai: await openai.start(), claude: await claude.start() };
  });
  afterAll(async () => {
    await env.stop();
    await openai.stop();
    await claude.stop();
  });

  const api = async (path: string, body?: unknown) => (await (await fetch(`${env.base}/admin/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-wpm-panel': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json()) as any;

  it('stores provider keys encrypted and never returns them', async () => {
    const added = await api('ai/providers/add', { preset: 'custom', name: 'Fake GPT', base_url: base.openai, model: 'fake-1', key: 'sk-secret-123' });
    expect(added.ok).toBe(true);
    const list = await api('ai/providers');
    expect(JSON.stringify(list)).not.toContain('sk-secret-123');
    expect(list.providers[0]).toMatchObject({ name: 'Fake GPT', model: 'fake-1', has_key: true });
    expect(list.presets.map((p: any) => p.id)).toEqual(expect.arrayContaining(['openai', 'anthropic', 'gemini', 'openrouter', 'deepseek', 'ollama']));
    expect(env.app.store.aiProviders()[0].key_enc).not.toContain('sk-secret');
    expect((await api('ai/providers/add', { preset: 'custom', base_url: 'ftp://x', model: 'm' })).ok).toBe(false);
  });

  it('runs an OpenAI-compatible tool loop against the selected site', async () => {
    const id = env.app.store.aiProviders()[0].id;
    openai.play([{ calls: [{ name: 'content', args: { action: 'list', args: { per_page: 2 } } }] }, { text: 'Two pages found.' }]);
    const r = await api('ai/chat', { provider: id, site: 'alpha', level: 'read', messages: [{ role: 'user', content: 'list pages' }] });
    expect(r.ok).toBe(true);
    expect(r.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Two pages found.' });
    expect(env.sites.alpha.executed('content.list').at(-1)!.level).toBe('read');
    const first = openai.requests[0];
    expect(first.headers.authorization).toBe('Bearer sk-secret-123');
    expect(first.body.tools.map((t: any) => t.function.name)).toContain('content');
    expect(first.body.messages[0].content).toContain('site {action:"sites"}');
    // The second request carries the tool result, with the site name echoed by the gateway.
    const toolMsg = openai.requests[1].body.messages.find((m: any) => m.role === 'tool');
    expect(JSON.parse(toolMsg.content).site).toBe('alpha');
  });

  it('respects the level: a read-level chat cannot write', async () => {
    const id = env.app.store.aiProviders()[0].id;
    openai.play([{ calls: [{ name: 'content', args: { action: 'trash', args: { id: 1 } } }] }, { text: 'Not allowed.' }]);
    const r = await api('ai/chat', { provider: id, site: 'alpha', level: 'read', messages: [{ role: 'user', content: 'trash page 1' }] });
    const tool = r.messages.find((m: any) => m.role === 'tool');
    expect(JSON.parse(tool.content).error.code).toBe('level_too_low');
    expect(env.sites.alpha.executed('content.trash')).toHaveLength(0);
  });

  it('pauses for confirmation and only runs after the person approves', async () => {
    env.sites.alpha.answers['plugins.delete'] = (args, call) => (call.dry_run ? { will_delete: args.plugin } : { deleted: args.plugin });
    const id = env.app.store.aiProviders()[0].id;
    openai.play([{ calls: [{ name: 'plugins', args: { action: 'delete', args: { plugin: 'a/a.php' } } }] }]);
    const first = await api('ai/chat', { provider: id, site: 'alpha', level: 'admin', messages: [{ role: 'user', content: 'delete plugin a' }] });
    expect(first.pending).toMatchObject({ name: 'plugins', preview: { will_delete: 'a/a.php' } });
    expect(env.sites.alpha.executed('plugins.delete')).toHaveLength(0);

    openai.play([{ text: 'Deleted.' }]);
    const done = await api('ai/chat', { provider: id, site: 'alpha', level: 'admin', messages: first.messages, approve: { toolCallId: first.pending.toolCallId, ok: true } });
    expect(env.sites.alpha.executed('plugins.delete')).toHaveLength(1);
    expect(done.messages.at(-1).content).toBe('Deleted.');

    // Declining never runs it.
    openai.play([{ calls: [{ name: 'plugins', args: { action: 'delete', args: { plugin: 'b/b.php' } } }] }]);
    const second = await api('ai/chat', { provider: id, site: 'alpha', level: 'admin', messages: [{ role: 'user', content: 'delete b' }] });
    openai.play([{ text: 'Okay, I left it.' }]);
    const declined = await api('ai/chat', { provider: id, site: 'alpha', level: 'admin', messages: second.messages, approve: { toolCallId: second.pending.toolCallId, ok: false } });
    expect(env.sites.alpha.executed('plugins.delete')).toHaveLength(1);
    expect(declined.messages.find((m: any) => m.role === 'tool').content).toMatch(/declined/);
  });

  it('speaks the Anthropic Messages format too', async () => {
    const added = await api('ai/providers/add', { preset: 'anthropic', name: 'Fake Claude', base_url: base.claude, model: 'claude-test', key: 'ant-key' });
    claude.play([{ calls: [{ name: 'site', args: { action: 'whoami' } }] }, { text: 'You are admin-panel.' }]);
    const r = await api('ai/chat', { provider: added.id, site: 'alpha', level: 'live', messages: [{ role: 'user', content: 'who am i' }] });
    expect(r.messages.at(-1).content).toBe('You are admin-panel.');
    expect(claude.requests[0].url).toBe('/messages');
    expect(claude.requests[0].headers['x-api-key']).toBe('ant-key');
    expect(claude.requests[0].body.tools[0]).toHaveProperty('input_schema');
    const second = claude.requests[1].body.messages.at(-1);
    expect(second.role).toBe('user');
    expect(second.content[0].type).toBe('tool_result');
  });

  it('reports provider errors without leaking the key', async () => {
    const bad = await api('ai/providers/add', { preset: 'custom', name: 'Broken', base_url: 'http://127.0.0.1:1', model: 'x', key: 'sk-leak' });
    const r = await api('ai/chat', { provider: bad.id, level: 'read', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('sk-leak');
  });
});
