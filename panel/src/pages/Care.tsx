import { DatabaseBackupIcon, DownloadIcon, PowerIcon, RefreshCwIcon, SearchIcon, Trash2Icon, WrenchIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Empty, PageTitle } from '@/components/bits';
import { Loading, plain } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useI18n } from '@/lib/i18n';
import { useAction, useSite } from '@/lib/site';

function Health() {
  const { t } = useI18n();
  const { run } = useSite();
  const h = useAction<any>('maintain', 'health');
  const u = useAction<any>('maintain', 'updates_check');
  const [busy, setBusy] = useState('');
  const update = async (type: string, slug?: string): Promise<void> => {
    setBusy(`${type}${slug}`);
    const r = await run('maintain', 'update', { type, ...(slug ? { slug } : {}) });
    setBusy('');
    if (r.ok) { u.reload(); h.reload(); }
  };
  const d = h.data;
  const pending = u.data ? [...(u.data.core ?? []).map((c: any) => ({ type: 'core', name: 'WordPress', from: u.data.current_wordpress, to: c.version })), ...(u.data.plugins ?? []).map((p: any) => ({ type: 'plugin', slug: p.plugin, name: p.name, from: p.from, to: p.to })), ...(u.data.themes ?? []).map((p: any) => ({ type: 'theme', slug: p.theme, name: p.name, from: p.from, to: p.to }))] : [];

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>{t('Health', 'سلامت')}</CardTitle><CardDescription>{d ? `WordPress ${d.versions?.wordpress} · PHP ${d.versions?.php} · MySQL ${d.versions?.mysql}` : ''}</CardDescription></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {h.loading && !d ? <Loading /> : h.error ? <Empty>{h.error}</Empty> : d && (
            <>
              {d.problems.length === 0 ? <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" variant="secondary">{t('All checks pass', 'همه‌ی بررسی‌ها موفق')}</Badge> : d.problems.map((p: any, i: number) => (
                <div key={i} className="rounded-lg border p-3"><div className="flex items-center gap-2"><Badge variant="secondary" className={p.status === 'critical' ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'}>{p.status}</Badge><b>{plain(p.test)}</b></div><p className="mt-1 text-muted-foreground">{plain(p.detail)}</p></div>
              ))}
              <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                <span>HTTPS: {d.runtime?.https ? '✓' : '✗'}</span><span>{t('Memory', 'حافظه')}: {d.runtime?.memory_limit}</span>
                <span>{t('Free disk', 'فضای آزاد')}: {d.runtime?.disk_free}</span><span>{t('Debug mode', 'حالت اشکال‌زدایی')}: {d.runtime?.wp_debug ? t('on', 'روشن') : t('off', 'خاموش')}</span>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('Updates', 'به‌روزرسانی‌ها')}</CardTitle><CardDescription>{t('A database backup is taken before each update.', 'پیش از هر به‌روزرسانی از دیتابیس بکاپ گرفته می‌شود.')}</CardDescription></CardHeader>
        <CardContent className="space-y-2">
          <Button variant="outline" size="sm" onClick={async () => { await run('maintain', 'updates_check', { refresh: true }, { quiet: true }); u.reload(); }}><RefreshCwIcon /> {t('Check now', 'بررسی')}</Button>
          {u.loading && !u.data ? <Loading /> : pending.length === 0 ? <Empty>{t('Everything is up to date.', 'همه‌چیز به‌روز است.')}</Empty> : pending.map((p) => (
            <div key={p.type + p.slug} className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm">
              <div className="min-w-0 flex-1"><div className="truncate font-medium">{p.name}</div><div dir="ltr" className="text-start text-xs text-muted-foreground">{p.from} → {p.to}</div></div>
              <Badge variant="outline">{p.type}</Badge>
              <Button size="sm" disabled={!!busy} onClick={() => update(p.type, p.slug)}>{busy === `${p.type}${p.slug}` ? '…' : t('Update', 'به‌روزرسانی')}</Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Backups() {
  const { t } = useI18n();
  const { run } = useSite();
  const b = useAction<any>('maintain', 'backup_list');
  const [busy, setBusy] = useState(false);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between"><div><CardTitle>{t('Database backups', 'بکاپ دیتابیس')}</CardTitle><CardDescription>{t('Stored on the site. Files (uploads, themes) are not included; ask your host for file backups.', 'روی خود سایت ذخیره می‌شود. فایل‌ها (آپلودها، پوسته‌ها) شامل نیست؛ بکاپ فایل را از هاست بخواهید.')}</CardDescription></div>
        <Button disabled={busy} onClick={async () => { setBusy(true); const r = await run('maintain', 'backup_create', { label: 'from panel' }); setBusy(false); if (r.ok) b.reload(); }}><DatabaseBackupIcon /> {busy ? '…' : t('Back up now', 'بکاپ بگیر')}</Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {b.loading && !b.data ? <Loading /> : (b.data?.backups ?? []).length === 0 ? <Empty>{t('No backups yet.', 'هنوز بکاپی نیست.')}</Empty> : (b.data.backups as any[]).map((x) => (
          <div key={x.id} className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm">
            <div className="min-w-0 flex-1"><div className="truncate">{x.label}</div><div dir="ltr" className="text-start text-xs text-muted-foreground">{x.created} · {x.size}</div></div>
            <Button variant="outline" size="sm" onClick={async () => { if ((await run('maintain', 'backup_restore', { id: x.id })).ok) { toast.success(t('Restored', 'بازگردانی شد')); b.reload(); } }}><DownloadIcon /> {t('Restore', 'بازگردانی')}</Button>
            <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={async () => { if ((await run('maintain', 'backup_delete', { id: x.id })).ok) b.reload(); }}><Trash2Icon /></Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Tools() {
  const { t } = useI18n();
  const { run, overview } = useSite();
  const [mode, setMode] = useState<boolean | null>(null);
  const [msg, setMsg] = useState('');
  const db = useAction<any>('maintain', 'db_info');
  const on = mode ?? !!overview?.maintenance_mode;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>{t('Quick tools', 'ابزارهای سریع')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" className="w-full justify-start" onClick={async () => { const r = await run<any>('maintain', 'cache_flush', {}, { quiet: true }); if (r.ok) toast.success(`${t('Cleared', 'پاک شد')}: ${r.data.flushed.join('، ')}`); }}><WrenchIcon /> {t('Clear all caches', 'پاک‌کردن همه‌ی کش‌ها')}</Button>
          <div className="rounded-lg border p-3">
            <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-sm font-medium"><PowerIcon className="size-4" /> {t('Maintenance mode', 'حالت تعمیر')}</span>
              <Switch checked={on} onCheckedChange={async (v) => { if ((await run('maintain', 'maintenance_mode', { enabled: v, message: msg || undefined })).ok) setMode(v); }} /></div>
            <p className="mt-2 text-xs text-muted-foreground">{t('Visitors see a "back soon" page (503). You and the panel still see the site.', 'بازدیدکنندگان صفحه‌ی «به‌زودی برمی‌گردیم» (۵۰۳) می‌بینند. شما و پنل سایت را می‌بینید.')}</p>
            <Input className="mt-2" placeholder={t('Message for visitors (optional)', 'پیام برای بازدیدکنندگان (اختیاری)')} value={msg} onChange={(e) => setMsg(e.target.value)} />
          </div>
          <Button variant="outline" className="w-full justify-start" onClick={async () => { const r = await run('maintain', 'db_cleanup', { targets: ['revisions', 'transients', 'spam', 'auto_drafts', 'orphan_meta'] }); if (r.ok) db.reload(); }}><Trash2Icon /> {t('Clean the database (revisions, spam, temp data)', 'پاکسازی دیتابیس (نسخه‌ها، اسپم، داده‌ی موقت)')}</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('Database', 'دیتابیس')}</CardTitle><CardDescription>{db.data ? `${t('Total', 'جمع')}: ${db.data.total_size} · autoload ${db.data.autoload?.size}` : ''}</CardDescription></CardHeader>
        <CardContent className="space-y-1 text-sm">
          {db.loading && !db.data ? <Loading /> : db.data && (
            <>
              {Object.entries<number>(db.data.cleanable).map(([k, v]) => <div key={k} className="flex justify-between"><span className="text-muted-foreground">{k.replace(/_/g, ' ')}</span><span>{v}</span></div>)}
              <div className="pt-2 text-xs text-muted-foreground">{(db.data.tables as any[]).slice(0, 5).map((x) => `${x.table} (${x.size})`).join(' · ')}</div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Logs() {
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const logs = useAction<any>('maintain', 'logs', { lines: 100, contains: q });

  return (
    <Card>
      <CardHeader><CardTitle>{t('Error log', 'لاگ خطا')}</CardTitle><CardDescription>{t('Newest first, repeated messages grouped.', 'جدیدترین‌ها اول، پیام‌های تکراری گروه‌بندی شده.')}</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setQ(filter); }}><Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('Filter…', 'فیلتر…')} className="max-w-xs" /><Button variant="outline" size="icon"><SearchIcon /></Button></form>
        {logs.loading && !logs.data ? <Loading /> : logs.data?.note && !(logs.data.entries ?? []).length ? <Empty>{logs.data.note}</Empty> : (
          <div dir="ltr" className="max-h-[28rem] divide-y overflow-auto rounded-lg border font-mono text-xs">
            {(logs.data?.entries ?? []).map((e: any, i: number) => <div key={i} className="px-3 py-2"><span className="text-muted-foreground">{e.last}</span>{e.count > 1 && <Badge className="mx-2" variant="secondary">×{e.count}</Badge>}<div className="break-words">{e.message}</div></div>)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Maintenance() {
  const { t } = useI18n();

  return (
    <>
      <PageTitle title={t('Maintenance', 'نگهداری')} hint={t('Keep the site healthy: updates, backups, caches, errors.', 'سایت را سالم نگه دارید: به‌روزرسانی، بکاپ، کش، خطاها.')} />
      <Tabs defaultValue="health">
        <TabsList><TabsTrigger value="health">{t('Health & updates', 'سلامت و به‌روزرسانی')}</TabsTrigger><TabsTrigger value="backups">{t('Backups', 'بکاپ')}</TabsTrigger><TabsTrigger value="tools">{t('Tools', 'ابزارها')}</TabsTrigger><TabsTrigger value="logs">{t('Logs', 'لاگ‌ها')}</TabsTrigger></TabsList>
        <TabsContent value="health" className="mt-4"><Health /></TabsContent>
        <TabsContent value="backups" className="mt-4"><Backups /></TabsContent>
        <TabsContent value="tools" className="mt-4"><Tools /></TabsContent>
        <TabsContent value="logs" className="mt-4"><Logs /></TabsContent>
      </Tabs>
    </>
  );
}

export function Plugins() {
  const { t } = useI18n();
  const { run } = useSite();
  const list = useAction<any>('plugins', 'list');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[] | null>(null);
  const items: any[] = list.data?.plugins ?? [];

  return (
    <>
      <PageTitle title={t('Plugins', 'افزونه‌ها')} hint={t('Turn plugins on and off, update them, or find new ones.', 'افزونه‌ها را روشن و خاموش کنید، به‌روز کنید یا افزونه‌ی جدید پیدا کنید.')} />
      <Card>
        <CardContent className="divide-y p-0">
          {list.loading && !list.data ? <Loading /> : items.map((p) => (
            <div key={p.plugin} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1"><div className="truncate font-medium">{p.name} <span dir="ltr" className="text-xs text-muted-foreground">{p.version}</span></div><div className="truncate text-xs text-muted-foreground">{p.description}</div></div>
              {p.update && <Badge variant="secondary" className="bg-amber-500/15 text-amber-700 dark:text-amber-300">{t('update', 'به‌روزرسانی')} {p.update}</Badge>}
              {p.plugin.startsWith('wp-mcp-bridge/') ? <Badge variant="outline">{t('this bridge', 'همین پل')}</Badge> : <Switch checked={p.active} onCheckedChange={async (v) => { if ((await run('plugins', v ? 'activate' : 'deactivate', { plugin: p.plugin })).ok) list.reload(); }} />}
              {!p.active && !p.plugin.startsWith('wp-mcp-bridge/') && <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={async () => { if ((await run('plugins', 'delete', { plugin: p.plugin })).ok) list.reload(); }}><Trash2Icon /></Button>}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader><CardTitle>{t('Find a plugin', 'یافتن افزونه')}</CardTitle><CardDescription>{t('Searches WordPress.org. Installing asks for confirmation.', 'در WordPress.org جستجو می‌کند. نصب تأیید می‌خواهد.')}</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); const r = await run<any>('plugins', 'search', { query: q, per_page: 8 }, { quiet: true }); if (r.ok) setResults(r.data.results); }}>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="woocommerce, seo, backup…" className="max-w-sm" dir="ltr" />
            <Button><SearchIcon /> {t('Search', 'جستجو')}</Button>
          </form>
          {results?.map((r) => (
            <div key={r.slug} className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm">
              <div className="min-w-0 flex-1"><div className="font-medium">{r.name}</div><div className="truncate text-xs text-muted-foreground">{r.description}</div></div>
              <Badge variant="outline">{(r.active_installs ?? 0).toLocaleString()}+</Badge>
              <Button size="sm" onClick={async () => { if ((await run('plugins', 'install', { slug: r.slug, activate: false })).ok) list.reload(); }}>{t('Install', 'نصب')}</Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
