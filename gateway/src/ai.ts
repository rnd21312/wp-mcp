import { randomBytes } from 'node:crypto';
import type { Principal } from './auth.ts';
import type { App } from './context.ts';
import { decrypt, encrypt } from './crypto.ts';
import { INSTRUCTIONS } from './mcp/guide.ts';
import { callTool, listTools } from './mcp/tools.ts';

/** Chat with any AI provider, with this gateway's tools. Keys stay on this computer, encrypted in the data folder. */

export type ProviderType = 'openai' | 'anthropic';

export interface Preset {
  id: string;
  label: string;
  type: ProviderType;
  base: string;
  model: string;
  models: string[];
  needsKey: boolean;
  keyUrl: string;
}

export const PRESETS: Preset[] = [
  { id: 'openai', label: 'OpenAI (ChatGPT)', type: 'openai', base: 'https://api.openai.com/v1', model: 'gpt-4.1', models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'o4-mini'], needsKey: true, keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic (Claude)', type: 'anthropic', base: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'], needsKey: true, keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'gemini', label: 'Google Gemini', type: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro', models: ['gemini-2.5-pro', 'gemini-2.5-flash'], needsKey: true, keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'openrouter', label: 'OpenRouter (hundreds of models)', type: 'openai', base: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1', models: ['openai/gpt-4.1', 'anthropic/claude-sonnet-4.5', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat'], needsKey: true, keyUrl: 'https://openrouter.ai/keys' },
  { id: 'deepseek', label: 'DeepSeek', type: 'openai', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'], needsKey: true, keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'groq', label: 'Groq', type: 'openai', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', models: ['llama-3.3-70b-versatile'], needsKey: true, keyUrl: 'https://console.groq.com/keys' },
  { id: 'mistral', label: 'Mistral', type: 'openai', base: 'https://api.mistral.ai/v1', model: 'mistral-large-latest', models: ['mistral-large-latest'], needsKey: true, keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'xai', label: 'xAI (Grok)', type: 'openai', base: 'https://api.x.ai/v1', model: 'grok-4', models: ['grok-4'], needsKey: true, keyUrl: 'https://console.x.ai' },
  { id: 'ollama', label: 'Ollama (local, free)', type: 'openai', base: 'http://127.0.0.1:11434/v1', model: 'llama3.1', models: ['llama3.1', 'qwen2.5', 'mistral'], needsKey: false, keyUrl: 'https://ollama.com' },
  { id: 'custom', label: 'Custom (OpenAI-compatible URL)', type: 'openai', base: '', model: '', models: [], needsKey: false, keyUrl: '' },
];

/* -------------------------------------------------------------- messages */

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Msg {
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  isError?: boolean;
}

export interface Pending {
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  token: string;
  preview: unknown;
  action: string;
}

export interface ChatResult {
  ok: boolean;
  messages: Msg[];
  pending?: Pending;
  error?: string;
}

const clip = (s: string, n = 30000): string => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);

interface Provider {
  id: string;
  type: ProviderType;
  base: string;
  model: string;
  key: string;
}

