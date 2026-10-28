import { ArrowLeftRightIcon, FileCodeIcon, PlayIcon, SaveIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PageTitle, Pick } from '@/components/bits';
import { Field, Loading } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { useAction, useSite } from '@/lib/site';

/** Theme files through the design tools (available in every bridge version). */
function ThemeFiles() {
  const { t } = useI18n();
  const { run, overview } = useSite();
  const files = useAction<any>('design', 'theme_files');
  const [path, setPath] = useState('');
  const [text, setText] = useState('');
  const [orig, setOrig] = useState('');
  const [filter, setFilter] = useState('');
  const open = async (p: string): Promise<void> => {
    const r = await run<any>('design', 'theme_file_read', { path: p }, { quiet: true });
    if (r.ok) { setPath(p); setText(r.data.content); setOrig(r.data.content); }
  };
  const list: any[] = (files.data?.files ?? []).filter((f: any) => f.path.includes(filter));

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Card>
        <CardHeader><CardTitle className="text-base">{overview?.theme?.name ?? t('Theme', 'پوسته')}</CardTitle><Input dir="ltr" placeholder={t('Filter files…', 'فیلتر فایل‌ها…')} value={filter} onChange={(e) => setFilter(e.target.value)} /></CardHeader>
        <CardContent className="max-h-[32rem] space-y-0.5 overflow-auto p-2">
          {files.loading && !files.data ? <Loading /> : files.error ? <p className="p-3 text-sm text-muted-foreground">{files.error}</p> : list.map((f) => (
            <button dir="ltr" key={f.path} onClick={() => open(f.path)} className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-start text-xs hover:bg-muted ${f.path === path ? 'bg-muted' : ''}`}><span className="truncate">{f.path}</span><span className="text-muted-foreground">{f.bytes}</span></button>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle dir="ltr" className="flex items-center gap-2 text-start text-base"><FileCodeIcon className="size-4" />{path || t('Pick a file', 'یک فایل انتخاب کنید')}{text !== orig && <Badge variant="secondary">{t('modified', 'تغییر کرده')}</Badge>}</CardTitle><CardDescription>{t('PHP is syntax-checked; the front page is tested after saving and the change is reverted if the site breaks. Every save can be undone from Activity.', 'PHP بررسی نحوی می‌شود؛ بعد از ذخیره صفحه‌ی اول آزمایش می‌شود و اگر سایت خراب شود تغییر خودکار برمی‌گردد. هر ذخیره قابل بازگردانی است.')}</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <Textarea dir="ltr" rows={24} spellCheck={false} className="font-mono text-xs leading-relaxed" value={text} onChange={(e) => setText(e.target.value)} disabled={!path} />
          <Button disabled={!path || text === orig} onClick={async () => { if ((await run('design', 'theme_file_write', { path, content: text })).ok) setOrig(text); }}><SaveIcon /> {t('Save file', 'ذخیره فایل')}</Button>
        </CardContent>
      </Card>
    </div>
  );
}

function RestExplorer() {
  const { t } = useI18n();
  const { run } = useSite();
  const [ns, setNs] = useState('');
  const routes = useAction<any>('rest', 'routes', { namespace: ns });
  const [method, setMethod] = useState('GET');
  const [path, setPath] = useState('/wp/v2/posts');
  const [body, setBody] = useState('');
  const [out, setOut] = useState<any>(null);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>{t('Routes', 'مسیرها')}</CardTitle><CardDescription>{t('Every REST route of the site, including plugins like WooCommerce or form plugins.', 'همه‌ی مسیرهای REST سایت، از جمله افزونه‌هایی مثل ووکامرس یا فرم‌ساز.')}</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => setNs('')}><Badge variant={ns === '' ? 'default' : 'outline'}>{t('all', 'همه')}</Badge></button>
            {(routes.data?.namespaces ?? []).map((n: string) => <button key={n} onClick={() => setNs(n)}><Badge variant={ns === n ? 'default' : 'outline'}>{n}</Badge></button>)}
          </div>
          <div dir="ltr" className="max-h-96 divide-y overflow-auto rounded-lg border text-xs">
            {routes.loading && !routes.data ? <Loading /> : (routes.data?.routes ?? []).map((r: any) => (
              <button key={r.route} onClick={() => { setPath(r.route.replace(/\(\?P<[^>]+>[^)]*\)/g, '1')); setMethod(r.methods.includes('GET') ? 'GET' : r.methods[0]); }} className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-start hover:bg-muted"><span className="truncate">{r.route}</span><span className="shrink-0 text-muted-foreground">{r.methods.join(' ')}</span></button>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('Request', 'درخواست')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2"><div className="w-28"><Pick value={method} onChange={setMethod} options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m }))} /></div><Input dir="ltr" value={path} onChange={(e) => setPath(e.target.value)} className="font-mono text-xs" /></div>
          {method !== 'GET' && <Textarea dir="ltr" rows={5} className="font-mono text-xs" placeholder='{"title":"…"}' value={body} onChange={(e) => setBody(e.target.value)} />}
          <Button onClick={async () => { let parsed: unknown; try { parsed = body.trim() ? JSON.parse(body) : undefined; } catch { setOut({ error: 'Invalid JSON' }); return; } const r = await run('rest', 'call', { method, path, ...(parsed ? { body: parsed } : {}) }, { quiet: true }); setOut(r.ok ? r.data : r.error); }}><PlayIcon /> {t('Send', 'ارسال')}</Button>
          {out && <pre dir="ltr" className="max-h-96 overflow-auto rounded-lg border bg-muted/40 p-3 text-start font-mono text-xs whitespace-pre-wrap break-words">{JSON.stringify(out, null, 2)}</pre>}
        </CardContent>
      </Card>
    </div>
  );
}

export function Developer({ go }: { go: (h: string) => void }) {
  const { t } = useI18n();

  return (
    <>
      <PageTitle title={t('Developer', 'برنامه‌نویس')} hint={t('Theme code, the REST API and raw access to every action.', 'کد پوسته، REST API و دسترسی مستقیم به همه‌ی عملیات.')}>
        <Button variant="outline" onClick={() => go('#/workbench')}>{t('Open the workbench', 'باز کردن میز کار')}</Button>
      </PageTitle>
      <Tabs defaultValue="files">
        <TabsList><TabsTrigger value="files">{t('Theme files', 'فایل‌های پوسته')}</TabsTrigger><TabsTrigger value="rest">REST API</TabsTrigger></TabsList>
        <TabsContent value="files" className="mt-4"><ThemeFiles /></TabsContent>
        <TabsContent value="rest" className="mt-4"><RestExplorer /></TabsContent>
      </Tabs>
    </>
  );
}

/** Copies content from one connected site to another, page by page, with a live progress bar. */
export function Transfer() {
  const { t } = useI18n();
  const { state, run } = useSite();
  const names = state.sites.map((s) => ({ value: s.name, label: s.name }));
  const [from, setFrom] = useState(state.sites[0]?.name ?? '');
  const [to, setTo] = useState(state.sites[1]?.name ?? '');
  const [kinds, setKinds] = useState<string[]>(['terms', 'posts']);
  const [postType, setPostType] = useState('page');
  const [overwrite, setOverwrite] = useState(false);
  const [publish, setPublish] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [counts, setCounts] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  useEffect(() => { if (!to && state.sites[1]) setTo(state.sites[1].name); }, [state.sites.length]);

  const toggle = (k: string): void => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k]);
  const base = { from, to, kinds, post_type: postType, overwrite, publish };

  const preview = async (): Promise<void> => {
    const r = await run<any>('site', 'transfer', base, { dry: true, level: 'admin', site: undefined });
    if (r.ok) setCounts(r.data?.would_copy ?? null);
  };
  const start = async (): Promise<void> => {
    setBusy(true);
    setReport(null);
    let page = 1;
    let id_map: any = undefined;
    const total: any = { created: 0, skipped: 0, failed: [] as any[] };
    for (let guard = 0; guard < 200; guard++) {
      const r = await run<any>('site', 'transfer', { ...base, page, pages: 2, ...(id_map ? { id_map } : {}) }, { level: 'admin', quiet: true });
      if (!r.ok) break;
      for (const k of Object.values<any>(r.data.report ?? {})) { total.created += k.created; total.skipped += k.skipped; total.failed.push(...k.failed); }
      id_map = r.data.id_map;
      if (!r.data.next) { setProgress(100); break; }
      page = r.data.next.page;
      setProgress(Math.min(95, guard * 10 + 10));
    }
    setReport(total);
    setBusy(false);
  };

  if (state.sites.length < 2) {
    return (<><PageTitle title={t('Copy between sites', 'کپی بین سایت‌ها')} /><Card><CardContent className="pt-4 text-sm text-muted-foreground">{t('Connect at least two sites to copy content between them.', 'برای کپی محتوا دست‌کم دو سایت وصل کنید.')}</CardContent></Card></>);
  }

  return (
    <>
      <PageTitle title={t('Copy between sites', 'کپی بین سایت‌ها')} hint={t('Moves pages, posts, categories, images, menus and design settings from one site to another. New items arrive as drafts.', 'برگه‌ها، نوشته‌ها، دسته‌ها، تصاویر، منوها و تنظیمات طراحی را از یک سایت به سایت دیگر می‌برد. موارد جدید پیش‌نویس می‌آیند.')} />
      <Card>
        <CardContent className="space-y-5 pt-4">
          <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
            <Field label={t('From', 'از')}><Pick value={from} onChange={setFrom} options={names} /></Field>
            <ArrowLeftRightIcon className="mb-2 hidden size-5 text-muted-foreground sm:block" />
            <Field label={t('To', 'به')}><Pick value={to} onChange={setTo} options={names} /></Field>
          </div>
          <Field label={t('What to copy', 'چه چیزی کپی شود')}>
            <div className="flex flex-wrap gap-2">
              {[['terms', t('Categories & tags', 'دسته‌ها و برچسب‌ها')], ['posts', t('Pages / posts', 'برگه‌ها / نوشته‌ها')], ['menus', t('Menus', 'منوها')], ['design', t('Design settings', 'تنظیمات طراحی')]].map(([k, label]) => <button key={k} onClick={() => toggle(k)}><Badge variant={kinds.includes(k) ? 'default' : 'outline'} className="px-3 py-1 text-sm">{label}</Badge></button>)}
            </div>
          </Field>
          {kinds.includes('posts') && <Field label={t('Content type', 'نوع محتوا')}><Pick value={postType} onChange={setPostType} options={[{ value: 'page', label: t('Pages', 'برگه‌ها') }, { value: 'post', label: t('Posts', 'نوشته‌ها') }, { value: 'product', label: t('Products', 'محصولات') }]} /></Field>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center justify-between rounded-lg border p-3 text-sm"><span>{t('Replace items that already exist', 'جایگزینی موارد موجود')}</span><Switch checked={overwrite} onCheckedChange={setOverwrite} /></div>
            <div className="flex items-center justify-between rounded-lg border p-3 text-sm"><span>{t('Publish right away (not as drafts)', 'انتشار فوری (نه پیش‌نویس)')}</span><Switch checked={publish} onCheckedChange={setPublish} /></div>
          </div>
          {counts && <div className="rounded-lg border bg-muted/30 p-3 text-sm">{Object.entries<any>(counts).map(([k, v]) => <span key={k} className="me-4"><b>{v}</b> {k}</span>)}</div>}
          {busy && <Progress value={progress} />}
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy || !from || !to || from === to} onClick={preview}>{t('Count first', 'اول بشمار')}</Button>
            <Button disabled={busy || !from || !to || from === to || kinds.length === 0} onClick={start}>{busy ? t('Copying…', 'در حال کپی…') : t('Start copying', 'شروع کپی')}</Button>
          </div>
          {report && (
            <div className="rounded-lg border p-4 text-sm">
              <b>{t('Finished', 'تمام شد')}:</b> {report.created} {t('created', 'ساخته شد')}, {report.skipped} {t('skipped (already there)', 'رد شد (از قبل بود)')}, {report.failed.length} {t('failed', 'ناموفق')}
              {report.failed.slice(0, 5).map((f: any, i: number) => <div key={i} className="text-xs text-destructive">{f.slug ?? f.old_id}: {f.error}</div>)}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
