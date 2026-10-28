// Generates docs/TOOLS.md from spec/ops.json so the reference can never drift from the code.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(root, 'spec', 'ops.json'), 'utf8'));

const titles = {
  site: 'Site overview and connections', content: 'Posts, pages, terms, comments', design: 'Design: templates, CSS, tokens, menus, themes', media: 'Media library', seo: 'SEO',
  inspect: 'Inspect rendered pages', maintain: 'Maintenance', plugins: 'Plugins', users: 'Users', options: 'Site options', rest: 'Generic REST layer', shop: 'WooCommerce', forms: 'Forms', files: 'Files in wp-content', transfer: 'Export and import content', activity: 'Activity and undo',
};
const local = {
  site: [['transfer', 'draft>live', 'Copy content between two sites through the gateway (resumable, drafts by default).', 'from*, to*, kinds, post_type, ids, page, pages, id_map, overwrite, publish'], ['transfer_files', 'admin', 'Copy files between two sites (confirm).', 'from*, to*, root*, path, skip_existing'], ['sites', 'read', 'Every site you can use: name, URL, status, your effective level.', ''], ['whoami', 'read', 'Who you are connected as: level, sites, rate limits.', ''], ['describe', 'read', 'Full parameter schema of one action (or all actions of one tool).', 'tool*, action']],
  activity: [['log', 'read', 'Gateway log of calls made by AI clients.', 'limit, mine']],
};

let out = '# Tools reference\n\nGenerated from `spec/ops.json` (' + spec.ops.length + ' site actions + gateway actions). Every tool is called as `{site, action, args, dry_run?, confirm_token?, idempotency_key?}`.\n\n';
out += 'Levels: **read** < **draft** < **live** < **admin**. `A>B` means the action starts at A and the site raises it to B from the real target (for example editing a published page). **confirm** = two-step: the first call returns a preview and a `confirm_token`, nothing changes until it is repeated with the token. **site content** = the result contains text written on the website (treated as untrusted).\n\n';
for (const [tool, title] of Object.entries(titles)) {
  out += `## ${tool}: ${title}\n\n| Action | Level | Arguments (* required) | What it does |\n|---|---|---|---|\n`;
  for (const [action, level, summary, args] of local[tool] ?? []) out += `| \`${action}\` | ${level} | ${args ? '`' + args + '`' : ''} | ${summary} *(gateway)* |\n`;
  for (const op of spec.ops.filter((o) => o.tool === tool)) {
    const args = Object.keys(op.params).map((n) => (op.required.includes(n) ? n + '*' : n)).join(', ');
    const flags = [op.confirm ? (op.confirm === 'maybe' ? 'confirm if risky' : 'confirm') : '', op.write ? 'write' : '', op.untrusted ? 'site content' : ''].filter(Boolean);
    out += `| \`${op.action}\` | ${op.level}${op.escalates ? '>' + op.escalates : ''} | ${args ? '`' + args + '`' : ''} | ${op.summary}${flags.length ? ' *(' + flags.join(', ') + ')*' : ''} |\n`;
  }
  out += '\n';
}
writeFileSync(join(root, 'docs', 'TOOLS.md'), out);
console.log('docs/TOOLS.md written');
