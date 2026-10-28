import { GaugeIcon, PlusIcon, SearchCheckIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { PageTitle, Pick } from '@/components/bits';
import { Counter, Field, Loading, pathOf } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { useAction, useSite } from '@/lib/site';

const scoreColor = (s: number): string => (s >= 80 ? 'text-emerald-600 dark:text-emerald-400' : s >= 55 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400');

export function Seo() {
  const { t } = useI18n();
  const { run, overview } = useSite();
  const pages = useAction<any>('content', 'list', { post_type: 'page', per_page: 50, orderby: 'modified' });
  const posts = useAction<any>('content', 'list', { post_type: 'post', per_page: 30, orderby: 'modified' });
  const siteSeo = useAction<any>('seo', 'site_get');
  const redirects = useAction<any>('seo', 'redirects_list', { per_page: 100 });
  const [edit, setEdit] = useState<any>(null);
  const [fields, setFields] = useState<any>({});
  const [audit, setAudit] = useState<any>(null);
  const [auditing, setAuditing] = useState('');
  const [robots, setRobots] = useState<string | null>(null);
  const [rd, setRd] = useState({ from: '', to: '', code: '301' });
  const items: any[] = [...(pages.data?.items ?? []), ...(posts.data?.items ?? [])].filter((x) => x.status === 'publish');

  const open = async (p: any): Promise<void> => {
    setEdit(p);
    setFields({});
    const r = await run<any>('seo', 'get', { id: p.id });
    if (r.ok) setFields(r.data.seo);
  };
  const doAudit = async (p: any): Promise<void> => {
    setAuditing(String(p.id));
    const r = await run<any>('seo', 'audit', { path: pathOf(p.url) }, { silent: false });
    setAuditing('');
    if (r.ok) setAudit({ ...r.data, page: p.title });
  };

  return (
    <>
      <PageTitle title={t('SEO', 'سئو')} hint={t('Titles, descriptions, redirects, robots.txt and a quick health check of every page.', 'عنوان، توضیحات، ریدایرکت، robots.txt و بررسی سریع سلامت هر صفحه.')} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <CardHeader><CardTitle>{t('Pages and posts', 'برگه‌ها و نوشته‌ها')}</CardTitle><CardDescription>{t('Edit what search engines show, or audit the live page.', 'آنچه موتورهای جستجو نشان می‌دهند را ویرایش کنید یا صفحه‌ی زنده را ممیزی کنید.')}</CardDescription></CardHeader>
          <CardContent className="divide-y p-0">
            {pages.loading && !pages.data ? <Loading /> : items.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{p.title}</div>
                  <div dir="ltr" className="truncate text-start text-xs text-muted-foreground">{pathOf(p.url)}</div>
                </div>
                <Button variant="outline" size="sm" onClick={() => open(p)}>{t('Edit', 'ویرایش')}</Button>
                <Button variant="ghost" size="sm" disabled={auditing === String(p.id)} onClick={() => doAudit(p)}><SearchCheckIcon /> {auditing === String(p.id) ? '…' : t('Audit', 'ممیزی')}</Button>
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>{t('Site-wide', 'کل سایت')}</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {siteSeo.data && (
                <>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('SEO plugin', 'افزونه‌ی سئو')}</span><Badge variant="secondary">{siteSeo.data.provider === 'native' ? t('built-in', 'داخلی') : siteSeo.data.provider}</Badge></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Search visibility', 'نمایش در جستجو')}</span><span>{overview?.search_visibility === 'visible' ? t('visible', 'قابل‌نمایش') : t('hidden!', 'پنهان!')}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Sitemap', 'نقشه‌ی سایت')}</span><a dir="ltr" className="text-primary hover:underline" href={siteSeo.data.sitemap?.url} target="_blank" rel="noreferrer">{pathOf(siteSeo.data.sitemap?.url ?? '')}</a></div>
                  <Field label="robots.txt">
                    <Textarea dir="ltr" rows={6} className="font-mono text-xs" value={robots ?? siteSeo.data.robots_txt_custom ?? ''} onChange={(e) => setRobots(e.target.value)} placeholder={'User-agent: *\nAllow: /\nSitemap: …'} />
                  </Field>
                  <Button size="sm" disabled={robots === null} onClick={async () => { if ((await run('seo', 'site_set', { robots_txt: robots })).ok) { setRobots(null); siteSeo.reload(); } }}>{t('Save robots.txt', 'ذخیره robots.txt')}</Button>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('Redirects', 'ریدایرکت‌ها')}</CardTitle><CardDescription>{t('Send an old address to a new one (301 = permanent).', 'آدرس قدیمی را به جدید بفرستید (۳۰۱ = دائمی).')}</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Input dir="ltr" placeholder="/old-page/" value={rd.from} onChange={(e) => setRd({ ...rd, from: e.target.value })} />
                <Input dir="ltr" placeholder="/new-page/" value={rd.to} onChange={(e) => setRd({ ...rd, to: e.target.value })} />
                <div className="flex gap-2">
                  <div className="w-28"><Pick value={rd.code} onChange={(v) => setRd({ ...rd, code: v })} options={['301', '302', '307', '410'].map((c) => ({ value: c, label: c }))} /></div>
                  <Button className="flex-1" disabled={!rd.from} onClick={async () => { if ((await run('seo', 'redirect_save', { from: rd.from, to: rd.to, code: rd.code })).ok) { setRd({ from: '', to: '', code: '301' }); redirects.reload(); } }}><PlusIcon /> {t('Add', 'افزودن')}</Button>
                </div>
              </div>
              <div className="divide-y rounded-lg border text-xs">
                {(redirects.data?.redirects ?? []).map((r: any) => (
                  <div key={r.from} dir="ltr" className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="truncate">{r.from} → {r.to || r.code}</span>
                    <Button variant="ghost" size="icon-xs" className="text-destructive" onClick={async () => { if ((await run('seo', 'redirect_delete', { from: r.from })).ok) redirects.reload(); }}><Trash2Icon /></Button>
                  </div>
                ))}
                {(redirects.data?.redirects ?? []).length === 0 && <div className="px-3 py-4 text-center text-muted-foreground">{t('No redirects.', 'ریدایرکتی نیست.')}</div>}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>{edit?.title}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Field label={t('SEO title', 'عنوان سئو')} hint={<Counter value={fields.title ?? ''} min={30} max={60} />}><Input value={fields.title ?? ''} onChange={(e) => setFields({ ...fields, title: e.target.value })} /></Field>
            <Field label={t('Meta description', 'توضیحات متا')} hint={<Counter value={fields.description ?? ''} min={120} max={155} />}><Textarea rows={3} value={fields.description ?? ''} onChange={(e) => setFields({ ...fields, description: e.target.value })} /></Field>
            <Field label={t('Canonical address (optional)', 'آدرس canonical (اختیاری)')}><Input dir="ltr" value={fields.canonical ?? ''} onChange={(e) => setFields({ ...fields, canonical: e.target.value })} /></Field>
            <Field label={t('Social image URL (optional)', 'آدرس تصویر شبکه‌های اجتماعی (اختیاری)')}><Input dir="ltr" value={fields.og_image ?? ''} onChange={(e) => setFields({ ...fields, og_image: e.target.value })} /></Field>
            <div className="flex items-center justify-between rounded-lg border p-3 text-sm"><span>{t('Hide this page from search engines (noindex)', 'پنهان‌کردن این صفحه از موتورهای جستجو (noindex)')}</span><Switch checked={!!fields.noindex} onCheckedChange={(v) => setFields({ ...fields, noindex: v })} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEdit(null)}>{t('Cancel', 'انصراف')}</Button>
            <Button onClick={async () => { const r = await run('seo', 'set', { id: edit.id, title: fields.title ?? '', description: fields.description ?? '', canonical: fields.canonical ?? '', og_image: fields.og_image ?? '', noindex: !!fields.noindex }); if (r.ok) setEdit(null); }}>{t('Save', 'ذخیره')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!audit} onOpenChange={(o) => !o && setAudit(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle className="flex items-center gap-3"><GaugeIcon className="size-5" />{audit?.page}<span className={`ms-auto text-2xl font-bold ${scoreColor(audit?.score ?? 0)}`}>{audit?.score}</span></DialogTitle></DialogHeader>
          <div className="max-h-[60vh] space-y-2 overflow-auto">
            {(audit?.issues ?? []).length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t('No problems found.', 'مشکلی پیدا نشد.')}</p>}
            {(audit?.issues ?? []).map((i: any, n: number) => (
              <div key={n} className="rounded-lg border p-3 text-sm">
                <div className="flex items-center gap-2"><Badge variant="secondary" className={i.severity === 'high' ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300' : i.severity === 'medium' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : ''}>{i.severity}</Badge><span className="font-medium">{i.issue}</span></div>
                <p className="mt-1 text-muted-foreground">{i.fix}</p>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
