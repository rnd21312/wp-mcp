import { ActivityIcon, ArrowLeftRightIcon, GaugeIcon, GlobeIcon, KeyRoundIcon, SearchCheckIcon, WrenchIcon, type LucideIcon } from 'lucide-react';
import { PageTitle, StatusBadge } from '@/components/bits';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ago, type State } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

const Stat = ({ icon: Icon, label, value, hint }: { icon: LucideIcon; label: string; value: string | number; hint?: string }) => (
  <Card size="sm">
    <CardHeader>
      <CardDescription className="flex items-center gap-2">
        <Icon className="size-4" /> {label}
      </CardDescription>
      <CardTitle className="text-3xl">{value}</CardTitle>
      {hint && <CardDescription>{hint}</CardDescription>}
    </CardHeader>
  </Card>
);

export function Overview({ state, go }: { state: State; go: (hash: string) => void }) {
  const { t, lang } = useI18n();
  const healthy = state.sites.filter((s) => s.status === 'ok').length;
  const first = state.sites[0]?.name ?? '';
  const quick: { icon: LucideIcon; title: string; text: string; hash: string }[] = [
    { icon: GaugeIcon, title: t('Site health', 'سلامت سایت'), text: t('Versions, Site Health tests, pending updates.', 'نسخه‌ها، آزمون‌های سلامت و به‌روزرسانی‌های منتظر.'), hash: `#/workbench?tool=maintain&action=health&level=draft&site=${first}` },
    { icon: SearchCheckIcon, title: t('SEO audit of the home page', 'ممیزی سئوی صفحه‌ی اصلی'), text: t('Title, description, headings, images, schema.', 'عنوان، توضیحات، سرتیترها، تصاویر و داده‌ی ساختاریافته.'), hash: `#/workbench?tool=seo&action=audit&level=read&site=${first}&arg_path=/` },
    { icon: WrenchIcon, title: t('Check for updates', 'بررسی به‌روزرسانی‌ها'), text: t('Core, plugins and themes.', 'هسته، افزونه‌ها و پوسته‌ها.'), hash: `#/workbench?tool=maintain&action=updates_check&level=draft&site=${first}` },
    { icon: ArrowLeftRightIcon, title: t('Copy content between sites', 'کپی محتوا بین سایت‌ها'), text: t('Pages, posts, menus, design. Drafts first.', 'برگه‌ها، نوشته‌ها، منو و طراحی. اول پیش‌نویس.'), hash: '#/workbench?tool=site&action=transfer&level=draft' },
  ];

  return (
    <>
      <PageTitle title={t('Overview', 'نمای کلی')} hint={t('Everything the AI can reach, and what it did lately.', 'هرچه هوش مصنوعی به آن دسترسی دارد و کارهایی که اخیراً کرده.')} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat icon={GlobeIcon} label={t('Sites', 'سایت‌ها')} value={state.sites.length} hint={`${healthy} ${t('healthy', 'سالم')}`} />
        <Stat icon={KeyRoundIcon} label={t('API keys', 'کلیدهای API')} value={state.keys.length} />
        <Stat icon={ActivityIcon} label={t('Connected apps', 'برنامه‌های متصل')} value={state.clients.length} />
        <Stat icon={GaugeIcon} label={t('Actions', 'عملیات')} value={123} hint={t('16 tools', '۱۶ ابزار')} />
      </div>

      {state.sites.length === 0 && (
        <Card className="mt-6 border-dashed">
          <CardHeader>
            <CardTitle>{t('Start here', 'از اینجا شروع کنید')}</CardTitle>
            <CardDescription>{t('1) Install the WP MCP Bridge plugin on your site. 2) In WordPress: Tools → WP MCP Bridge → Create pairing code. 3) Connect the site here.', '۱) افزونه‌ی WP MCP Bridge را روی سایت نصب کنید. ۲) در وردپرس: ابزارها ← WP MCP Bridge ← ساخت کد جفت‌سازی. ۳) سایت را اینجا وصل کنید.')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => go('#/sites')}>{t('Connect a site', 'اتصال سایت')}</Button>
          </CardContent>
        </Card>
      )}

      <h2 className="mt-8 mb-3 text-lg font-semibold">{t('Quick actions', 'کارهای سریع')}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {quick.map((q) => (
          <button key={q.title} className="text-start" onClick={() => go(q.hash)}>
            <Card className="h-full transition-colors hover:bg-muted/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <q.icon className="size-4 text-primary" /> {q.title}
                </CardTitle>
                <CardDescription>{q.text}</CardDescription>
              </CardHeader>
            </Card>
          </button>
        ))}
      </div>

      <h2 className="mt-8 mb-3 text-lg font-semibold">{t('Recent activity', 'فعالیت‌های اخیر')}</h2>
      <Card>
        <CardContent className="divide-y p-0">
          {state.activity.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">{t('Nothing yet.', 'هنوز چیزی نیست.')}</p>}
          {state.activity.slice(0, 8).map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <div className="min-w-0">
                <span dir="ltr" className="font-mono text-xs">{a.tool}.{a.action}</span>
                <span className="mx-2 text-muted-foreground">·</span>
                <span className="text-muted-foreground">{a.site || '—'}</span>
                <p className="truncate text-xs text-muted-foreground">{a.summary}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <StatusBadge status={a.status} />
                <span className="hidden text-xs text-muted-foreground sm:inline">{ago(a.ts, lang)}</span>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
