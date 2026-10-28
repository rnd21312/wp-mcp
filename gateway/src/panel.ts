import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from './auth.ts';
import type { App, Reply } from './context.ts';
import { esc, page, securityHeaders } from './html.ts';
import { isLevel, LEVELS } from './levels.ts';
import { callTool } from './mcp/tools.ts';
import { OPS, TOOLS } from './registry.ts';
import { checkCsrf, csrfToken, type Session } from './session.ts';

export interface PanelReq {
  method: string;
  path: string;
  query: URLSearchParams;
  form: URLSearchParams;
}

const NAV = '<nav><a href="/admin">Dashboard</a><a href="/admin/workbench">Workbench</a><a href="/admin/connect">Connect AI</a><a href="/admin/activity">Activity</a><a href="/admin/lang?l=fa">فارسی</a> <a href="/admin/lang?l=en">English</a></nav>';

/** What the browser needs to build argument forms: tools, actions, parameters. No secrets. */
function specJson(): string {
  const out = TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    actions: Object.values(OPS)
      .filter((o) => o.tool === t.name)
      .map((o) => ({ action: o.action, level: o.level, summary: o.summary, confirm: !!o.confirm, write: o.write, required: o.required, params: o.params })),
  }));
  return JSON.stringify(out).replace(/</g, '\\u003c');
}

const SCRIPT = `
const spec = JSON.parse(document.getElementById('spec').textContent);
const $ = (id) => document.getElementById(id);
const tool = $('tool'), action = $('action'), fields = $('fields'), args = $('args'), summary = $('summary');
const q = new URLSearchParams(location.search);
tool.innerHTML = spec.map((t) => '<option value="' + t.name + '">' + t.name + ' - ' + t.title + '</option>').join('');
const cur = () => spec.find((t) => t.name === tool.value);
function fillActions() {
  action.innerHTML = cur().actions.map((a) => '<option value="' + a.action + '">' + a.action + ' [' + a.level + (a.confirm ? ', confirm' : '') + ']</option>').join('');
  fillFields();
}
function fillFields() {
  const a = cur().actions.find((x) => x.action === action.value);
  summary.textContent = a.summary;
  fields.innerHTML = '';
  for (const [name, def] of Object.entries(a.params)) {
    const bar = def.indexOf('|');
    const type = bar < 0 ? def : def.slice(0, bar);
    const desc = bar < 0 ? '' : def.slice(bar + 1);
    const row = document.createElement('div');
    const label = document.createElement('label');
    label.textContent = name + (a.required.includes(name) ? ' *' : '') + (desc ? ' - ' + desc : '');
    let input;
    if (type.startsWith('enum:')) {
      input = document.createElement('select');
      input.innerHTML = '<option value=""></option>' + type.slice(5).split(',').map((v) => '<option>' + v + '</option>').join('');
    } else if (type === 'bool') {
      input = document.createElement('select');
      input.innerHTML = '<option value=""></option><option>true</option><option>false</option>';
    } else if (type === 'object' || type === 'array' || type === 'any') {
      input = document.createElement('textarea');
      input.rows = 3;
      input.placeholder = type === 'array' ? '["a","b"]' : type === 'object' ? '{"key":"value"}' : 'value or JSON';
    } else {
      input = document.createElement('input');
      input.type = type === 'int' ? 'number' : 'text';
    }
    input.dataset.name = name;
    input.dataset.type = type;
    input.addEventListener('input', build);
    row.append(label, input);
    fields.append(row);
    if (q.get('arg_' + name)) input.value = q.get('arg_' + name);
  }
  build();
}
function build() {
  const out = {};
  for (const el of fields.querySelectorAll('[data-name]')) {
    const v = el.value.trim();
    if (v === '') continue;
    const t = el.dataset.type;
    try {
      out[el.dataset.name] = t === 'int' ? Number(v) : t === 'bool' ? v === 'true' : (t === 'object' || t === 'array' || t === 'any') ? JSON.parse(v) : v;
    } catch (e) { out[el.dataset.name] = v; }
  }
  args.value = JSON.stringify(out, null, 1);
}
tool.addEventListener('change', fillActions);
action.addEventListener('change', fillFields);
if (q.get('tool')) tool.value = q.get('tool');
fillActions();
if (q.get('action')) { action.value = q.get('action'); fillFields(); }
`;

const levelSelect = (current: string): string => `<select name="level">${LEVELS.map((l) => `<option ${l === current ? 'selected' : ''}>${l}</option>`).join('')}</select>`;

function workbench(app: App, session: Session, result = '', form: URLSearchParams = new URLSearchParams(), confirmToken = ''): Reply {
  const nonce = randomBytes(12).toString('base64url');
  const sites = app.store.sites();
  const siteOptions = ['', ...sites.map((s) => s.name)].map((n) => `<option value="${esc(n)}" ${form.get('site') === n ? 'selected' : ''}>${n ? esc(n) : '(single site / none)'}</option>`).join('');
  const csrf = `<input type="hidden" name="_csrf" value="${esc(csrfToken(app, session))}">`;
  const body = `
<h1>Workbench</h1>
<p class="muted">Run any tool action by hand with the same safety rules the AI has: levels, site ceilings, previews and confirmations. Useful for trying things and for tasks you do not want to explain to an AI.</p>
<form method="post" action="/admin/workbench/run" class="card">${csrf}
  <div class="row"><div style="flex:1;min-width:160px"><label>Site</label><select name="site">${siteOptions}</select></div>
  <div style="flex:1;min-width:160px"><label>Run as level</label>${levelSelect(form.get('level') ?? 'live')}</div></div>
  <label>Tool</label><select id="tool" name="tool"></select>
  <label>Action</label><select id="action" name="action"></select>
  <p class="muted" id="summary"></p>
  <div id="fields"></div>
  <label>Arguments (JSON, filled from the fields above; you can edit it)</label>
  <textarea id="args" name="args" rows="6" class="mono" style="width:100%">${esc(form.get('args') ?? '{}')}</textarea>
  <label class="radio"><input type="checkbox" name="dry_run" value="1" ${form.get('dry_run') ? 'checked' : ''}> Dry run (preview only, for write actions)</label>
  <input type="hidden" name="confirm_token" value="${esc(confirmToken)}">
  <div style="margin-top:14px"><button>Run</button></div>
</form>
${result}
<script type="application/json" id="spec">${specJson()}</script>`;
  return { status: 200, headers: securityHeaders(nonce), html: page('Workbench', body, NAV, 'en', SCRIPT, nonce) };
}

