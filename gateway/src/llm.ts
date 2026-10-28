import type { Provider, ProviderType } from './ai.ts';
import { askAnthropic, askOpenAI } from './ai.ts';
import type { App } from './context.ts';
import { decrypt } from './crypto.ts';

/** One-shot text completion with any configured provider (no tools). Replaceable in tests. */
export const llm = {
  async complete(app: App, providerId: string, system: string, user: string): Promise<string> {
    const row = app.store.aiProvider(providerId);
    if (!row) throw new LlmError('no_provider', 'Choose an AI provider first (AI assistant page → add a key).');
    const provider: Provider = { id: row.id, type: row.type as ProviderType, base: row.base_url, model: row.model, key: row.key_enc ? decrypt(app.config.masterKey, row.key_enc) : '' };
    const msgs = [{ role: 'user' as const, content: user }];
    try {
      const reply = provider.type === 'anthropic' ? await askAnthropic(provider, system, msgs, []) : await askOpenAI(provider, system, msgs, []);
      return reply.text;
    } catch (error) {
      throw new LlmError('provider_failed', `The AI provider failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  },
};

export class LlmError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Pulls the first JSON object out of a reply (models like to wrap it in fences or add a sentence). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text].filter((x): x is string => !!x);
  for (const c of candidates) {
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {
      /* try the next candidate */
    }
  }
  throw new LlmError('bad_json', 'The AI did not answer with valid JSON.');
}

/** Asks for JSON, checks it with `validate` (which throws a readable message), and retries once telling the model what was wrong. */
export async function askJson<T>(app: App, providerId: string, system: string, user: string, validate: (raw: unknown) => T): Promise<T> {
  let note = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await llm.complete(app, providerId, system, note ? `${user}\n\nYour previous answer was rejected: ${note}\nAnswer again with only the corrected JSON.` : user);
    try {
      return validate(extractJson(text));
    } catch (error) {
      note = error instanceof Error ? error.message : 'invalid';
      if (attempt === 1) throw new LlmError('bad_answer', `The AI answer was not usable (${note}). Try again, or pick a stronger model.`);
    }
  }
  throw new LlmError('bad_answer', 'The AI answer was not usable.');
}

/** Raw text answer with fences and chatter removed (used for HTML fragments). */
export function stripFences(text: string): string {
  const fenced = /```(?:html)?\s*([\s\S]*?)```/i.exec(text);

  return (fenced ? fenced[1] : text).trim();
}
