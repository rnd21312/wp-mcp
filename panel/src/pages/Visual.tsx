import { ChevronDownIcon, ChevronRightIcon, MonitorIcon, MousePointerClickIcon, RefreshCwIcon, SaveIcon, SmartphoneIcon, TabletIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Pick } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { useAction, useSite } from '@/lib/site';
import { DEVICES, OVERRIDE_SECTION, overridesToCss, parseOverrides, type Overrides } from '@/lib/visualCss';

/* ------------------------------------------------------------ builder trees */

interface Hit { node: any; parent: any | null; index: number }

/** Finds an element in an Elementor tree (nested) or a Bricks list (flat). */
function locate(tree: any[], id: string, builder: string): Hit | null {
  if (builder === 'bricks') {
    const node = tree.find((n) => n.id === id);
    if (!node) return null;
    const parent = node.parent ? tree.find((n) => n.id === node.parent) ?? null : null;

    return { node, parent, index: parent ? (parent.children ?? []).indexOf(id) : tree.filter((n) => !n.parent).findIndex((n) => n.id === id) };
  }
  const walk = (list: any[], parent: any | null): Hit | null => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return { node: list[i], parent, index: i };
      const sub = walk(list[i].elements ?? [], list[i]);
      if (sub) return sub;
    }

    return null;
  };

  return walk(tree, null);
}

const stripTags = (s: string): string => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();

const NEW_ELEMENT: Record<string, Record<string, any>> = {
  elementor: {
    heading: { elType: 'widget', widgetType: 'heading', settings: { title: 'New heading' } },
    text: { elType: 'widget', widgetType: 'text-editor', settings: { editor: '<p>New text</p>' } },
    button: { elType: 'widget', widgetType: 'button', settings: { text: 'Button', link: { url: '#' } } },
    spacer: { elType: 'widget', widgetType: 'spacer', settings: {} },
    container: { elType: 'container', settings: {}, elements: [] },
  },
  bricks: {
    heading: { name: 'heading', settings: { text: 'New heading' } },
    text: { name: 'text-basic', settings: { text: 'New text' } },
    button: { name: 'button', settings: { text: 'Button' } },
    container: { name: 'container', settings: {} },
  },
};

/* ------------------------------------------------------------- style panel */

const PROPS: [string, string][] = [
  ['color', 'color'], ['background-color', 'background'], ['font-size', 'font size'], ['font-weight', 'weight'], ['line-height', 'line height'], ['text-align', 'align'],
  ['padding', 'padding'], ['margin', 'margin'], ['width', 'width'], ['max-width', 'max width'], ['height', 'height'], ['border-radius', 'radius'],
  ['border', 'border'], ['display', 'display'], ['gap', 'gap'], ['opacity', 'opacity'], ['box-shadow', 'shadow'],
];