function renderResult(app: App, session: Session, text: string, form: URLSearchParams): string {
  let data: Record<string, any> | null = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain text */
  }
  const csrf = `<input type="hidden" name="_csrf" value="${esc(csrfToken(app, session))}">`;
  let confirm = '';
  if (data?.needs_confirmation && data.confirm_token) {
    const hidden = [...form.entries()].filter(([k]) => !['_csrf', 'confirm_token'].includes(k)).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
    confirm = `<div class="warn"><b>Confirmation needed.</b> Nothing has changed yet. Read the preview below. If it is what you want:</div>
<form method="post" action="/admin/workbench/run">${csrf}${hidden}<input type="hidden" name="confirm_token" value="${esc(data.confirm_token)}"><button class="danger">Confirm and run</button></form>`;
  }
  const status = data ? (data.ok === false ? 'bad' : 'ok') : 'muted';
  const shown = data ? JSON.stringify(data, null, 2) : text;
  return `<h2>Result</h2><div class="card">${confirm}<pre class="mono ${status}" style="white-space:pre-wrap;word-break:break-word;max-height:70vh;overflow:auto">${esc(shown.slice(0, 120000))}</pre></div>`;
}

function connectPage(app: App): Reply {
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), 'index.js');
  const url = `${app.config.publicUrl}/mcp`;
  const desktop = JSON.stringify({ mcpServers: { wp: { command: 'node', args: [entry.replace(/\\/g, '/'), 'stdio'], env: { WPMCP_DATA_DIR: app.config.dataDir.replace(/\\/g, '/'), WPMCP_STDIO_LEVEL: 'draft' } } } }, null, 2);
  const code = (s: string): string => `<pre class="mono card" style="white-space:pre-wrap;word-break:break-all">${esc(s)}</pre>`;
  const body = `
<h1>Connect an AI app</h1>
<p class="muted">Everything here is filled in for this installation. Create an API key on the Dashboard if a client needs one.</p>
<h2>Claude Code on this computer (no server needed)</h2>
${code(`claude mcp add wp -e WPMCP_DATA_DIR=${app.config.dataDir.replace(/\\/g, '/')} -e WPMCP_STDIO_LEVEL=draft -- node ${entry.replace(/\\/g, '/')} stdio`)}
<p class="muted">Change WPMCP_STDIO_LEVEL to live when you want it to publish, admin only for maintenance.</p>
<h2>Claude Desktop (claude_desktop_config.json)</h2>
${code(desktop)}
<h2>Over the network (Claude.ai, Cursor, other computers)</h2>
<p class="muted">Needs a public https address for this gateway (WPMCP_PUBLIC_URL). Current endpoint:</p>
${code(url)}
${code(`claude mcp add --transport http wp ${url} --header "Authorization: Bearer wpmk_YOUR_KEY"`)}
${code(JSON.stringify({ mcpServers: { wp: { url, headers: { Authorization: 'Bearer wpmk_YOUR_KEY' } } } }, null, 2))}
<p class="muted">Claude.ai: Settings, Connectors, Add custom connector, paste the endpoint, then approve here.</p>`;
  return { status: 200, headers: securityHeaders(), html: page('Connect AI', body, NAV) };
}

/** Pages added on top of the dashboard. Returns null for paths it does not own. */
export async function handlePanel(app: App, req: PanelReq, session: Session): Promise<Reply | null> {
  if (req.method === 'GET' && req.path === '/admin/workbench') return workbench(app, session, '', req.query);
  if (req.method === 'GET' && req.path === '/admin/connect') return connectPage(app);
  if (req.method === 'POST' && req.path === '/admin/workbench/run') {
    if (!checkCsrf(app, session, req.form.get('_csrf'))) return { status: 403, headers: securityHeaders(), html: page('Error', '<h1>Form expired</h1><p>Reload the page and try again.</p>', NAV) };
    const level = isLevel(req.form.get('level')) ? (req.form.get('level') as never) : 'read';
    const principal: Principal = { id: 'panel', kind: 'stdio', name: 'Admin panel', level, sites: '*' };
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(req.form.get('args') || '{}');
    } catch {
      return workbench(app, session, `<div class="warn">The arguments are not valid JSON.</div>`, req.form);
    }
    const result = await callTool(app, principal, req.form.get('tool') ?? '', {
      site: req.form.get('site') || undefined,
      action: req.form.get('action') ?? '',
      args: parsed,
      dry_run: req.form.get('dry_run') === '1',
      confirm_token: req.form.get('confirm_token') || undefined,
    });
    return workbench(app, session, renderResult(app, session, result.content[0].text, req.form), req.form);
  }

  return null;
}
