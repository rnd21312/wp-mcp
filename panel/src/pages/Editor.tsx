import Editor, { type OnMount } from '@monaco-editor/react';
import { ArrowLeftIcon, CodeXmlIcon, ChevronDownIcon, ChevronRightIcon, FilePlusIcon, FileTextIcon, MonitorIcon, MousePointerClickIcon, PaletteIcon, RefreshCwIcon, SaveIcon, SmartphoneIcon, TabletIcon, XIcon, EyeIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Pick } from '@/components/bits';
import { Loading } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { languageOf } from '@/lib/monaco';
import { useI18n } from '@/lib/i18n';
import { useAction, useSite } from '@/lib/site';
import { OVERRIDE_SECTION, overridesToCss, parseOverrides, type Overrides } from '@/lib/visualCss';

interface Doc {
  key: string;
  kind: 'page' | 'template' | 'themefile' | 'css';
  label: string;
  language: string;
  value: string;
  original: string;
  ref: any;
}

const WIDTH: Record<string, string> = { desktop: '100%', tablet: '820px', mobile: '390px' };

function FileTree({ files, open, active }: { files: { path: string; bytes: number }[]; open: (p: string) => void; active: string }) {
  const tree = useMemo(() => {
    const root: any = { dirs: {}, files: [] };
    for (const f of files) {
      const parts = f.path.split('/');
      let n = root;
      for (const d of parts.slice(0, -1)) n = (n.dirs[d] ??= { dirs: {}, files: [] });
      n.files.push({ name: parts.at(-1)!, path: f.path });
    }
    return root;
  }, [files]);
  const [shut, setShut] = useState<Set<string>>(new Set());
  const render = (n: any, prefix: string, depth: number): any => (
    <>
      {Object.keys(n.dirs).sort().map((d) => {
        const key = `${prefix}${d}/`;
        const closed = shut.has(key);
        return (
          <div key={key}>
            <button className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-start text-xs hover:bg-muted" style={{ paddingInlineStart: depth * 10 + 4 }} onClick={() => setShut((s) => { const x = new Set(s); closed ? x.delete(key) : x.add(key); return x; })}>
              {closed ? <ChevronRightIcon className="size-3 rtl:rotate-180" /> : <ChevronDownIcon className="size-3" />}{d}
            </button>
            {!closed && render(n.dirs[d], key, depth + 1)}
          </div>
        );
      })}
      {n.files.sort((a: any, b: any) => a.name.localeCompare(b.name)).map((f: any) => (
        <button key={f.path} dir="ltr" onClick={() => open(f.path)} className={`flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-start text-xs hover:bg-muted ${active === `file:${f.path}` ? 'bg-muted font-medium' : ''}`} style={{ paddingInlineStart: depth * 10 + 18 }}>{f.name}</button>
      ))}
    </>
  );

  return <>{render(tree, '', 0)}</>;
}

const px = (v: string): string => v.replace('px', '');

function BoxModel({ box }: { box: any }) {
  const cell = (label: string, vals: string[], color: string, inner: any) => (
    <div className="relative rounded border border-dashed p-1.5 pt-4 text-center text-[10px]" style={{ background: color }}>
      <span className="absolute start-1.5 top-0.5 text-[9px] opacity-70">{label}</span>
      <div className="mb-0.5">{px(vals[0])}</div>
      <div className="flex items-center justify-between gap-1"><span>{px(vals[3])}</span>{inner}<span>{px(vals[1])}</span></div>
      <div className="mt-0.5">{px(vals[2])}</div>
    </div>
  );

  return (
    <div dir="ltr" className="mx-auto max-w-xs font-mono text-black">
      {cell('margin', box.margin, 'rgba(246,178,107,.55)', cell('border', box.border, 'rgba(255,229,153,.7)', cell('padding', box.padding, 'rgba(147,196,125,.6)', <div className="rounded bg-[rgba(111,168,220,.7)] px-2 py-1">{box.w} × {box.h}</div>)))}
    </div>
  );
}