function Layer({ n, sel, pick, depth }: { n: any; sel: number; pick: (id: number) => void; depth: number }) {
  const [open, setOpen] = useState(depth < 2);

  return (
    <div>
      <div className={`flex items-center rounded px-1 text-[11px] ${sel === n.id ? 'bg-amber-500/25' : 'hover:bg-muted'}`} style={{ paddingInlineStart: depth * 10 }}>
        <button className="size-4 shrink-0 text-muted-foreground" onClick={() => setOpen(!open)}>{n.kids.length ? open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3 rtl:rotate-180" /> : null}</button>
        <button dir="ltr" className="flex-1 truncate py-0.5 text-start font-mono" onClick={() => pick(n.id)}>{n.label}</button>
      </div>
      {open && n.kids.map((k: any) => <Layer key={k.id} n={k} sel={sel} pick={pick} depth={depth + 1} />)}
    </div>
  );
}

/* -------------------------------------------------------------------- page */

export function Visual() {
  const { t } = useI18n();
  const { run, site, state } = useSite();
  const pages = useAction<any>('content', 'list', { post_type: 'page', per_page: 100 });
  const css = useAction<any>('design', 'css_get');
  const frame = useRef<HTMLIFrameElement>(null);

  const [url, setUrl] = useState(site?.url ?? '');
  const [device, setDevice] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [info, setInfo] = useState<any>(null);
  const [tree, setTree] = useState<any>(null);
  const [ov, setOv] = useState<Overrides>({});
  const [dirty, setDirty] = useState(false);
  const [selIndex, setSelIndex] = useState(0);
  const [bTree, setBTree] = useState<{ post: number; builder: string; data: any[] } | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [kind, setKind] = useState('heading');
  const [extra, setExtra] = useState({ prop: '', value: '' });

  const media = DEVICES[device].media;
  const src = `${state.preview.base}/page?u=${encodeURIComponent(url)}&t=${state.preview.token}&n=${nonce}`;
  const send = useCallback((m: Record<string, unknown>): void => { frame.current?.contentWindow?.postMessage({ wpm: 1, ...m }, '*'); }, []);
  const source = info?.source as { builder: string; element: string; post: number; widget: string; elType: string } | undefined;
  const sel: string = info?.selectors?.[selIndex] ?? '';

  useEffect(() => { setOv(parseOverrides(css.data?.sections?.[OVERRIDE_SECTION] ?? '')); setDirty(false); }, [css.data]);
  useEffect(() => { setInfo(null); setTree(null); }, [url, nonce]);

  /* the saved overrides and any unsaved ones show live in the frame */
  const live = useCallback((next: Overrides): void => send({ type: 'css-live', key: 'main', css: overridesToCss(next) }), [send]);

  /* builder data of the post behind the selected element */
  const builderOf = useCallback(async (post: number, builder: string): Promise<any[] | null> => {
    if (bTree && bTree.post === post && bTree.builder === builder) return bTree.data;
    const r = await run('builder', 'get', { id: post }, { silent: true, quiet: true });
    const data = r.ok && Array.isArray((r.data as any)?.data) ? (r.data as any).data : null;
    if (data) setBTree({ post, builder, data });

    return data;
  }, [bTree, run]);

  const hit = useMemo(() => (source?.element && bTree && bTree.post === source.post ? locate(bTree.data, source.element, source.builder) : null), [source, bTree]);

  useEffect(() => {
    if (source?.element && source.post && (source.builder === 'elementor' || source.builder === 'bricks')) void builderOf(source.post, source.builder);
  }, [source?.element, source?.post, source?.builder]);

  useEffect(() => {
    const s: Record<string, string> = {};
    for (const [k, v] of Object.entries(hit?.node?.settings ?? {})) s[k] = typeof v === 'string' ? v : JSON.stringify(v);
    setSettings(s);
  }, [hit?.node]);

  /* double-click text editing: write it to the builder setting or the post content */
  const saveText = useCallback(async (m: any): Promise<void> => {
    const old = String(m.old).trim();
    const text = String(m.text).trim();
    const src2 = m.source as typeof source;
    if (src2?.builder && src2.element && src2.post) {
      const data = await builderOf(src2.post, src2.builder);
      const found = data ? locate(data, src2.element, src2.builder) : null;
      const key = found ? Object.keys(found.node.settings ?? {}).find((k) => typeof found.node.settings[k] === 'string' && stripTags(found.node.settings[k]) === old) : undefined;
      if (found && key) {
        const value = found.node.settings[key] as string;
        const r = await run('builder', 'element_update', { id: src2.post, element: src2.element, settings: { [key]: value.includes('<') ? value.replace(String(m.old), String(m.text)) : text } }, { auto: true });
        if (r.ok) setBTree(null);

        return;
      }
    }
    if (src2?.post) {
      const c = await run('content', 'get', { id: src2.post }, { silent: true, quiet: true });
      const body = String((c.data as any)?.content ?? '');
      if (c.ok && body.includes(String(m.old))) {
        await run('content', 'save', { id: src2.post, content: body.replace(String(m.old), String(m.text)) }, { auto: true });

        return;
      }
    }
    toast.error(t('This text is not stored in the page or builder. Change it in its source (theme or plugin) or restyle it.', 'این متن در صفحه یا صفحه‌ساز ذخیره نیست. از منبعش (قالب یا افزونه) عوضش کنید یا فقط استایلش را تغییر دهید.'));
    setNonce((n) => n + 1);
  }, [builderOf, run, t]);

  useEffect(() => {
    const on = (e: MessageEvent): void => {
      const m = e.data;
      if (!m?.wpm || e.source !== frame.current?.contentWindow) return;
      if (m.type === 'ready') { send({ type: 'tree' }); live(ov); }
      else if (m.type === 'selected' || m.type === 'refreshed') { setInfo(m.info); if (m.type === 'selected') setSelIndex(0); }
      else if (m.type === 'tree') setTree(m.tree);
      else if (m.type === 'text-edited') void saveText(m);
    };
    addEventListener('message', on);

    return () => removeEventListener('message', on);
  }, [send, live, ov, saveText]);

  /* style editing */
  const value = (prop: string): string => ov[media]?.[sel]?.[prop] ?? '';
  const setProp = (prop: string, v: string): void => {
    if (!sel) return;
    const next: Overrides = structuredClone(ov);
    const rules = ((next[media] ??= {})[sel] ??= {});
    if (v === '') delete rules[prop]; else rules[prop] = v;
    setOv(next); setDirty(true); live(next); send({ type: 'reselect' });
  };
  const saveCss = async (): Promise<void> => {
    const r = await run('design', 'css_set', { css: overridesToCss(ov), section: OVERRIDE_SECTION, mode: 'replace' }, { auto: true });
    if (r.ok) { setDirty(false); css.reload(); }
  };

  /* builder editing */
  const afterBuilder = (): void => { setBTree(null); setNonce((n) => n + 1); };
  const applySettings = async (): Promise<void> => {
    if (!source?.post || !hit) return;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(settings)) {
      const before = typeof hit.node.settings?.[k] === 'string' ? hit.node.settings[k] : JSON.stringify(hit.node.settings?.[k]);
      if (v === before) continue;
      try { patch[k] = typeof hit.node.settings?.[k] === 'string' ? v : JSON.parse(v); } catch { toast.error(`${k}: invalid JSON`); return; }
    }
    if (!Object.keys(patch).length) return;
    const r = await run('builder', 'element_update', { id: source.post, element: source.element, settings: patch }, { auto: true });
    if (r.ok) afterBuilder();
  };
  const removeElement = async (): Promise<void> => {
    if (!source?.post || !confirm(t('Remove this element and everything inside it?', 'این عنصر و هرچه داخلش است حذف شود؟'))) return;
    const r = await run('builder', 'element_remove', { id: source.post, element: source.element });
    if (r.ok) afterBuilder();
  };
  const insert = async (inside: boolean): Promise<void> => {
    if (!source?.post || !hit) return;
    const element = structuredClone(NEW_ELEMENT[source.builder]?.[kind]);
    if (!element) return;
    const args: Record<string, unknown> = { id: source.post, element };
    if (inside) args.parent = source.element;
    else { if (hit.parent) args.parent = hit.parent.id; args.position = hit.index + 1; }
    const r = await run('builder', 'element_add', args);
    if (r.ok) afterBuilder();
  };

  const isContainer = !!source && source.elType !== 'widget';
  const matched: any[] = info?.rules ?? [];

  return (
    <div className="-m-4 flex h-[calc(100svh-3.5rem)] flex-col md:-m-8">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="w-56"><Pick size="sm" value={url} onChange={setUrl} options={[{ value: site?.url ?? '', label: t('Home', 'صفحهٔ اصلی') }, ...((pages.data?.items ?? pages.data?.posts ?? []) as any[]).filter((p) => p.url && p.url !== site?.url).map((p) => ({ value: p.url as string, label: p.title as string }))]} /></div>
        <div className="flex rounded-lg border p-0.5">
          {[MonitorIcon, TabletIcon, SmartphoneIcon].map((Icon, i) => <Button key={i} size="icon-sm" variant={device === i ? 'secondary' : 'ghost'} aria-label={DEVICES[i].key} onClick={() => setDevice(i)}><Icon /></Button>)}
        </div>
        <Button size="sm" variant="outline" onClick={() => setNonce((n) => n + 1)}><RefreshCwIcon /> {t('Reload', 'بارگذاری مجدد')}</Button>
        <span className="hidden items-center gap-1 text-xs text-muted-foreground lg:flex"><MousePointerClickIcon className="size-3.5" /> {t('Click to select, double-click text to edit it', 'کلیک برای انتخاب، دوبار کلیک روی متن برای ویرایش')}</span>
        <Button size="sm" className="ms-auto" disabled={!dirty} onClick={() => void saveCss()}><SaveIcon /> {t('Save styles', 'ذخیرهٔ استایل‌ها')}{dirty ? ' •' : ''}</Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[230px_1fr_330px]">
        <aside className="hidden overflow-auto border-e p-2 lg:block">
          <div className="px-1 pb-1 text-xs font-medium text-muted-foreground">{t('Layers', 'لایه‌ها')}</div>
          {tree ? <Layer n={tree} sel={info?.id ?? 0} pick={(id) => send({ type: 'select', id })} depth={0} /> : <p className="p-2 text-xs text-muted-foreground">…</p>}
        </aside>

        <div className="min-h-0 overflow-auto bg-muted/40 p-3">
          <iframe ref={frame} key={src} src={src} title="preview" className="mx-auto h-full min-h-[480px] rounded-lg border bg-white shadow-sm" style={{ width: DEVICES[device].width }} />
        </div>

        <aside className="min-h-0 overflow-auto border-s p-3">
          {!info ? <p className="text-sm text-muted-foreground">{t('Select an element in the page.', 'یک عنصر را در صفحه انتخاب کنید.')}</p> : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <code dir="ltr" className="truncate rounded bg-muted px-1.5 py-0.5 text-xs">{info.label}</code>
                {source?.builder && <Badge variant="secondary">{source.builder}{source.widget ? ` · ${source.widget.split('.')[0]}` : ''}</Badge>}
                <span className="text-xs text-muted-foreground">{info.rect.w}×{info.rect.h}</span>
              </div>
              <Tabs defaultValue="style">
                <TabsList className="w-full">
                  <TabsTrigger value="style">{t('Style', 'استایل')}</TabsTrigger>
                  <TabsTrigger value="content">{t('Content', 'محتوا')}</TabsTrigger>
                  <TabsTrigger value="rules">{t('Rules', 'قواعد')}</TabsTrigger>
                </TabsList>

                <TabsContent value="style" className="space-y-3 pt-3">
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">{t('Applies to (class or path)', 'اعمال روی (کلاس یا مسیر)')}</div>
                    <Pick size="sm" value={String(selIndex)} onChange={(v) => setSelIndex(Number(v))} options={(info.selectors as string[]).map((s, i) => ({ value: String(i), label: `${s}  ·  ${info.counts?.[i] ?? '?'}×` }))} />
                    <p className="text-xs text-muted-foreground">{t('Pick a class to restyle every element that shares it, or a unique path for just this one. Works for plugin and theme output too.', 'یک کلاس را برای تغییر همهٔ عناصر هم‌کلاس انتخاب کنید یا یک مسیر یکتا برای همین یکی. روی خروجی افزونه‌ها و قالب هم کار می‌کند.')}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {PROPS.map(([prop, label]) => (
                      <label key={prop} className="space-y-0.5">
                        <span className="text-[11px] text-muted-foreground">{label}</span>
                        <Input dir="ltr" className="h-7 text-xs" value={value(prop)} placeholder={prop === 'padding' || prop === 'margin' || prop === 'border' ? '' : String(info.computed?.[prop] ?? '')} onChange={(e) => setProp(prop, e.target.value)} />
                      </label>
                    ))}
                  </div>
                  <div className="flex gap-1.5">
                    <Input dir="ltr" className="h-7 text-xs" placeholder="property" value={extra.prop} onChange={(e) => setExtra({ ...extra, prop: e.target.value })} />
                    <Input dir="ltr" className="h-7 text-xs" placeholder="value" value={extra.value} onChange={(e) => setExtra({ ...extra, value: e.target.value })} />
                    <Button size="sm" variant="outline" disabled={!extra.prop || !extra.value} onClick={() => { setProp(extra.prop.trim(), extra.value.trim()); setExtra({ prop: '', value: '' }); }}>+</Button>
                  </div>
                  {Object.entries(ov[media]?.[sel] ?? {}).filter(([k]) => !PROPS.some(([p]) => p === k)).map(([k, v]) => (
                    <div key={k} dir="ltr" className="flex items-center justify-between gap-2 rounded border px-2 py-1 font-mono text-xs"><span className="truncate">{k}: {v}</span><button onClick={() => setProp(k, '')} aria-label="remove"><Trash2Icon className="size-3" /></button></div>
                  ))}
                  {device > 0 && <p className="text-xs text-muted-foreground">{t('Editing the ', 'در حال ویرایش ')}{DEVICES[device].key}{t(' view only.', ' فقط.')}</p>}
                </TabsContent>

                <TabsContent value="content" className="space-y-3 pt-3">
                  {hit ? (
                    <>
                      {Object.entries(settings).map(([k, v]) => (
                        <label key={k} className="block space-y-0.5">
                          <span className="text-[11px] text-muted-foreground" dir="ltr">{k}</span>
                          <Textarea dir="ltr" rows={v.length > 80 || v.startsWith('{') || v.startsWith('[') ? 4 : 1} className="min-h-0 font-mono text-xs" value={v} onChange={(e) => setSettings({ ...settings, [k]: e.target.value })} />
                        </label>
                      ))}
                      {!Object.keys(settings).length && <p className="text-xs text-muted-foreground">{t('No custom settings on this element.', 'این عنصر تنظیم سفارشی ندارد.')}</p>}
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => void applySettings()}>{t('Apply', 'اعمال')}</Button>
                        <Button size="sm" variant="outline" onClick={() => void removeElement()}><Trash2Icon /> {t('Remove', 'حذف')}</Button>
                      </div>
                      <div className="space-y-1.5 border-t pt-3">
                        <div className="text-xs text-muted-foreground">{t('Add an element', 'افزودن عنصر')}</div>
                        <Pick size="sm" value={kind} onChange={setKind} options={Object.keys(NEW_ELEMENT[source!.builder] ?? {}).map((k) => ({ value: k, label: k }))} />
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" onClick={() => void insert(false)}>{t('After this', 'بعد از این')}</Button>
                          <Button size="sm" variant="outline" disabled={!isContainer} onClick={() => void insert(true)}>{t('Inside this', 'داخل این')}</Button>
                        </div>
                      </div>
                    </>
                  ) : source?.builder ? <p className="text-xs text-muted-foreground">{t('This element is not in the page’s own builder data (it may come from a template or header/footer). Restyle it, or open that template.', 'این عنصر در داده‌ی صفحه‌ساز خود صفحه نیست (شاید از تمپلیت یا هدر/فوتر باشد). استایلش را تغییر دهید یا آن تمپلیت را باز کنید.')}</p>
                    : <p className="text-xs text-muted-foreground">{t('Not made with a page builder. Double-click text in the page to edit it, or restyle it in the Style tab.', 'با صفحه‌ساز ساخته نشده. متن را با دوبار کلیک در صفحه ویرایش کنید یا در تب استایل ظاهرش را عوض کنید.')}</p>}
                </TabsContent>

                <TabsContent value="rules" className="space-y-2 pt-3">
                  {matched.length === 0 && <p className="text-xs text-muted-foreground">—</p>}
                  {matched.slice(0, 40).map((r) => (
                    <div key={r.id} dir="ltr" className="rounded border p-2 font-mono text-[11px]">
                      <div className="truncate font-semibold">{r.selector}</div>
                      <div className="truncate text-muted-foreground">{r.media} {String(r.source ?? '').split('/').slice(-2).join('/')}</div>
                      {(r.props as string[][]).slice(0, 8).map(([k, v]) => <div key={k}>{k}: {v}</div>)}
                    </div>
                  ))}
                </TabsContent>
              </Tabs>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
