// Generates docs/TOOLS.md and docs/fa/TOOLS.md from spec/ops.json so the reference can never drift from the code.
// The action summaries come from the spec and stay in English in both files; headings and explanations are translated.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(root, 'spec', 'ops.json'), 'utf8'));

const titles = {
  site: ['Site overview and connections', 'نمای کلی سایت و اتصال‌ها'],
  content: ['Posts, pages, terms, comments', 'نوشته، برگه، دسته و برچسب، نظر'],
  design: ['Design: templates, CSS, tokens, menus, themes', 'طراحی: قالب‌ها، CSS، توکن‌ها، منو، پوسته‌ها'],
  builder: ['Page builders (Elementor, Bricks, …)', 'صفحه‌سازها (Elementor، Bricks، …)'],
  fields: ['Custom fields (ACF, Meta Box)', 'فیلدهای سفارشی (ACF، Meta Box)'],
  media: ['Media library', 'کتابخانه‌ی رسانه'],
  seo: ['SEO', 'سئو'],
  inspect: ['Inspect rendered pages', 'بازرسی صفحه‌های رندرشده'],
  maintain: ['Maintenance', 'نگهداری'],
  plugins: ['Plugins', 'افزونه‌ها'],
  users: ['Users', 'کاربران'],
  options: ['Site options', 'گزینه‌های سایت'],
  rest: ['Generic REST layer', 'لایه‌ی عمومی REST'],
  shop: ['WooCommerce', 'ووکامرس'],
  forms: ['Forms', 'فرم‌ها'],
  files: ['Files in wp-content', 'فایل‌های wp-content'],
  snippets: ['Code Snippets plugin', 'افزونه‌ی Code Snippets'],
  transfer: ['Export and import content', 'برون‌بری و درون‌ریزی محتوا'],
  activity: ['Activity and undo', 'فعالیت و بازگردانی'],
};
const local = {
  site: [
    [
      'transfer',
      'draft>live',
      'Copy content between two sites through the gateway (resumable, drafts by default).',
      'from*, to*, kinds, prefixes, post_type, ids, page, pages, id_map, overwrite, publish',
    ],
    ['transfer_files', 'admin', 'Copy files between two sites (confirm).', 'from*, to*, root*, path, skip_existing'],
    [
      'build',
      'live>admin',
      'Build or extend a whole site from one JSON map: plugins, theme, tokens, pages, menu, home page, branding, options (dry_run, one confirmation, resumable).',
      'map*, from_step, page_ids',
    ],
    ['sites', 'read', 'Every site you can use: name, URL, status, your effective level.', ''],
    ['whoami', 'read', 'Who you are connected as: level and where it is set, per-site caps, rate limits, gateway version.', ''],
    ['describe', 'read', 'Full parameter schema of one action (or all actions of one tool).', 'tool*, action'],
  ],
  activity: [['log', 'read', 'Gateway log of calls made by AI clients.', 'limit, mine']],
};

const TEXT = {
  en: {
    h1: 'Tools reference',
    intro: (n) =>
      `Generated from \`spec/ops.json\` (${n} site actions + gateway actions). Every tool is called as \`{site, action, args, dry_run?, confirm_token?, idempotency_key?}\`.`,
    levels:
      'Levels: **read** < **draft** < **live** < **admin**. `A>B` means the action starts at A and the site raises it to B from the real target (for example editing a published page). **confirm** = two-step: the first call returns a preview and a `confirm_token`, nothing changes until it is repeated with the token. **site content** = the result contains text written on the website (treated as untrusted).',
    cols: '| Action | Level | Arguments (* required) | What it does |\n|---|---|---|---|\n',
    gateway: 'gateway',
    flag: { maybe: 'confirm if risky', confirm: 'confirm', write: 'write', untrusted: 'site content' },
    file: 'docs/TOOLS.md',
  },
  fa: {
    h1: 'مرجع ابزارها',
    intro: (n) =>
      `تولیدشده از \`spec/ops.json\` (${n} عملیات سایت + عملیات gateway). هر ابزار به این شکل صدا زده می‌شود: \`{site, action, args, dry_run?, confirm_token?, idempotency_key?}\`. شرح عملیات از خود spec می‌آید و انگلیسی می‌ماند.`,
    levels:
      'سطح‌ها: **read** < **draft** < **live** < **admin**. `A>B` یعنی عملیات از سطح A شروع می‌شود و سایت بر اساس هدف واقعی آن را به B بالا می‌برد (مثلاً ویرایش برگه‌ی منتشرشده). **confirm** = دومرحله‌ای: فراخوانی اول پیش‌نمایش و `confirm_token` می‌دهد و تا تکرار با توکن چیزی تغییر نمی‌کند. **site content** = نتیجه شامل متنی است که روی سایت نوشته شده (نامطمئن حساب می‌شود).',
    cols: '| عملیات | سطح | آرگومان‌ها (* الزامی) | کار |\n|---|---|---|---|\n',
    gateway: 'gateway',
    flag: { maybe: 'confirm در صورت ریسک', confirm: 'confirm', write: 'write', untrusted: 'site content' },
    file: 'docs/fa/TOOLS.md',
  },
};

for (const [lang, T] of Object.entries(TEXT)) {
  const i = lang === 'en' ? 0 : 1;
  let out = `# ${T.h1}\n\n${T.intro(spec.ops.length)}\n\n${T.levels}\n\n`;
  for (const [tool, names] of Object.entries(titles)) {
    out += `## ${tool}: ${names[i]}\n\n${T.cols}`;
    for (const [action, level, summary, args] of local[tool] ?? [])
      out += `| \`${action}\` | ${level} | ${args ? '`' + args + '`' : ''} | ${summary} *(${T.gateway})* |\n`;
    for (const op of spec.ops.filter((o) => o.tool === tool)) {
      const args = Object.keys(op.params)
        .map((n) => (op.required.includes(n) ? n + '*' : n))
        .join(', ');
      const flags = [
        op.confirm ? (op.confirm === 'maybe' ? T.flag.maybe : T.flag.confirm) : '',
        op.write ? T.flag.write : '',
        op.untrusted ? T.flag.untrusted : '',
      ].filter(Boolean);
      out += `| \`${op.action}\` | ${op.level}${op.escalates ? '>' + op.escalates : ''} | ${args ? '`' + args + '`' : ''} | ${op.summary}${flags.length ? ' *(' + flags.join(', ') + ')*' : ''} |\n`;
    }
    out += '\n';
  }
  writeFileSync(join(root, T.file), out);
  console.log(`${T.file} written`);
}