function DomNode({ n, sel, pick, depth }: { n: any; sel: number; pick: (id: number) => void; depth: number }) {
  const [open, setOpen] = useState(depth < 2);

  return (
    <div>
      <div className={`flex items-center gap-0.5 rounded px-1 text-[11px] ${sel === n.id ? 'bg-amber-500/25' : 'hover:bg-muted'}`} style={{ paddingInlineStart: depth * 10 }}>
        <button className="size-4 text-muted-foreground" onClick={() => setOpen(!open)}>{n.kids.length ? open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3 rtl:rotate-180" /> : null}</button>
        <button dir="ltr" className="flex-1 truncate text-start font-mono" onClick={() => pick(n.id)}>{n.label}</button>
      </div>
      {open && n.kids.map((k: any) => <DomNode key={k.id} n={k} sel={sel} pick={pick} depth={depth + 1} />)}
    </div>
  );
}

export function CodeEditor({ go }: { go: (h: string) => void }) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const { run, site, state } = useSite();
  const pages = useAction<any>('content', 'list', { post_type: 'page', per_page: 100 });
  const posts = useAction<any>('content', 'list', { post_type: 'post', per_page: 40 });
  const templates = useAction<any>('design', 'templates_list');
  const files = useAction<any>('design', 'theme_files');
  const css = useAction<any>('design', 'css_get');

  const [docs, setDocs] = useState<Doc[]>([]);
  const [active, setActive] = useState('');
  const [ov, setOv] = useState<Overrides>({});
  const [bucket, setBucket] = useState('desktop');
  const [inspect, setInspect] = useState(true);
  const [seo, setSeo] = useState(false);
  const [pw, setPw] = useState(560);
  const [previewUrl, setPreviewUrl] = useState('');
  const [nonce, setNonce] = useState(0);
  const [ready, setReady] = useState(false);
  const [info, setInfo] = useState<any>(null);
  const [domTree, setDomTree] = useState<any>(null);
  const [filter, setFilter] = useState('');
  const [ws, setWs] = useState<any>(null);
  const [wsBusy, setWsBusy] = useState(false);
  const lastEvents = useRef(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const pendingReveal = useRef<string>('');
  const docsRef = useRef(docs);
  docsRef.current = docs;

  const doc = docs.find((d) => d.key === active) ?? null;
  const send = useCallback((m: Record<string, unknown>): void => { frame.current?.contentWindow?.postMessage({ wpm: 1, ...m }, '*'); }, []);

  /* the saved overrides of this site */
  useEffect(() => { setOv(parseOverrides(css.data?.sections?.[OVERRIDE_SECTION] ?? '')); }, [css.data]);

  /* messages from the page's inspector agent */
  useEffect(() => {
    const on = (e: MessageEvent): void => {
      if (e.source !== frame.current?.contentWindow || !e.data?.wpm) return;
      const m = e.data;
      if (m.type === 'ready') { setReady(true); send({ type: 'tree' }); }
      else if (m.type === 'tree') setDomTree(m.tree);
      else if (m.type === 'selected' || m.type === 'refreshed') setInfo(m.info);
    };
    addEventListener('message', on);
    return () => removeEventListener('message', on);
  }, [send]);

  useEffect(() => { if (ready) { send({ type: 'inspect', on: inspect }); send({ type: 'seo', on: seo }); } }, [inspect, seo, ready, send]);

  /* open documents of CSS kind are shown live in the page */
  useEffect(() => {
    if (!ready) return;
    for (const d of docs) {
      if (d.kind === 'css') send({ type: 'css-live', key: d.key, css: d.value });
      else if (d.kind === 'themefile' && d.language === 'css' && d.value !== d.original) send({ type: 'css-replace', match: d.ref.path.split('/').pop(), css: d.value });
    }
  }, [docs, ready, send]);

  const setPage = (url: string): void => { setReady(false); setInfo(null); setDomTree(null); setPreviewUrl(url); setNonce((n) => n + 1); };
  useEffect(() => { if (site && !previewUrl) setPage(site.url); }, [site?.url]);

  const src = previewUrl ? `${state.preview.base}/page?u=${encodeURIComponent(previewUrl)}&t=${state.preview.token}&n=${nonce}` : '';

  /* ------------------------------------------------------------ documents */
  const addDoc = (d: Doc): void => { setDocs((all) => (all.some((x) => x.key === d.key) ? all : [...all, d])); setActive(d.key); };

  const openPage = async (p: any): Promise<void> => {
    const r = await run<any>('content', 'get', { id: p.id }, { quiet: true });
    if (!r.ok) return;
    addDoc({ key: `page:${p.id}`, kind: 'page', label: r.data.title || `#${p.id}`, language: 'html', value: r.data.content, original: r.data.content, ref: { id: p.id, type: r.data.type, status: r.data.status, url: p.url } });
    setPage(p.url);
  };
  const openTemplate = async (x: any): Promise<void> => {
    const r = await run<any>('design', 'template_get', { slug: x.slug, kind: x.kind }, { quiet: true });
    if (r.ok) addDoc({ key: `tpl:${x.kind}:${x.slug}`, kind: 'template', label: x.title || x.slug, language: 'html', value: r.data.content, original: r.data.content, ref: x });
  };
  const openFile = async (path: string): Promise<void> => {
    const r = await run<any>('design', 'theme_file_read', { path }, { quiet: true });
    if (r.ok) addDoc({ key: `file:${path}`, kind: 'themefile', label: path.split('/').pop()!, language: languageOf(path), value: r.data.content, original: r.data.content, ref: { path } });
  };
  const openCss = (section: string): void => {
    const text = section === OVERRIDE_SECTION ? overridesToCss(ov) : (css.data?.sections?.[section] ?? '');
    addDoc({ key: `css:${section}`, kind: 'css', label: `CSS · ${section}`, language: 'css', value: text, original: css.data?.sections?.[section] ?? '', ref: { section } });
  };
  const newPage = async (): Promise<void> => {
    const title = prompt(t('Page title', 'عنوان صفحه'));
    if (!title) return;
    const r = await run<any>('content', 'save', { post_type: 'page', title, status: 'draft', content: `<!-- wp:heading -->\n<h2>${title}</h2>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph -->\n<p></p>\n<!-- /wp:paragraph -->` });
    if (r.ok) { pages.reload(); await openPage({ id: r.data.id, url: r.data.url }); }
  };

  const save = async (d: Doc | null = doc): Promise<void> => {
    if (!d) return;
    let ok = false;
    if (d.kind === 'page') ok = (await run('content', 'save', { id: d.ref.id, content: d.value, status: d.ref.status }, { auto: true })).ok;
    else if (d.kind === 'template') ok = (await run('design', 'template_save', { slug: d.ref.slug, kind: d.ref.kind, content: d.value }, { auto: true })).ok;
    else if (d.kind === 'themefile') ok = (await run('design', 'theme_file_write', { path: d.ref.path, content: d.value }, { auto: true })).ok;
    else ok = (await run('design', 'css_set', { css: d.value, section: d.ref.section, mode: 'replace' }, { auto: true })).ok;
    if (ok) {
      setDocs((all) => all.map((x) => (x.key === d.key ? { ...x, original: x.value } : x)));
      if (d.kind === 'css') css.reload(); else setNonce((n) => n + 1);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  const onMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;
    monacoRef.current = monaco;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
    if (pendingReveal.current) { reveal(pendingReveal.current); pendingReveal.current = ''; }
  };

  const reveal = (query: string): boolean => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!model || !query) return false;
    const m = model.findMatches(query, true, false, false, null, false)[0];
    if (!m) return false;
    ed.setSelection(m.range);
    ed.revealLineInCenter(m.range.startLineNumber);
    ed.focus();

    return true;
  };

  const openSource = async (source: string, selector: string): Promise<void> => {
    const list: { path: string }[] = files.data?.files ?? [];
    const hit = list.find((f) => source.includes(`/${f.path}`));
    if (hit) { pendingReveal.current = selector.split(',')[0].trim(); await openFile(hit.path); setTimeout(() => { if (pendingReveal.current) { reveal(pendingReveal.current); pendingReveal.current = ''; } }, 400); return; }
    if (source.includes('wpm-css') || source === 'inline <style>') { openCss(OVERRIDE_SECTION); return; }
    toast.info(source);
  };

  /* -------------------------------------------------------- inspector edits */
  const setRuleProp = (rule: any, prop: string, value: string): void => {
    send({ type: 'edit-rule', id: rule.id, prop, value });
    const media = rule.media ? rule.media : '';
    setOv((o) => {
      const next: Overrides = JSON.parse(JSON.stringify(o));
      const m = (next[media] ??= {});
      const r = (m[rule.selector] ??= {});
      if (value === '') delete r[prop]; else r[prop] = value;
      if (!Object.keys(r).length) delete m[rule.selector];
      const text = overridesToCss(next);
      setDocs((all) => {
        const key = `css:${OVERRIDE_SECTION}`;
        const exists = all.some((d) => d.key === key);
        return exists ? all.map((d) => (d.key === key ? { ...d, value: text } : d)) : [...all, { key, kind: 'css', label: `CSS · ${OVERRIDE_SECTION}`, language: 'css', value: text, original: css.data?.sections?.[OVERRIDE_SECTION] ?? '', ref: { section: OVERRIDE_SECTION } }];
      });
      return next;
    });
  };

  const applyText = (text: string): void => {
    if (!info) return;
    const old: string = info.text;
    send({ type: 'set-text', id: info.id, text });
    const d = docs.find((x) => x.kind === 'page') ?? doc;
    if (!d || d.kind === 'css') { toast.error(t('Open the page in the editor first.', 'اول صفحه را در ویرایشگر باز کنید.')); return; }
    const idx = d.value.indexOf(old);
    if (idx < 0) { toast.error(t('This text is not in the page code (it may come from a template or the theme).', 'این متن در کد صفحه نیست (شاید از قالب یا پوسته باشد).')); return; }
    setDocs((all) => all.map((x) => (x.key === d.key ? { ...x, value: x.value.slice(0, idx) + text + x.value.slice(idx + old.length) } : x)));
    setActive(d.key);
    toast.success(t('Changed in the code. Press Ctrl+S to save.', 'در کد تغییر کرد. برای ذخیره Ctrl+S بزنید.'));
  };

  const drag = (e: React.PointerEvent): void => {
    const startX = e.clientX;
    const start = pw;
    const rtl = document.documentElement.dir === 'rtl';
    const move = (ev: PointerEvent): void => setPw(Math.max(320, Math.min(window.innerWidth - 420, start + (rtl ? 1 : -1) * (ev.clientX - startX))));
    const up = (): void => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  /* VS Code workspace: the theme as local files, live sync back to the site */
  useEffect(() => {
    if (!site) return;
    let alive = true;
    const poll = async (): Promise<void> => {
      const r = await fetch(`/admin/api/ws/status?site=${encodeURIComponent(site.name)}`, { headers: { 'x-wpm-panel': '1' } }).then((x) => x.json()).catch(() => null);
      if (!alive || !r) return;
      setWs(r);
      if (r.events.length > lastEvents.current) { if (lastEvents.current) setNonce((n) => n + 1); lastEvents.current = r.events.length; }
    };
    void poll();
    const id = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(id); };
  }, [site?.name]);

  const openVsCode = async (): Promise<void> => {
    if (!site) return;
    setWsBusy(true);
    const pulled = await api.post<any>('ws/pull', { site: site.name });
    if (pulled.ok === false) { toast.error(pulled.error?.message ?? 'Failed'); setWsBusy(false); return; }
    const o = await api.post<any>('ws/open', { site: site.name });
    setWsBusy(false);
    toast.success(t(`Theme "${pulled.theme}" (${pulled.files} files) is in ${o.dir}`, `پوسته‌ی «${pulled.theme}» (${pulled.files} فایل) در ${o.dir} است`), { description: t('VS Code is opening. Turn on Live sync to push every save to the site.', 'VS Code باز می‌شود. برای ارسال هر ذخیره به سایت، همگام‌سازی زنده را روشن کنید.'), action: { label: 'vscode://', onClick: () => { location.href = o.vscodeUrl; } } });
    setWs(await fetch(`/admin/api/ws/status?site=${encodeURIComponent(site.name)}`, { headers: { 'x-wpm-panel': '1' } }).then((x) => x.json()));
  };

  const dirty = (d: Doc): boolean => d.value !== d.original;
  const items: any[] = [...(pages.data?.items ?? []), ...(posts.data?.items ?? [])];

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Button variant="ghost" size="sm" onClick={() => go('#/')}><ArrowLeftIcon className="rtl:rotate-180" /> {t('Panel', 'پنل')}</Button>
        <span className="text-sm font-medium">{site?.name}</span>
        <span className="text-xs text-muted-foreground">· {t('Code & visual editor', 'ویرایشگر کد و بصری')}</span>
        <div className="ms-auto flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={wsBusy} onClick={openVsCode}><CodeXmlIcon /> {t('Open in VS Code', 'باز کردن در VS Code')}</Button>
          {ws?.pulled && <label className="flex items-center gap-1.5 text-xs" title={ws.dir}><Switch checked={!!ws.watching} onCheckedChange={async (on) => setWs({ ...ws, ...(await api.post<any>('ws/watch', { site: site!.name, on })) })} />{t('Live sync', 'همگام‌سازی زنده')}{ws.events[0] && <Badge variant="secondary" className={ws.events[0].ok ? '' : 'bg-rose-500/15 text-rose-700 dark:text-rose-300'}>{ws.events[0].path.split('/').pop()} {ws.events[0].ok ? '✓' : '✗'}</Badge>}</label>}
          <Button size="sm" disabled={!doc || !dirty(doc)} onClick={() => save()}><SaveIcon /> {t('Save', 'ذخیره')} <kbd className="ms-1 rounded border px-1 text-[10px]">Ctrl+S</kbd></Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* explorer */}
        <aside className="hidden w-60 shrink-0 overflow-auto border-e p-2 lg:block">
          <div className="mb-1 flex items-center justify-between px-1 text-xs font-semibold text-muted-foreground">{t('Pages & posts', 'برگه‌ها و نوشته‌ها')}<button onClick={newPage} title={t('New page', 'برگه‌ی جدید')}><FilePlusIcon className="size-3.5" /></button></div>
          <div className="mb-3 max-h-56 overflow-auto">{items.map((p) => <button key={p.id} onClick={() => openPage(p)} className={`flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-start text-xs hover:bg-muted ${active === `page:${p.id}` ? 'bg-muted font-medium' : ''}`}><FileTextIcon className="size-3 shrink-0 opacity-60" /><span className="truncate">{p.title}</span>{p.status !== 'publish' && <Badge variant="outline" className="ms-auto text-[9px]">{p.status}</Badge>}</button>)}</div>
          {templates.data?.block_theme && (<><div className="mb-1 px-1 text-xs font-semibold text-muted-foreground">{t('Templates & parts', 'قالب‌ها و بخش‌ها')}</div><div className="mb-3">{(templates.data.templates ?? []).map((x: any) => <button key={`${x.kind}${x.slug}`} onClick={() => openTemplate(x)} className={`flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-start text-xs hover:bg-muted ${active === `tpl:${x.kind}:${x.slug}` ? 'bg-muted font-medium' : ''}`}><span className="truncate">{x.title || x.slug}</span><Badge variant="outline" className="ms-auto text-[9px]">{x.kind === 'part' ? x.area || 'part' : 'tpl'}</Badge></button>)}</div></>)}
          <div className="mb-1 flex items-center justify-between px-1 text-xs font-semibold text-muted-foreground">CSS<button onClick={() => { const n = prompt(t('Section name', 'نام بخش'))?.toLowerCase().replace(/[^a-z0-9_-]/g, ''); if (n) openCss(n); }}><FilePlusIcon className="size-3.5" /></button></div>
          <div className="mb-3">{Array.from(new Set([OVERRIDE_SECTION, ...Object.keys(css.data?.sections ?? {})])).map((s) => <button key={s} onClick={() => openCss(s)} className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-start text-xs hover:bg-muted ${active === `css:${s}` ? 'bg-muted font-medium' : ''}`}><PaletteIcon className="size-3 opacity-60" />{s}</button>)}</div>
          <div className="mb-1 px-1 text-xs font-semibold text-muted-foreground">{t('Theme files', 'فایل‌های پوسته')}</div>
          {files.loading && !files.data ? <Loading /> : files.error ? <p className="px-1 text-xs text-muted-foreground">{files.error}</p> : <FileTree files={files.data?.files ?? []} open={openFile} active={active} />}
        </aside>

        {/* code */}
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 overflow-x-auto border-b bg-muted/30">
            {docs.map((d) => (
              <div key={d.key} className={`flex items-center gap-2 border-e px-3 py-1.5 text-xs ${active === d.key ? 'bg-background font-medium' : 'text-muted-foreground'}`}>
                <button onClick={() => setActive(d.key)} className="max-w-40 truncate">{d.label}{dirty(d) && ' ●'}</button>
                <button onClick={() => { setDocs((all) => all.filter((x) => x.key !== d.key)); if (active === d.key) setActive(docs.find((x) => x.key !== d.key)?.key ?? ''); }}><XIcon className="size-3" /></button>
              </div>
            ))}
          </div>
          <div className="min-h-0 flex-1" dir="ltr">
            {doc ? (
              <Editor path={doc.key} language={doc.language} value={doc.value} theme={resolvedTheme === 'dark' ? 'vs-dark' : 'light'} onMount={onMount} onChange={(v) => setDocs((all) => all.map((x) => (x.key === doc.key ? { ...x, value: v ?? '' } : x)))} options={{ fontSize: 13, minimap: { enabled: false }, wordWrap: 'on', tabSize: 2, automaticLayout: true, scrollBeyondLastLine: false, formatOnPaste: true, padding: { top: 8 }, bracketPairColorization: { enabled: true } }} />
            ) : (
              <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground" dir="auto"><div><FileTextIcon className="mx-auto mb-2 size-8 opacity-40" />{t('Open a page, template, CSS section or theme file from the left. CSS changes show in the preview instantly; Ctrl+S saves to the site.', 'یک برگه، قالب، بخش CSS یا فایل پوسته را از سمت چپ باز کنید. تغییر CSS فوراً در پیش‌نمایش دیده می‌شود؛ Ctrl+S روی سایت ذخیره می‌کند.')}</div></div>
            )}
          </div>
        </section>

        <div onPointerDown={drag} className="hidden w-1.5 shrink-0 cursor-col-resize bg-border/60 hover:bg-primary/50 md:block" />

        {/* preview + inspector */}
        <section className="hidden shrink-0 flex-col md:flex" style={{ width: pw }}>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b p-1.5">
            <div className="w-44"><Pick size="sm" value={previewUrl || '-'} onChange={(u) => u !== '-' && setPage(u)} options={[{ value: site?.url ?? '-', label: t('Home page', 'صفحه‌ی اصلی') }, ...items.filter((p) => p.status === 'publish').map((p) => ({ value: p.url, label: p.title }))]} /></div>
            <div className="flex rounded-lg border p-0.5">{([['desktop', MonitorIcon], ['tablet', TabletIcon], ['mobile', SmartphoneIcon]] as const).map(([b, Icon]) => <Button key={b} variant={bucket === b ? 'secondary' : 'ghost'} size="icon-xs" onClick={() => setBucket(b)}><Icon /></Button>)}</div>
            <Button variant={inspect ? 'secondary' : 'ghost'} size="icon-xs" title={t('Inspect', 'بازرسی')} onClick={() => setInspect(!inspect)}><MousePointerClickIcon /></Button>
            <Button variant={seo ? 'secondary' : 'ghost'} size="icon-xs" title={t('SEO overlay', 'نمایش سئو')} onClick={() => setSeo(!seo)}><EyeIcon /></Button>
            <Button variant="ghost" size="icon-xs" title={t('Reload', 'بارگذاری مجدد')} onClick={() => setPage(previewUrl)}><RefreshCwIcon /></Button>
          </div>
          <div className="min-h-0 flex-[3] overflow-auto bg-muted/30 p-1.5">
            {src ? <iframe ref={frame} key={nonce} title="preview" src={src} className="mx-auto h-full rounded border bg-white" style={{ width: WIDTH[bucket], minHeight: 320 }} /> : <Loading />}
          </div>

          <div className="flex min-h-0 flex-[2] flex-col border-t">
            <Tabs defaultValue="styles" className="flex min-h-0 flex-1 flex-col">
              <TabsList className="m-1.5 w-fit"><TabsTrigger value="styles">{t('Styles', 'استایل')}</TabsTrigger><TabsTrigger value="computed">{t('Computed', 'محاسبه‌شده')}</TabsTrigger><TabsTrigger value="box">{t('Box', 'باکس')}</TabsTrigger><TabsTrigger value="dom">DOM</TabsTrigger></TabsList>
              {!info && <p className="p-4 text-center text-xs text-muted-foreground">{t('Click an element in the preview.', 'روی یک المان در پیش‌نمایش کلیک کنید.')}</p>}
              {info && (
                <div className="min-h-0 flex-1 overflow-auto px-2 pb-2" dir="ltr">
                  <div className="mb-2 flex flex-wrap items-center gap-1 text-xs"><Badge variant="outline" className="font-mono">{info.label}</Badge><span className="text-muted-foreground">{info.rect.w} × {info.rect.h}</span>{info.selectors[0] && <button className="rounded border px-1.5 font-mono text-[10px] hover:bg-muted" onClick={() => { if (!reveal(info.selectors[0].replace(/^[#.]/, '')) && !reveal(info.selectors[0])) toast.info(t('Not found in the open file', 'در فایل باز پیدا نشد')); }}>{info.selectors[0]}</button>}</div>
                  <TabsContent value="styles" className="space-y-2">
                    {info.inline && <div className="rounded border p-2 font-mono text-[11px]"><div className="text-muted-foreground">element.style</div>{info.inline}</div>}
                    {info.rules.map((r: any) => (
                      <div key={r.id} className="rounded border p-2 font-mono text-[11px]">
                        <div className="mb-1 flex items-center justify-between gap-2"><button className="truncate text-start text-sky-600 hover:underline dark:text-sky-400" onClick={() => openSource(r.source ?? '', r.selector)}>{r.selector}</button><span className="max-w-32 truncate text-[10px] text-muted-foreground" title={r.source}>{(r.source ?? '').split('/').pop()}</span></div>
                        {r.media && <div className="mb-1 text-[10px] text-amber-600">{r.media}</div>}
                        {r.props.map(([p, v, imp]: [string, string, string]) => (
                          <div key={p} className="flex items-center gap-1"><span className="text-rose-600 dark:text-rose-400">{p}</span>:<Input className="h-5 flex-1 border-0 bg-transparent px-1 font-mono text-[11px] shadow-none focus-visible:ring-1" defaultValue={v + (imp ? ' !important' : '')} onBlur={(e) => { const nv = e.target.value.replace(/\s*!important\s*$/, ''); if (nv !== v) setRuleProp(r, p, nv); }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} /></div>
                        ))}
                      </div>
                    ))}
                    {info.rules.length === 0 && <p className="text-xs text-muted-foreground">{t('No readable rules (inline styles or cross-origin sheets).', 'قاعده‌ی خواندنی نیست (استایل درون‌خطی یا شیت خارجی).')}</p>}
                  </TabsContent>
                  <TabsContent value="computed">
                    <Input className="mb-2 h-7 text-xs" placeholder="filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
                    {Object.entries<string>(info.computed).filter(([k, v]) => v && k.includes(filter)).map(([k, v]) => <div key={k} className="flex justify-between gap-3 border-b py-0.5 font-mono text-[11px]"><span className="text-rose-600 dark:text-rose-400">{k}</span><span className="truncate">{v}</span></div>)}
                  </TabsContent>
                  <TabsContent value="box"><BoxModel box={info.box} />
                    {info.leaf && <div className="mt-3 space-y-1"><div className="text-xs font-medium">{t('Text', 'متن')}</div><textarea dir="auto" className="w-full rounded border bg-background p-2 text-xs" rows={3} defaultValue={info.text} id="wpm-text" /><Button size="xs" onClick={() => applyText((document.getElementById('wpm-text') as HTMLTextAreaElement).value)}>{t('Apply in code', 'اعمال در کد')}</Button></div>}
                    <div className="mt-3 space-y-0.5 font-mono text-[10px] text-muted-foreground">{Object.entries<string>(info.attrs).map(([k, v]) => <div key={k} className="truncate">{k}="{v}"</div>)}</div>
                  </TabsContent>
                  <TabsContent value="dom">{domTree ? <DomNode n={domTree} sel={info.id} pick={(id) => send({ type: 'select', id })} depth={0} /> : <Loading />}</TabsContent>
                </div>
              )}
              {!info && <TabsContent value="dom" className="min-h-0 flex-1 overflow-auto px-2" dir="ltr">{domTree ? <DomNode n={domTree} sel={0} pick={(id) => send({ type: 'select', id })} depth={0} /> : null}</TabsContent>}
            </Tabs>
          </div>
        </section>
      </div>
    </div>
  );
}
