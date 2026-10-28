import { PlusIcon, SaveIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageTitle, Pick } from '@/components/bits';
import { Field, Loading } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { useAction, useSite } from '@/lib/site';

const DEFAULT_COLORS = ['primary', 'secondary', 'accent', 'background', 'foreground'];

function Tokens() {
  const { t } = useI18n();
  const { run } = useSite();
  const { data, loading, reload } = useAction<any>('design', 'tokens_get');
  const [colors, setColors] = useState<Record<string, string>>({});
  const [fonts, setFonts] = useState<Record<string, string>>({});
  const [radius, setRadius] = useState('');
  const [width, setWidth] = useState('');
  useEffect(() => {
    if (!data) return;
    setColors(data.site_tokens?.colors ?? {});
    setFonts(data.site_tokens?.fonts ?? {});
    setRadius(data.site_tokens?.radius ?? '');
    setWidth(data.site_tokens?.content_width ?? '');
  }, [data]);
  if (loading && !data) return <Loading />;
  const names = Array.from(new Set([...DEFAULT_COLORS, ...Object.keys(colors)]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Colors, fonts, spacing', 'رنگ‌ها، فونت‌ها، فاصله‌ها')}</CardTitle>
        <CardDescription>{t('Saved as CSS variables (--wpm-color-primary …) that any page can use, and added to the editor palette on block themes.', 'به‌صورت متغیر CSS ذخیره می‌شود (--wpm-color-primary …) که هر صفحه می‌تواند استفاده کند و در قالب‌های بلوکی به پالت ویرایشگر اضافه می‌شود.')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {names.map((n) => (
            <div key={n} className="flex items-center gap-3 rounded-lg border p-2">
              <input type="color" value={/^#[0-9a-f]{6}$/i.test(colors[n] ?? '') ? colors[n] : '#888888'} onChange={(e) => setColors({ ...colors, [n]: e.target.value })} className="size-10 cursor-pointer rounded border-0 bg-transparent p-0" />
              <div className="min-w-0 flex-1">
                <div dir="ltr" className="text-start text-sm font-medium">{n}</div>
                <Input dir="ltr" className="h-7 font-mono text-xs" value={colors[n] ?? ''} placeholder="#000000" onChange={(e) => setColors({ ...colors, [n]: e.target.value })} />
              </div>
            </div>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Heading font', 'فونت تیترها')}><Input dir="ltr" value={fonts.heading ?? ''} onChange={(e) => setFonts({ ...fonts, heading: e.target.value })} placeholder="Vazirmatn, system-ui, sans-serif" /></Field>
          <Field label={t('Body font', 'فونت متن')}><Input dir="ltr" value={fonts.body ?? ''} onChange={(e) => setFonts({ ...fonts, body: e.target.value })} placeholder="Vazirmatn, system-ui, sans-serif" /></Field>
          <Field label={t('Corner radius', 'گردی گوشه‌ها')}><Input dir="ltr" value={radius} onChange={(e) => setRadius(e.target.value)} placeholder="12px" /></Field>
          <Field label={t('Content width', 'عرض محتوا')}><Input dir="ltr" value={width} onChange={(e) => setWidth(e.target.value)} placeholder="1100px" /></Field>
        </div>
        <Button onClick={async () => { const clean = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v)); if ((await run('design', 'tokens_set', { colors: clean(colors), fonts: clean(fonts), ...(radius ? { radius } : {}), ...(width ? { content_width: width } : {}) })).ok) reload(); }}><SaveIcon /> {t('Save', 'ذخیره')}</Button>
      </CardContent>
    </Card>
  );
}

function Css() {
  const { t } = useI18n();
  const { run } = useSite();
  const { data, loading, reload } = useAction<any>('design', 'css_get');
  const [name, setName] = useState('main');
  const [css, setCss] = useState('');
  const sections: Record<string, string> = data?.sections ?? {};
  useEffect(() => setCss(sections[name] ?? ''), [name, data]);
  if (loading && !data) return <Loading />;
  const names = Array.from(new Set(['main', ...Object.keys(sections)]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Custom CSS', 'CSS سفارشی')}</CardTitle>
        <CardDescription>{t('Split into named sections so each change only touches its own part. Loaded after the theme.', 'در بخش‌های نام‌دار تا هر تغییر فقط بخش خودش را عوض کند. بعد از پوسته بارگذاری می‌شود.')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {names.map((n) => <button key={n} onClick={() => setName(n)}><Badge variant={n === name ? 'default' : 'outline'}>{n}</Badge></button>)}
          <Button variant="ghost" size="sm" onClick={() => { const n = prompt(t('Section name', 'نام بخش'))?.toLowerCase().replace(/[^a-z0-9_-]/g, ''); if (n) setName(n); }}><PlusIcon /> {t('New section', 'بخش جدید')}</Button>
        </div>
        <Textarea dir="ltr" rows={16} className="font-mono text-xs" value={css} onChange={(e) => setCss(e.target.value)} placeholder={'.hero { padding: 4rem 1rem; }\n@media (max-width: 600px) { .hero { padding: 2rem 1rem; } }'} />
        <div className="flex gap-2">
          <Button onClick={async () => { if ((await run('design', 'css_set', { css, section: name })).ok) reload(); }}><SaveIcon /> {t('Save section', 'ذخیره بخش')}</Button>
          {sections[name] !== undefined && <Button variant="ghost" className="text-destructive" onClick={async () => { if ((await run('design', 'css_remove', { section: name })).ok) { setName('main'); reload(); } }}><Trash2Icon /> {t('Delete section', 'حذف بخش')}</Button>}
        </div>
        {data?.theme_additional_css && <details className="rounded-lg border p-3 text-xs"><summary className="cursor-pointer text-muted-foreground">{t('Theme "Additional CSS" (read-only)', '«CSS اضافی» پوسته (فقط‌خواندنی)')}</summary><pre dir="ltr" className="mt-2 whitespace-pre-wrap">{data.theme_additional_css}</pre></details>}
      </CardContent>
    </Card>
  );
}

function Menus() {
  const { t } = useI18n();
  const { run, overview } = useSite();
  const menus = useAction<any>('design', 'menus_list');
  const pages = useAction<any>('content', 'list', { post_type: 'page', per_page: 100, orderby: 'menu_order' });
  const [sel, setSel] = useState('');
  const tree = useAction<any>('design', 'menu_get', { menu: sel }, !!sel);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const [loc, setLoc] = useState('');
  const locations: string[] = overview?.menu_locations ?? Object.keys(menus.data?.locations ?? {});
  const list: any[] = menus.data?.menus ?? [];

  const draw = (items: any[], depth = 0): any => items.map((i) => (
    <div key={i.id}>
      <div className="flex items-center gap-2 py-1 text-sm" style={{ paddingInlineStart: depth * 20 }}><span className="size-1.5 rounded-full bg-primary" />{i.title}<span dir="ltr" className="truncate text-xs text-muted-foreground">{i.url}</span></div>
      {draw(i.children ?? [], depth + 1)}
    </div>
  ));

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>{t('Menus', 'منوها')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {menus.loading && !menus.data ? <Loading /> : list.length === 0 && <p className="text-sm text-muted-foreground">{t('No menus yet.', 'هنوز منویی نیست.')}</p>}
          <div className="flex flex-wrap gap-2">{list.map((m) => <button key={m.id} onClick={() => setSel(String(m.id))}><Badge variant={sel === String(m.id) ? 'default' : 'outline'}>{m.name} · {m.items}</Badge></button>)}</div>
          {sel && (tree.loading ? <Loading /> : <div className="rounded-lg border p-3">{draw(tree.data?.items ?? [])}</div>)}
          {sel && <Button variant="ghost" size="sm" className="text-destructive" onClick={async () => { if ((await run('design', 'menu_delete', { menu: sel })).ok) { setSel(''); menus.reload(); } }}><Trash2Icon /> {t('Delete menu', 'حذف منو')}</Button>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('Build a menu', 'ساخت منو')}</CardTitle><CardDescription>{t('Tick pages in the order you want them. Saving an existing name replaces that menu.', 'برگه‌ها را به ترتیب دلخواه تیک بزنید. ذخیره با نام موجود، همان منو را جایگزین می‌کند.')}</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <Field label={t('Menu name', 'نام منو')}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Main menu', 'منوی اصلی')} /></Field>
          <div className="max-h-56 space-y-1 overflow-auto rounded-lg border p-2">
            {(pages.data?.items ?? []).filter((p: any) => p.status === 'publish').map((p: any) => (
              <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted">
                <input type="checkbox" checked={picked.includes(p.id)} onChange={() => setPicked(picked.includes(p.id) ? picked.filter((x) => x !== p.id) : [...picked, p.id])} />
                {p.title}{picked.includes(p.id) && <Badge variant="secondary" className="ms-auto">{picked.indexOf(p.id) + 1}</Badge>}
              </label>
            ))}
          </div>
          {locations.length > 0 && <Field label={t('Show in', 'نمایش در')}><Pick value={loc || '-'} onChange={(v) => setLoc(v === '-' ? '' : v)} options={[{ value: '-', label: '—' }, ...locations.map((l) => ({ value: l, label: l }))]} /></Field>}
          <Button disabled={!name || picked.length === 0} onClick={async () => { if ((await run('design', 'menu_save', { name, items: picked.map((id) => ({ title: (pages.data.items.find((p: any) => p.id === id)?.title ?? ''), object: 'page', object_id: id })), locations: loc ? [loc] : [] })).ok) { toast.success(t('Menu saved', 'منو ذخیره شد')); setPicked([]); menus.reload(); } }}><SaveIcon /> {t('Save menu', 'ذخیره منو')}</Button>
        </CardContent>
      </Card>
    </div>
  );
}

function Templates() {
  const { t } = useI18n();
  const { run } = useSite();
  const list = useAction<any>('design', 'templates_list');
  const [cur, setCur] = useState<{ slug: string; kind: string } | null>(null);
  const [html, setHtml] = useState('');
  const open = async (slug: string, kind: string): Promise<void> => {
    const r = await run<any>('design', 'template_get', { slug, kind });
    if (r.ok) { setCur({ slug, kind }); setHtml(r.data.content); }
  };
  if (list.loading && !list.data) return <Loading />;
  if (list.data && !list.data.block_theme) {
    return <Card><CardContent className="pt-4 text-sm text-muted-foreground">{t('This theme is a classic theme: header and footer live in theme files. Use Developer → Files to edit them.', 'این پوسته کلاسیک است: هدر و فوتر در فایل‌های پوسته‌اند. برای ویرایش از بخش برنامه‌نویس ← فایل‌ها استفاده کنید.')}</CardContent></Card>;
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Card><CardContent className="max-h-[32rem] space-y-1 overflow-auto p-2">
        {(list.data?.templates ?? []).map((x: any) => (
          <button key={`${x.kind}-${x.slug}`} onClick={() => open(x.slug, x.kind)} className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-start text-sm hover:bg-muted ${cur?.slug === x.slug && cur?.kind === x.kind ? 'bg-muted' : ''}`}>
            <span className="truncate">{x.title || x.slug}</span><Badge variant="outline">{x.kind === 'part' ? x.area || 'part' : 'template'}</Badge>
          </button>
        ))}
      </CardContent></Card>
      <Card>
        <CardHeader><CardTitle>{cur ? cur.slug : t('Header, footer and templates', 'هدر، فوتر و قالب‌ها')}</CardTitle><CardDescription>{t('Block markup. Changes are saved as a customization and can be reset to the theme file.', 'کد بلوک. تغییرها به‌صورت سفارشی‌سازی ذخیره می‌شوند و می‌توان به فایل پوسته برگرداند.')}</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {cur ? (
            <>
              <Textarea dir="ltr" rows={18} className="font-mono text-xs" value={html} onChange={(e) => setHtml(e.target.value)} />
              <div className="flex gap-2">
                <Button onClick={async () => { if ((await run('design', 'template_save', { slug: cur.slug, kind: cur.kind, content: html })).ok) list.reload(); }}><SaveIcon /> {t('Save', 'ذخیره')}</Button>
                <Button variant="outline" onClick={async () => { const c = cur; if (c && (await run('design', 'template_reset', { slug: c.slug, kind: c.kind })).ok) { list.reload(); void open(c.slug, c.kind); } }}>{t('Reset to theme', 'بازگشت به پوسته')}</Button>
              </div>
            </>
          ) : <p className="py-10 text-center text-sm text-muted-foreground">{t('Pick a template on the side.', 'یک قالب را از کنار انتخاب کنید.')}</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function Branding() {
  const { t } = useI18n();
  const { run, overview } = useSite();
  const [title, setTitle] = useState('');
  const [tagline, setTagline] = useState('');
  useEffect(() => { setTitle(overview?.name ?? ''); setTagline(overview?.tagline ?? ''); }, [overview]);

  return (
    <Card>
      <CardHeader><CardTitle>{t('Site identity', 'هویت سایت')}</CardTitle></CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Site title', 'عنوان سایت')}><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label={t('Tagline', 'شعار')}><Input value={tagline} onChange={(e) => setTagline(e.target.value)} /></Field>
        <Button className="sm:col-span-2 sm:w-fit" onClick={() => run('design', 'branding_set', { title, tagline })}><SaveIcon /> {t('Save', 'ذخیره')}</Button>
        {overview?.theme && <p className="text-sm text-muted-foreground sm:col-span-2">{t('Active theme', 'پوسته‌ی فعال')}: <b>{overview.theme.name}</b> ({overview.theme.block_theme ? t('block theme', 'قالب بلوکی') : t('classic', 'کلاسیک')})</p>}
      </CardContent>
    </Card>
  );
}

export function Design() {
  const { t } = useI18n();

  return (
    <>
      <PageTitle title={t('Design', 'طراحی')} hint={t('Look and feel: identity, colors and fonts, header and footer, menus and your own CSS.', 'ظاهر سایت: هویت، رنگ و فونت، هدر و فوتر، منوها و CSS اختصاصی.')} />
      <Tabs defaultValue="identity">
        <TabsList className="flex-wrap">
          <TabsTrigger value="identity">{t('Identity', 'هویت')}</TabsTrigger>
          <TabsTrigger value="tokens">{t('Colors & fonts', 'رنگ و فونت')}</TabsTrigger>
          <TabsTrigger value="menus">{t('Menus', 'منوها')}</TabsTrigger>
          <TabsTrigger value="templates">{t('Header & footer', 'هدر و فوتر')}</TabsTrigger>
          <TabsTrigger value="css">CSS</TabsTrigger>
        </TabsList>
        <TabsContent value="identity" className="mt-4"><Branding /></TabsContent>
        <TabsContent value="tokens" className="mt-4"><Tokens /></TabsContent>
        <TabsContent value="menus" className="mt-4"><Menus /></TabsContent>
        <TabsContent value="templates" className="mt-4"><Templates /></TabsContent>
        <TabsContent value="css" className="mt-4"><Css /></TabsContent>
      </Tabs>
    </>
  );
}