const toolDefs = (principal: Principal) => listTools(principal).map((t) => ({ name: t.name, description: t.description, schema: t.inputSchema }));

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${res.status}: ${data?.error?.message ?? data?.error ?? data?.message ?? text.slice(0, 300)}`);

  return data;
}

async function askOpenAI(p: Provider, system: string, msgs: Msg[], tools: ReturnType<typeof toolDefs>): Promise<{ text: string; calls: ToolCall[] }> {
  const messages: any[] = [{ role: 'system', content: system }];
  for (const m of msgs) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.content ?? '' });
    else if (m.role === 'assistant') messages.push({ role: 'assistant', content: m.content ?? (m.toolCalls?.length ? null : ''), ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) });
    else messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' });
  }
  const data = await post(`${p.base.replace(/\/+$/, '')}/chat/completions`, p.key ? { authorization: `Bearer ${p.key}` } : {}, { model: p.model, messages, tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })), tool_choice: 'auto' });
  const message = data.choices?.[0]?.message ?? {};
  const calls: ToolCall[] = (message.tool_calls ?? []).map((c: any) => {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* model sent bad JSON */ }
    return { id: String(c.id ?? randomBytes(4).toString('hex')), name: String(c.function?.name ?? ''), args };
  });

  return { text: typeof message.content === 'string' ? message.content : '', calls };
}

async function askAnthropic(p: Provider, system: string, msgs: Msg[], tools: ReturnType<typeof toolDefs>): Promise<{ text: string; calls: ToolCall[] }> {
  const messages: any[] = [];
  for (const m of msgs) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.content ?? '' });
    else if (m.role === 'assistant') messages.push({ role: 'assistant', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...(m.toolCalls ?? []).map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args }))] });
    else {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content ?? '', ...(m.isError ? { is_error: true } : {}) };
      const last = messages.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block); else messages.push({ role: 'user', content: [block] });
    }
  }
  const data = await post(`${p.base.replace(/\/+$/, '')}/messages`, { 'x-api-key': p.key, 'anthropic-version': '2023-06-01' }, { model: p.model, max_tokens: 4096, system, messages, tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })) });
  const blocks: any[] = data.content ?? [];

  return { text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), calls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: String(b.id), name: String(b.name), args: (b.input ?? {}) as Record<string, unknown> })) };
}

export interface ChatInput {
  providerId: string;
  site?: string;
  level: Principal['level'];
  messages: Msg[];
  approve?: { toolCallId: string; ok: boolean };
  language?: string;
}

/** Runs the tool loop. Stops for a confirmation (returned as pending) or when the model gives a final answer. */
export async function chat(app: App, input: ChatInput): Promise<ChatResult> {
  const row = app.store.aiProvider(input.providerId);
  if (!row) return { ok: false, messages: input.messages, error: 'Unknown provider. Add one in AI settings.' };
  const provider: Provider = { id: row.id, type: row.type as ProviderType, base: row.base_url, model: row.model, key: row.key_enc ? decrypt(app.config.masterKey, row.key_enc) : '' };
  const principal: Principal = { id: 'ai-panel', kind: 'stdio', name: `AI chat (${row.name})`, level: input.level, sites: '*' };
  const tools = toolDefs(principal);
  const system = `${INSTRUCTIONS}\n\nYou are working inside the owner's local panel. ${input.site ? `The selected site is "${input.site}": use it as "site" unless the person names another.` : ''} Answer in the language the person writes in. Keep answers short; say what you changed and the revision IDs.`;
  const messages: Msg[] = [...input.messages];

  const run = async (call: ToolCall, token?: string): Promise<{ msg: Msg; pending?: Pending }> => {
    const args = { ...(call.args as Record<string, unknown>) };
    if (input.site && !args.site) args.site = input.site;
    if (token) args.confirm_token = token;
    const result = await callTool(app, principal, call.name, args);
    const text = result.content[0].text;
    try {
      const parsed = JSON.parse(text);
      if (parsed.needs_confirmation && parsed.confirm_token) return { msg: { role: 'tool', toolCallId: call.id, name: call.name, content: '' }, pending: { toolCallId: call.id, name: call.name, input: call.args, token: parsed.confirm_token, preview: parsed.preview, action: parsed.action } };
    } catch { /* plain text */ }

    return { msg: { role: 'tool', toolCallId: call.id, name: call.name, content: clip(text), isError: !!result.isError } };
  };

  /** Executes the tool calls of the last assistant message that have no answer yet. Returns a pending confirmation if one is needed. */
  const settle = async (): Promise<Pending | undefined> => {
    const last = [...messages].reverse().find((m) => m.role === 'assistant');
    for (const call of last?.toolCalls ?? []) {
      if (messages.some((m) => m.role === 'tool' && m.toolCallId === call.id)) continue;
      const approval = input.approve?.toolCallId === call.id ? input.approve : undefined;
      if (approval && !approval.ok) { messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: 'The person declined this action. Do not retry it; ask what they want instead.', isError: true }); continue; }
      let token: string | undefined;
      if (approval?.ok) {
        // The token was issued for exactly these arguments in an earlier turn; ask again to get a fresh one, then use it.
        const first = await run(call);
        if (!first.pending) { messages.push(first.msg); continue; }
        token = first.pending.token;
      }
      const out = await run(call, token);
      if (out.pending) return out.pending;
      messages.push(out.msg);
    }

    return undefined;
  };

  try {
    let pending = await settle();
    if (pending) return { ok: true, messages, pending };
    for (let step = 0; step < 10; step++) {
      const reply = provider.type === 'anthropic' ? await askAnthropic(provider, system, messages, tools) : await askOpenAI(provider, system, messages, tools);
      messages.push({ role: 'assistant', content: reply.text, ...(reply.calls.length ? { toolCalls: reply.calls } : {}) });
      if (!reply.calls.length) return { ok: true, messages };
      pending = await settle();
      if (pending) return { ok: true, messages, pending };
    }

    return { ok: true, messages, error: 'Stopped after 10 steps. Say "continue" to go on.' };
  } catch (error) {
    return { ok: false, messages, error: error instanceof Error ? error.message : 'Failed' };
  }
}

export const sealKey = (app: App, key: string): string => (key ? encrypt(app.config.masterKey, key) : '');
