export interface Site {
  name: string;
  url: string;
  title: string;
  status: 'ok' | 'error' | 'new';
  last_error: string;
  last_ok: number;
  max_level: string;
  wp_version: string;
  plugin_version: string;
}

export interface Activity {
  id: number;
  ts: number;
  principal_name: string;
  tool: string;
  action: string;
  site: string;
  level: string;
  status: string;
  summary: string;
  revision: number;
}

export interface State {
  version: string;
  levels: string[];
  publicUrl: string;
  dataDir: string;
  entry: string;
  preview: { base: string; token: string };
  sites: Site[];
  keys: { id: string; name: string; prefix: string; level: string; sites: string[] | '*'; created: number; last_used: number; expires: number }[];
  clients: { id: string; name: string; level: string; sites: string[] | '*'; last_used: number }[];
  activity: Activity[];
}

export interface ActionSpec {
  action: string;
  level: string;
  summary: string;
  confirm: boolean;
  write: boolean;
  required: string[];
  params: Record<string, string>;
}

export interface ToolSpec {
  name: string;
  title: string;
  intro: string;
  actions: ActionSpec[];
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/admin/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-wpm-panel': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json()) as T & { ok?: boolean; error?: { message?: string } };
  if (!res.ok && !data) throw new Error(`HTTP ${res.status}`);

  return data;
}

export const api = {
  state: () => call<State>('state'),
  spec: () => call<ToolSpec[]>('spec'),
  activity: (limit = 100) => call<{ entries: Activity[] }>(`activity?limit=${limit}`),
  post: <T = { ok: boolean; error?: { message: string } }>(path: string, body: unknown = {}) => call<T>(path, body),
};

export const ago = (ts: number, lang: 'fa' | 'en'): string => {
  if (!ts) return lang === 'fa' ? 'هرگز' : 'never';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  const unit = (n: number, fa: string, en: string): string => (lang === 'fa' ? `${n.toLocaleString('fa')} ${fa} پیش` : `${n} ${en}${n === 1 ? '' : 's'} ago`);
  if (s < 60) return lang === 'fa' ? 'چند ثانیه پیش' : 'just now';
  if (s < 3600) return unit(Math.floor(s / 60), 'دقیقه', 'minute');
  if (s < 86400) return unit(Math.floor(s / 3600), 'ساعت', 'hour');
  return unit(Math.floor(s / 86400), 'روز', 'day');
};
