import { EyeIcon, ImageIcon, PencilIcon, PlusIcon, SaveIcon, SendIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Empty, PageTitle, Pick, StatusBadge } from '@/components/bits';
import { Counter, Field, Loading, Pager, pathOf } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { useAction, useSite } from '@/lib/site';
import { MediaLibrary } from '@/pages/Media';

const STATUSES = ['any', 'publish', 'draft', 'pending', 'private', 'future', 'trash'];

export function ContentList({ query, go }: { query: URLSearchParams; go: (h: string) => void }) {
  const { t } = useI18n();
  const { overview, run } = useSite();
  const types: { name: string; label: string }[] = overview?.content?.types ?? [{ name: 'page', label: t('Pages', 'برگه‌ها') }, { name: 'post', label: t('Posts', 'نوشته‌ها') }];
  const type = query.get('type') ?? 'page';
  const [status, setStatus] = useState('any');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const { data, loading, error, reload } = useAction<any>('content', 'list', { post_type: type, status, search: q, page, per_page: 20, orderby: 'modified' });
  const items: any[] = data?.items ?? [];

  useEffect(() => setPage(1), [type, status, q]);

  return (
    <>
      <PageTitle title={t('Content', 'محتوا')} hint={t('Pages, blog posts and other content of the site.', 'برگه‌ها، نوشته‌های وبلاگ و دیگر محتوای سایت.')}>
        <Button onClick={() => go(`#/content/edit?type=${type}&id=0`)}><PlusIcon /> {t('New', 'جدید')}</Button>
      </PageTitle>
      <Tabs value={type} onValueChange={(v) => go(`#/content?type=${v}`)}>
        <TabsList>{types.map((x) => <TabsTrigger key={x.name} value={x.name}>{x.label}</TabsTrigger>)}</TabsList>
      </Tabs>
      <div className="my-4 flex flex-wrap gap-2">
        <form onSubmit={(e) => { e.preventDefault(); setQ(search); }} className="flex-1">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search…', 'جستجو…')} className="max-w-xs" />
        </form>
        <div className="w-40"><Pick value={status} onChange={setStatus} options={STATUSES.map((s) => ({ value: s, label: s === 'any' ? t('All statuses', 'همه‌ی وضعیت‌ها') : s }))} /></div>
      </div>

      {loading && !data ? <Loading /> : error ? <Empty>{error}</Empty> : items.length === 0 ? <Empty>{t('Nothing here yet.', 'هنوز چیزی نیست.')}</Empty> : (
        <Card>
          <CardContent className="divide-y p-0">
            {items.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                <button className="min-w-0 flex-1 text-start" onClick={() => go(`#/content/edit?type=${type}&id=${p.id}`)}>
                  <div className="truncate font-medium">{p.title || t('(no title)', '(بدون عنوان)')}</div>
                  <div dir="ltr" className="truncate text-start text-xs text-muted-foreground">{pathOf(p.url)}</div>
                </button>
                <StatusBadge status={p.status === 'publish' ? 'ok' : p.status} />
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon-sm" aria-label="edit" onClick={() => go(`#/content/edit?type=${type}&id=${p.id}`)}><PencilIcon /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label="view" render={<a href={p.url} target="_blank" rel="noreferrer" />}><EyeIcon /></Button>
                  <Button variant="ghost" size="icon-sm" className="text-destructive" aria-label="trash" onClick={async () => { if ((await run('content', 'trash', { id: p.id })).ok) reload(); }}><Trash2Icon /></Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <Pager page={page} pages={data?.pages ?? 1} onPage={setPage} />
    </>
  );
}

export function ContentEditor({ query, go }: { query: URLSearchParams; go: (h: string) => void }) {
  const { t, lang } = useI18n();
  const { run, overview } = useSite();
  const id = Number(query.get('id') ?? 0);
  const type = query.get('type') ?? 'page';
  const { data, loading, error } = useAction<any>('content', 'get', { id, include: ['seo'] }, id > 0);
  const cats = useAction<any>('content', 'terms_list', { taxonomy: 'category', per_page: 100 });
  const tags = useAction<any>('content', 'terms_list', { taxonomy: 'post_tag', per_page: 100 });
  const [f, setF] = useState<any>({ title: '', slug: '', status: 'draft', excerpt: '', content: '', terms: {}, featured: 0, seoTitle: '', seoDesc: '' });
  const [preview, setPreview] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('write');

  useEffect(() => {
    if (!data) return;
    const terms: Record<string, string[]> = {};
    for (const [tax, list] of Object.entries<any[]>(data.terms ?? {})) terms[tax] = list.map((x) => x.name);
    setF({ title: data.title, slug: decodeURIComponent(data.slug ?? ''), status: data.status, excerpt: data.excerpt_raw ?? '', content: data.content ?? '', terms, featured: data.featured_media ?? 0, seoTitle: data.seo?.title ?? '', seoDesc: data.seo?.description ?? '' });
  }, [data]);

  const set = (patch: any): void => setF((x: any) => ({ ...x, ...patch }));
  const toggleTerm = (tax: string, name: string): void => {
    const cur: string[] = f.terms[tax] ?? [];
    set({ terms: { ...f.terms, [tax]: cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name] } });
  };

  const save = async (status: string): Promise<void> => {
    setBusy(true);
    const r = await run<any>('content', 'save', { ...(id ? { id } : {}), post_type: type, title: f.title, slug: f.slug || undefined, status, excerpt: f.excerpt, content: f.content, terms: f.terms, featured_media: f.featured || undefined });
    if (r.ok) {
      const newId = r.data.id as number;
      if (f.seoTitle || f.seoDesc) await run('seo', 'set', { id: newId, title: f.seoTitle, description: f.seoDesc }, { quiet: true, silent: true });
      set({ status: r.data.status });
      if (!id) go(`#/content/edit?type=${type}&id=${newId}`);
    }
    setBusy(false);
  };

  const showPreview = async (): Promise<void> => {
    if (!id) {
      toast.info(t('Save first, then preview.', 'اول ذخیره کنید، بعد پیش‌نمایش.'));
      return;
    }
    const r = await run<any>('inspect', 'render', { id });
    if (r.ok) setPreview(r.data.html);
  };

  if (id > 0 && loading && !data) return <Loading />;
  if (error) return <Empty>{error}</Empty>;

  const published = f.status === 'publish';
  const termBox = (tax: string, label: string, list: any) => (list?.terms?.length ? (
    <Field label={label}>
      <div className="flex flex-wrap gap-1.5">
        {list.terms.map((x: any) => {
          const on = (f.terms[tax] ?? []).includes(x.name);
          return <button type="button" key={x.id} onClick={() => toggleTerm(tax, x.name)}><Badge variant={on ? 'default' : 'outline'}>{x.name}</Badge></button>;
        })}
      </div>
    </Field>
  ) : null);

  return (
    <>
      <PageTitle title={id ? t('Edit', 'ویرایش') : t('New', 'جدید')} hint={id ? `#${id} · ${type}` : type}>
        <Button variant="outline" onClick={() => go(`#/content?type=${type}`)}>{t('Back', 'بازگشت')}</Button>
        <Button variant="outline" disabled={busy} onClick={() => save(published ? 'draft' : f.status === 'pending' ? 'pending' : 'draft')}><SaveIcon /> {published ? t('Switch to draft', 'برگشت به پیش‌نویس') : t('Save draft', 'ذخیره پیش‌نویس')}</Button>
        <Button disabled={busy || !f.title} onClick={() => save('publish')}><SendIcon /> {published ? t('Update', 'به‌روزرسانی') : t('Publish', 'انتشار')}</Button>
      </PageTitle>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          <Input className="h-11 text-lg font-medium" value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder={t('Title', 'عنوان')} />
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>{t('Content', 'محتوا')}</CardTitle>
              <Tabs value={tab} onValueChange={(v) => { setTab(v); if (v === 'preview') void showPreview(); }}>
                <TabsList><TabsTrigger value="write">{t('Edit', 'ویرایش')}</TabsTrigger><TabsTrigger value="preview">{t('Preview', 'پیش‌نمایش')}</TabsTrigger></TabsList>
              </Tabs>
            </CardHeader>
            <CardContent>
              {tab === 'write' ? (
                <>
                  <Textarea dir="ltr" rows={22} className="font-mono text-xs leading-relaxed" value={f.content} onChange={(e) => set({ content: e.target.value })} placeholder="<!-- wp:paragraph --><p>…</p><!-- /wp:paragraph -->" />
                  <p className="mt-2 text-xs text-muted-foreground">{t('Block markup or HTML. Existing blocks are kept as they are.', 'کد بلوک یا HTML. بلوک‌های موجود همان‌طور که هستند حفظ می‌شوند.')}</p>
                </>
              ) : preview === null ? <Loading /> : (
                <iframe title="preview" sandbox="" className="h-[32rem] w-full rounded-lg border bg-white" srcDoc={`<!doctype html><meta charset="utf-8"><body dir="${lang === 'fa' ? 'rtl' : 'ltr'}" style="font:16px/1.7 system-ui;padding:16px;color:#111">${preview}`} />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>{t('Search engines', 'موتورهای جستجو')}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Field label={t('SEO title', 'عنوان سئو')} hint={<Counter value={f.seoTitle} min={30} max={60} />}><Input value={f.seoTitle} onChange={(e) => set({ seoTitle: e.target.value })} /></Field>
              <Field label={t('Meta description', 'توضیحات متا')} hint={<Counter value={f.seoDesc} min={120} max={155} />}><Textarea rows={3} value={f.seoDesc} onChange={(e) => set({ seoDesc: e.target.value })} /></Field>
              <p dir="ltr" className="rounded-lg border bg-muted/30 p-3 text-start text-sm">
                <span className="block text-blue-700 dark:text-blue-400">{f.seoTitle || f.title || 'Title'}</span>
                <span className="block text-xs text-emerald-700 dark:text-emerald-400">{data?.url ?? overview?.url ?? ''}</span>
                <span className="block text-xs text-muted-foreground">{f.seoDesc || f.excerpt || '…'}</span>
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-3 pt-4">
              <Field label={t('Status', 'وضعیت')}><Pick value={f.status} onChange={(v) => set({ status: v })} options={['draft', 'pending', 'publish', 'private'].map((s) => ({ value: s, label: s }))} /></Field>
              <Field label={t('Address (slug)', 'نشانی (slug)')}><Input dir="ltr" value={f.slug} onChange={(e) => set({ slug: e.target.value })} /></Field>
              <Field label={t('Excerpt', 'چکیده')}><Textarea rows={3} value={f.excerpt} onChange={(e) => set({ excerpt: e.target.value })} /></Field>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-3 pt-4">
              <Field label={t('Featured image', 'تصویر شاخص')}>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setPicker(true)}><ImageIcon /> {f.featured ? `#${f.featured}` : t('Choose', 'انتخاب')}</Button>
                  {f.featured ? <Button variant="ghost" size="sm" onClick={() => set({ featured: 0 })}>{t('Remove', 'حذف')}</Button> : null}
                </div>
              </Field>
              {termBox('category', t('Categories', 'دسته‌ها'), cats.data)}
              {termBox('post_tag', t('Tags', 'برچسب‌ها'), tags.data)}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={picker} onOpenChange={setPicker}>
        <DialogContent className="max-w-4xl">
          <DialogHeader><DialogTitle>{t('Choose an image', 'انتخاب تصویر')}</DialogTitle></DialogHeader>
          <div className="max-h-[70vh] overflow-auto"><MediaLibrary embedded onPick={(m) => { set({ featured: m.id }); setPicker(false); }} /></div>
        </DialogContent>
      </Dialog>
    </>
  );
}
