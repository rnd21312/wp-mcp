/** Persian labels for the owner panel. Applied to visible text nodes only (">text<"), never to values or code. */
const DICT: Record<string, string> = {
  'Dashboard': 'داشبورد',
  'Workbench': 'میز کار',
  'Connect AI': 'اتصال هوش مصنوعی',
  'Activity': 'فعالیت‌ها',
  'WP MCP gateway': 'مدیریت WP MCP',
  'Sign out': 'خروج',
  'Sign in': 'ورود',
  'Owner password': 'رمز مالک',
  'MCP endpoint': 'آدرس MCP',
  'Sites': 'سایت‌ها',
  'Site': 'سایت',
  'Status': 'وضعیت',
  'Ceiling': 'سقف سطح',
  'Test': 'آزمایش',
  'Remove': 'حذف',
  'Set': 'ثبت',
  'No sites connected.': 'هنوز سایتی وصل نشده است.',
  'Connect a site': 'اتصال یک سایت',
  'Site URL': 'آدرس سایت',
  'Pairing code': 'کد جفت‌سازی',
  'Unique name (optional, default: domain)': 'نام یکتا (اختیاری، پیش‌فرض: دامنه)',
  'Highest level allowed on this site': 'بالاترین سطح مجاز روی این سایت',
  'Connect': 'اتصال',
  'API keys': 'کلیدهای API',
  'Key': 'کلید',
  'Level': 'سطح',
  'Used': 'آخرین استفاده',
  'Revoke': 'ابطال',
  'No keys.': 'کلیدی نیست.',
  'Create a key': 'ساخت کلید',
  'Name': 'نام',
  'Sites (none ticked = all)': 'سایت‌ها (هیچ‌کدام = همه)',
  'Expires after days (0 = never)': 'انقضا بعد از چند روز (۰ = بدون انقضا)',
  'Create key': 'ساخت کلید',
  'Connected apps (OAuth)': 'برنامه‌های متصل (OAuth)',
  'App': 'برنامه',
  'Last used': 'آخرین استفاده',
  'Disconnect': 'قطع اتصال',
  'None.': 'هیچ.',
  'Nothing yet.': 'هنوز چیزی نیست.',
  'First-time setup': 'راه‌اندازی اولیه',
  'Setup token': 'توکن راه‌اندازی',
  'Create owner': 'ساخت مالک',
  'Run': 'اجرا',
  'Result': 'نتیجه',
  'Tool': 'ابزار',
  'Action': 'عملیات',
  'Run as level': 'اجرا با سطح',
  'Arguments (JSON, filled from the fields above; you can edit it)': 'آرگومان‌ها (JSON؛ از فیلدهای بالا پر می‌شود و قابل ویرایش است)',
  'Dry run (preview only, for write actions)': 'اجرای آزمایشی (فقط پیش‌نمایش، برای عملیات نوشتن)',
  'Confirm and run': 'تأیید و اجرا',
  'Connect an AI app': 'اتصال یک برنامه‌ی هوش مصنوعی',
  'Claude Code on this computer (no server needed)': 'Claude Code روی همین کامپیوتر (بدون سرور)',
  'Claude Desktop (claude_desktop_config.json)': 'Claude Desktop (فایل claude_desktop_config.json)',
  'Over the network (Claude.ai, Cursor, other computers)': 'از راه شبکه (Claude.ai، Cursor، کامپیوترهای دیگر)',
  'When (UTC)': 'زمان (UTC)',
  'Who': 'چه کسی',
  'Result ': 'نتیجه ',
  'Details': 'جزئیات',
};

const BLURBS: [string, string][] = [
  ['Run any tool action by hand with the same safety rules the AI has: levels, site ceilings, previews and confirmations. Useful for trying things and for tasks you do not want to explain to an AI.', 'هر عملیات ابزار را دستی و با همان قواعد ایمنی هوش مصنوعی اجرا کنید: سطح‌ها، سقف سایت، پیش‌نمایش و تأیید. برای آزمایش و کارهایی که نمی‌خواهید به هوش مصنوعی توضیح دهید.'],
  ['Everything here is filled in for this installation. Create an API key on the Dashboard if a client needs one.', 'همه‌چیز برای همین نصب پر شده است. اگر کلاینتی کلید می‌خواهد، در داشبورد کلید API بسازید.'],
  ['Change WPMCP_STDIO_LEVEL to live when you want it to publish, admin only for maintenance.', 'برای انتشار WPMCP_STDIO_LEVEL را live کنید؛ admin فقط برای نگهداری.'],
  ['In WordPress: Tools → WP MCP Bridge → create a pairing code (valid 15 minutes).', 'در وردپرس: ابزارها ← WP MCP Bridge ← ساخت کد جفت‌سازی (۱۵ دقیقه اعتبار).'],
];

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function translate(html: string): string {
  let out = html.replace('<html lang="en" dir="ltr">', '<html lang="fa" dir="rtl">');
  for (const [en, fa] of BLURBS) out = out.split(en).join(fa);
  for (const [en, fa] of Object.entries(DICT).sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`>(\\s*)${esc(en)}(\\s*)<`, 'g'), `>$1${fa}$2<`);
    out = out.replace(new RegExp(`(<label[^>]*>)${esc(en)}<`, 'g'), `$1${fa}<`);
  }

  return out;
}
