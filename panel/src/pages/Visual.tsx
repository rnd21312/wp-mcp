import { ChevronDownIcon, ChevronRightIcon, EyeIcon, LaptopIcon, MonitorIcon, RefreshCwIcon, SaveIcon, SmartphoneIcon, TabletIcon, Undo2Icon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PageTitle, Pick } from '@/components/bits';
import { Loading } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAction, useSite } from '@/lib/site';

type Bucket = 'desktop' | 'tablet' | 'mobile';
type Rules = Record<Bucket, Record<string, Record<string, string>>>;
const EMPTY: Rules = { desktop: {}, tablet: {}, mobile: {} };
const WIDTH: Record<Bucket, string> = { desktop: '100%', tablet: '820px', mobile: '390px' };
const MEDIA: Record<Bucket, string> = { desktop: '', tablet: '(max-width: 1024px)', mobile: '(max-width: 640px)' };
const SECTION = 'visual-editor';

const GROUPS: { title: string; fa: string; props: { p: string; kind?: 'color' | 'select'; options?: string[] }[] }[] = [
  { title: 'Text', fa: 'متن', props: [{ p: 'color', kind: 'color' }, { p: 'font-size' }, { p: 'font-weight', kind: 'select', options: ['300', '400', '500', '600', '700', '800'] }, { p: 'line-height' }, { p: 'letter-spacing' }, { p: 'text-align', kind: 'select', options: ['start', 'center', 'end', 'justify'] }] },
  { title: 'Spacing', fa: 'فاصله', props: [{ p: 'margin' }, { p: 'padding' }, { p: 'gap' }] },
  { title: 'Size', fa: 'اندازه', props: [{ p: 'width' }, { p: 'max-width' }, { p: 'height' }, { p: 'min-height' }] },
  { title: 'Background & border', fa: 'پس‌زمینه و حاشیه', props: [{ p: 'background-color', kind: 'color' }, { p: 'border' }, { p: 'border-radius' }, { p: 'box-shadow' }, { p: 'opacity' }] },
  { title: 'Layout', fa: 'چیدمان', props: [{ p: 'display', kind: 'select', options: ['block', 'inline-block', 'flex', 'grid', 'inline', 'none'] }, { p: 'flex-direction', kind: 'select', options: ['row', 'column', 'row-reverse', 'column-reverse'] }, { p: 'justify-content', kind: 'select', options: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around'] }, { p: 'align-items', kind: 'select', options: ['stretch', 'flex-start', 'center', 'flex-end'] }, { p: 'position', kind: 'select', options: ['static', 'relative', 'absolute', 'sticky'] }] },
];

const EDITOR_CSS = `.wpm-hover{outline:2px dashed #3b82f6!important;outline-offset:-2px;cursor:pointer!important}.wpm-sel{outline:2px solid #f59e0b!important;outline-offset:-2px}
.wpm-seo :is(h1,h2,h3,h4,h5,h6){outline:2px solid #8b5cf6;outline-offset:2px}.wpm-seo :is(h1,h2,h3,h4,h5,h6)::before{content:attr(data-wpm-h);font:700 10px/1 sans-serif;background:#8b5cf6;color:#fff;padding:2px 5px;margin-inline-end:6px;border-radius:3px;vertical-align:middle}
.wpm-seo img:not([alt]),.wpm-seo img[alt=""]{outline:3px solid #ef4444;outline-offset:-3px}.wpm-seo a[rel~=nofollow]{outline:2px dotted #f59e0b}`;

const css = (rules: Rules): string => {
  const block = (r: Record<string, Record<string, string>>, pad = ''): string => Object.entries(r).filter(([, d]) => Object.keys(d).length).map(([sel, d]) => `${pad}${sel}{${Object.entries(d).map(([k, v]) => `${k}:${v} !important`).join(';')}}`).join('\n');
  return (['desktop', 'tablet', 'mobile'] as Bucket[]).map((b) => { const body = block(rules[b], b === 'desktop' ? '' : '  '); return body ? (b === 'desktop' ? body : `@media ${MEDIA[b]}{\n${body}\n}`) : ''; }).filter(Boolean).join('\n');
};

const unique = (doc: Document, sel: string): boolean => { try { return doc.querySelectorAll(sel).length === 1; } catch { return false; } };

function candidates(el: Element): string[] {
  const doc = el.ownerDocument;
  const tag = el.tagName.toLowerCase();
  const out: string[] = [];
  if (el.id) out.push(`#${CSS.escape(el.id)}`);
  const cls = [...el.classList].filter((c) => !c.startsWith('wpm-')).map((c) => CSS.escape(c));
  for (const c of cls) { out.push(`.${c}`); out.push(`${tag}.${c}`); }
  if (cls.length > 1) out.push(`${tag}.${cls.slice(0, 2).join('.')}`);
  const parts: string[] = [];
  for (let n: Element | null = el; n && n !== doc.body && parts.length < 6; n = n.parentElement) {
    const i = n.parentElement ? [...n.parentElement.children].filter((x) => x.tagName === n!.tagName).indexOf(n) + 1 : 1;
    const part = n.id ? `#${CSS.escape(n.id)}` : `${n.tagName.toLowerCase()}:nth-of-type(${i})`;
    parts.unshift(part);
    if (n.id || unique(doc, parts.join(' > '))) break;
  }
  out.push(parts.join(' > '));
  const uniq = [...new Set(out)];

  return [...uniq.filter((s) => unique(doc, s)), ...uniq.filter((s) => !unique(doc, s))];
}

const isLeafText = (el: Element): boolean => el.children.length === 0 && !!el.textContent?.trim();

function Tree({ el, depth, open, toggle, sel, pick }: { el: Element; depth: number; open: Set<Element>; toggle: (e: Element) => void; sel: Element | null; pick: (e: Element) => void }) {
  const kids = [...el.children].filter((c) => !['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'BR'].includes(c.tagName)).slice(0, 150);
  const isOpen = open.has(el);
  const label = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].filter((c) => !c.startsWith('wpm-')).slice(0, 2).map((c) => `.${c}`).join('')}`;

  return (
    <div>
      <div className={`flex items-center gap-1 rounded px-1 py-0.5 text-xs ${sel === el ? 'bg-amber-500/20' : 'hover:bg-muted'}`} style={{ paddingInlineStart: depth * 10 + 4 }}>
        <button className="size-4 shrink-0 text-muted-foreground" onClick={() => toggle(el)}>{kids.length ? isOpen ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5 rtl:rotate-180" /> : null}</button>
        <button dir="ltr" className="min-w-0 flex-1 truncate text-start font-mono" onClick={() => pick(el)}>{label}</button>
      </div>
      {isOpen && kids.map((k, i) => <Tree key={i} el={k} depth={depth + 1} open={open} toggle={toggle} sel={sel} pick={pick} />)}
    </div>
  );
}

export function Visual() {
  const { t } = useI18n();
  const { run, site } = useSite();
  const pagesQ = useAction<any>('content', 'list', { post_type: 'page', per_page: 60 });
  const postsQ = useAction<any>('content', 'list', { post_type: 'post', per_page: 30 });
  const existing = useAction<any>('design', 'css_get', { section: SECTION });
  const frame = useRef<HTMLIFrameElement>(null);
  const [target, setTarget] = useState<{ id: number; url: string; title: string } | null>(null);
  const [src, setSrc] = useState('');
  const [loading, setLoading] = useState(false);
  const [bucket, setBucket] = useState<Bucket>('desktop');
  const [rules, setRules] = useState<Rules>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<Element | null>(null);
  const [selector, setSelector] = useState('');
  const [open, setOpen] = useState<Set<Element>>(new Set());
  const [seo, setSeo] = useState(false);
  const [text, setText] = useState('');
  const [tick, setTick] = useState(0);
  const [doc, setDoc] = useState<Document | null>(null);
  const rulesRef = useRef(rules);
  rulesRef.current = rules;

  const items: any[] = [...(pagesQ.data?.items ?? []), ...(postsQ.data?.items ?? [])].filter((p) => p.status === 'publish');

  /* saved rules of this site */
  useEffect(() => {
    const css0: string = existing.data?.css ?? '';
    const m = /\/\* wpm-visual:(\{.*?\}) \*\//.exec(css0);
    try { setRules(m ? { ...EMPTY, ...JSON.parse(m[1]) } : EMPTY); } catch { setRules(EMPTY); }
    setDirty(false);
  }, [existing.data]);

  const load = async (p: { id: number; url: string; title: string }): Promise<void> => {
    setTarget(p);
    setLoading(true);
    setSel(null);
    const r = await api.post<any>('inspect/fetch', { url: p.url });
    setLoading(false);
    if (!r.ok) { toast.error(r.error?.message ?? 'Failed'); return; }
    let html: string = r.final.html;
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<meta[^>]+http-equiv=["']?refresh[^>]*>/gi, '');
    const inject = `<base href="${r.final.url}"><style id="wpm-ed">${EDITOR_CSS}</style><style id="wpm-visual-style"></style>`;
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => `${h}${inject}`) : `<head>${inject}</head>${html}`;
    setSrc(html);
  };

  const paint = useCallback((d: Document | null, r: Rules): void => {
    const style = d?.getElementById('wpm-visual-style');
    if (style) style.textContent = css(r);
  }, []);

  const select = useCallback((el: Element | null): void => {
    const d = frame.current?.contentDocument;
    d?.querySelectorAll('.wpm-sel').forEach((n) => n.classList.remove('wpm-sel'));
    setSel(el);
    if (!el) return;
    el.classList.add('wpm-sel');
    setSelector(candidates(el)[0] ?? el.tagName.toLowerCase());
    setText(isLeafText(el) ? (el.textContent ?? '').trim() : '');
    const anc = new Set<Element>(open);
    for (let n: Element | null = el.parentElement; n; n = n.parentElement) anc.add(n);
    setOpen(anc);
    setTick((x) => x + 1);
  }, [open]);

  const onLoad = (): void => {
    const d = frame.current?.contentDocument;
    if (!d) return;
    setDoc(d);
    paint(d, rulesRef.current);
    d.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').forEach((h) => h.setAttribute('data-wpm-h', h.tagName));
    d.addEventListener('mouseover', (e) => { d.querySelectorAll('.wpm-hover').forEach((n) => n.classList.remove('wpm-hover')); (e.target as Element).classList?.add('wpm-hover'); });
    d.addEventListener('mouseout', (e) => (e.target as Element).classList?.remove('wpm-hover'));
    d.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); select(e.target as Element); }, true);
    setOpen(new Set(d.body ? [d.body] : []));
  };

  useEffect(() => paint(doc, rules), [rules, doc, paint]);
  useEffect(() => { doc?.body?.classList.toggle('wpm-seo', seo); }, [seo, doc]);

  const setProp = (prop: string, value: string): void => {
    if (!selector) return;
    setRules((r) => {
      const next: Rules = JSON.parse(JSON.stringify(r));
      const bucketRules = (next[bucket][selector] ??= {});
      if (value.trim()) bucketRules[prop] = value.trim(); else delete bucketRules[prop];
      if (!Object.keys(bucketRules).length) delete next[bucket][selector];
      return next;
    });
    setDirty(true);
  };

  const computed = useMemo(() => {
    if (!sel) return {} as Record<string, string>;
    const cs = sel.ownerDocument.defaultView!.getComputedStyle(sel);
    const out: Record<string, string> = {};
    for (const g of GROUPS) for (const { p } of g.props) out[p] = cs.getPropertyValue(p);

    return out;
  }, [sel, rules, tick]);

  const save = async (): Promise<void> => {
    const body = `/* wpm-visual:${JSON.stringify(rules)} */\n${css(rules)}`;
    const r = await run('design', 'css_set', { css: body, section: SECTION, mode: 'replace' });
    if (r.ok) { setDirty(false); existing.reload(); }
  };

  const replaceInPost = async (from: string, to: string): Promise<void> => {
    if (!target?.id) { toast.error(t('Pick a page from the list to edit its text.', 'برای ویرایش متن، یک صفحه را از فهرست انتخاب کنید.')); return; }
    const got = await run<any>('content', 'get', { id: target.id }, { silent: true, quiet: true });
    if (!got.ok) return;
    const raw: string = got.data.content;
    const variants = [from, from.replace(/&/g, '&amp;')];
    const hit = variants.find((v) => raw.includes(v));
    if (!hit) { toast.error(t('This text is not in the page content (it may come from the theme, header or footer). Edit it in Design → Header & footer.', 'این متن در محتوای صفحه نیست (شاید از پوسته، هدر یا فوتر باشد). از طراحی ← هدر و فوتر ویرایشش کنید.')); return; }
    const n = raw.split(hit).length - 1;
    if (n > 1 && !confirm(t(`This text appears ${n} times in the page. Replace all?`, `این متن ${n} بار در صفحه آمده. همه عوض شوند؟`))) return;
    const r = await run('content', 'save', { id: target.id, content: raw.split(hit).join(to.replace(/&/g, hit.includes('&amp;') ? '&amp;' : '&')), status: got.data.status });
    if (r.ok && sel) { sel.textContent = to; setTick((x) => x + 1); }
  };

  const tag = sel?.tagName.toLowerCase();
  const cands = sel ? candidates(sel).slice(0, 5) : [];
  const count = (() => { try { return sel ? sel.ownerDocument.querySelectorAll(selector).length : 0; } catch { return 0; } })();

  return (
    <>
      <PageTitle title={t('Visual editor', 'ویرایشگر بصری')} hint={t('Click anything on the page, like the browser inspector: see its box and styles, change them live, edit its text. Saved as clean CSS you can undo.', 'روی هر چیز صفحه کلیک کنید، مثل inspect مرورگر: باکس و استایل را ببینید، زنده تغییرش دهید و متنش را ویرایش کنید. به‌صورت CSS تمیز ذخیره می‌شود و قابل بازگردانی است.')}>
        <Button variant="outline" disabled={!target} onClick={() => target && load(target)}><RefreshCwIcon /> {t('Reload', 'بارگذاری مجدد')}</Button>
        <Button disabled={!dirty} onClick={save}><SaveIcon /> {t('Save styles', 'ذخیره استایل‌ها')}</Button>
      </PageTitle>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="w-72"><Pick value={target ? String(target.url) : '-'} onChange={(v) => { const p = items.find((x) => x.url === v); if (p) void load({ id: p.id, url: p.url, title: p.title }); }} options={[{ value: '-', label: t('Choose a page…', 'یک صفحه انتخاب کنید…') }, ...items.map((p) => ({ value: p.url, label: p.title }))]} /></div>
        {site && <Button variant="outline" size="sm" onClick={() => load({ id: 0, url: site.url, title: 'Home' })}>{t('Home page', 'صفحه‌ی اصلی')}</Button>}
        <div className="flex rounded-lg border p-0.5">
          {([['desktop', MonitorIcon], ['tablet', TabletIcon], ['mobile', SmartphoneIcon]] as const).map(([b, Icon]) => <Button key={b} variant={bucket === b ? 'secondary' : 'ghost'} size="icon-sm" aria-label={b} onClick={() => setBucket(b)}><Icon /></Button>)}
        </div>
        <label className="flex items-center gap-2 text-sm"><Switch checked={seo} onCheckedChange={setSeo} /> <EyeIcon className="size-4" /> {t('SEO overlay', 'نمایش سئو')}</label>
        {bucket !== 'desktop' && <Badge variant="secondary">{t(`Edits apply only up to ${bucket === 'tablet' ? '1024px' : '640px'} wide`, `تغییرها فقط تا عرض ${bucket === 'tablet' ? '۱۰۲۴' : '۶۴۰'} پیکسل اعمال می‌شوند`)}</Badge>}
      </div>

      <div className="grid gap-3 xl:grid-cols-[14rem_minmax(0,1fr)_20rem]">
        <Card className="hidden max-h-[75vh] overflow-auto xl:block"><CardContent className="p-1">
          {doc?.body ? <Tree el={doc.body} depth={0} open={open} toggle={(e) => setOpen((o) => { const n = new Set(o); n.has(e) ? n.delete(e) : n.add(e); return n; })} sel={sel} pick={select} /> : <p className="p-3 text-xs text-muted-foreground">DOM</p>}
        </CardContent></Card>

        <div className="min-w-0 overflow-auto rounded-xl border bg-muted/30 p-2" style={{ height: '75vh' }}>
          {loading ? <Loading /> : src ? (
            <iframe ref={frame} key={src.length + (target?.url ?? '')} title="page" sandbox="allow-same-origin" srcDoc={src} onLoad={onLoad} className="mx-auto h-full rounded-md border bg-white shadow-sm transition-[width]" style={{ width: WIDTH[bucket] }} />
          ) : <div className="grid h-full place-items-center text-sm text-muted-foreground"><div className="text-center"><LaptopIcon className="mx-auto mb-2 size-8 opacity-40" />{t('Choose a page to start.', 'برای شروع یک صفحه انتخاب کنید.')}</div></div>}
        </div>

        <Card className="max-h-[75vh] overflow-auto"><CardContent className="space-y-3 p-3">
          {!sel ? <p className="py-10 text-center text-sm text-muted-foreground">{t('Click an element in the page.', 'روی یک المان در صفحه کلیک کنید.')}</p> : (
            <>
              <div className="flex flex-wrap items-center gap-1.5 text-xs"><Badge variant="outline" className="font-mono">{tag}</Badge>{sel.id && <Badge variant="secondary" className="font-mono">#{sel.id}</Badge>}<span className="text-muted-foreground">{Math.round(sel.getBoundingClientRect().width)}×{Math.round(sel.getBoundingClientRect().height)}</span>
                {sel.parentElement && sel.parentElement !== sel.ownerDocument.body && <Button variant="ghost" size="xs" onClick={() => select(sel.parentElement)}>↑ {t('parent', 'والد')}</Button>}</div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">{t('Selector', 'انتخابگر')} · {count} {t('match', 'مورد')}</div>
                <Input dir="ltr" className="h-8 font-mono text-xs" value={selector} onChange={(e) => setSelector(e.target.value)} />
                <div className="flex flex-wrap gap-1">{cands.map((c) => <button key={c} dir="ltr" onClick={() => setSelector(c)} className="max-w-full truncate rounded border px-1.5 py-0.5 font-mono text-[10px] hover:bg-muted">{c}</button>)}</div>
              </div>
              <Tabs defaultValue="style">
                <TabsList className="w-full"><TabsTrigger value="style">{t('Style', 'استایل')}</TabsTrigger><TabsTrigger value="content">{t('Content', 'محتوا')}</TabsTrigger><TabsTrigger value="code">CSS</TabsTrigger></TabsList>
                <TabsContent value="style" className="space-y-4 pt-2">
                  {GROUPS.map((g) => (
                    <div key={g.title} className="space-y-2"><div className="text-xs font-medium text-muted-foreground">{t(g.title, g.fa)}</div>
                      {g.props.map(({ p, kind, options }) => {
                        const v = rules[bucket][selector]?.[p] ?? '';
                        return (
                          <div key={p} className="grid grid-cols-[6.5rem_1fr] items-center gap-2">
                            <span dir="ltr" className={`truncate text-start text-xs ${v ? 'font-semibold text-amber-600' : 'text-muted-foreground'}`}>{p}</span>
                            {kind === 'select' ? <Pick size="sm" value={v || '-'} onChange={(x) => setProp(p, x === '-' ? '' : x)} options={[{ value: '-', label: computed[p] ? `(${computed[p]})` : '—' }, ...options!.map((o) => ({ value: o, label: o }))]} />
                              : kind === 'color' ? <div className="flex gap-1"><input type="color" className="size-7 shrink-0 cursor-pointer rounded border bg-transparent p-0" value={/^#[0-9a-f]{6}$/i.test(v) ? v : '#888888'} onChange={(e) => setProp(p, e.target.value)} /><Input dir="ltr" className="h-7 font-mono text-xs" value={v} placeholder={computed[p]} onChange={(e) => setProp(p, e.target.value)} /></div>
                              : <Input dir="ltr" className="h-7 font-mono text-xs" value={v} placeholder={computed[p]} onChange={(e) => setProp(p, e.target.value)} />}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  <Button variant="outline" size="sm" onClick={() => { setRules((r) => { const n: Rules = JSON.parse(JSON.stringify(r)); delete n[bucket][selector]; return n; }); setDirty(true); }}><Undo2Icon /> {t('Reset this element', 'بازنشانی این المان')}</Button>
                </TabsContent>

                <TabsContent value="content" className="space-y-3 pt-2">
                  {isLeafText(sel) ? (
                    <>
                      <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
                      <Button size="sm" disabled={text.trim() === (sel.textContent ?? '').trim()} onClick={() => replaceInPost((sel.textContent ?? '').trim(), text.trim())}>{t('Apply to the page', 'اعمال روی صفحه')}</Button>
                      <p className="text-xs text-muted-foreground">{t('Finds this exact text in the page content and replaces it. Undo is offered after saving.', 'همین متن را در محتوای صفحه پیدا و جایگزین می‌کند. بعد از ذخیره امکان بازگردانی هست.')}</p>
                    </>
                  ) : <p className="text-xs text-muted-foreground">{t('Select an element that contains only text (a heading, paragraph, button).', 'المانی را انتخاب کنید که فقط متن دارد (تیتر، پاراگراف، دکمه).')}</p>}
                  {tag === 'img' && <div className="space-y-2"><div className="text-xs font-medium">alt</div><Input defaultValue={sel.getAttribute('alt') ?? ''} id="alt-edit" /><Button size="sm" onClick={async () => {
                    const alt = (document.getElementById('alt-edit') as HTMLInputElement).value; const srcAttr = sel.getAttribute('src') ?? ''; const base = srcAttr.split('/').pop()?.split('?')[0] ?? '';
                    if (!target?.id || !base) return toast.error(t('Pick a page from the list first.', 'اول یک صفحه را از فهرست انتخاب کنید.'));
                    const got = await run<any>('content', 'get', { id: target.id }, { silent: true, quiet: true }); if (!got.ok) return;
                    const raw: string = got.data.content; const re = new RegExp(`<img[^>]*${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>`, 'i'); const m = re.exec(raw);
                    if (!m) return toast.error(t('Image tag not found in the content.', 'تگ تصویر در محتوا پیدا نشد.'));
                    const fixed = /\balt=("[^"]*"|'[^']*')/.test(m[0]) ? m[0].replace(/\balt=("[^"]*"|'[^']*')/, `alt="${alt.replace(/"/g, '&quot;')}"`) : m[0].replace(/<img/i, `<img alt="${alt.replace(/"/g, '&quot;')}"`);
                    if ((await run('content', 'save', { id: target.id, content: raw.replace(m[0], fixed), status: got.data.status })).ok) sel.setAttribute('alt', alt);
                  }}>{t('Save alt text', 'ذخیره‌ی متن جایگزین')}</Button></div>}
                  {tag === 'a' && <p dir="ltr" className="break-all text-start text-xs text-muted-foreground">href: {sel.getAttribute('href')}</p>}
                </TabsContent>

                <TabsContent value="code" className="space-y-2 pt-2">
                  <pre dir="ltr" className="max-h-72 overflow-auto rounded-lg border bg-muted/40 p-2 text-start font-mono text-[11px] whitespace-pre-wrap">{css(rules) || '/* no changes yet */'}</pre>
                  <p className="text-xs text-muted-foreground">{t('Saved into the CSS section "visual-editor" (Design → CSS). Other CSS is not touched.', 'در بخش CSS با نام «visual-editor» ذخیره می‌شود (طراحی ← CSS). بقیه‌ی CSS دست‌نخورده می‌ماند.')}</p>
                </TabsContent>
              </Tabs>
            </>
          )}
        </CardContent></Card>
      </div>
    </>
  );
}
