import { CheckIcon, Loader2Icon, RocketIcon, RotateCwIcon, SparklesIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Empty, PageTitle, Pick } from '@/components/bits';
import { Field, Loading } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useStudio } from '@/pages/Hosts';

const STAGES = ['plan', 'design', 'pages', 'images', 'seo', 'audit'] as const;
type Stage = (typeof STAGES)[number];

interface PageDetail { slug: string; title: string; status: 'missing' | 'pending' | 'review' | 'approved'; revision: number }
interface Issue { level: 'error' | 'warn'; page: string; rule: string; message: string }
interface BState {
  project: string;
  stages: Record<Stage, 'pending' | 'review' | 'approved'>;
  plan?: { site_name: string; tagline: string; language: string; rtl: boolean; tone: string; audience: string; pages: { slug: string; title: string; purpose: string; sections: string[]; seo_title: string; seo_description: string }[]; footer_note: string };
  tokens?: { palette: Record<string, string>; fonts: { heading: string; body: string }; radius: number; maxWidth: number };
  images?: { file: string; page: string; alt: string; prompt: string }[];
  audit?: { issues: Issue[]; errors: number; warnings: number; score: number };
  pages_detail: PageDetail[];
}

const LABELS: Record<Stage, [string, string]> = {
  plan: ['Sitemap', 'نقشه‌ی سایت'],
  design: ['Design', 'طراحی'],
  pages: ['Pages', 'صفحه‌ها'],
  images: ['Images', 'تصاویر'],
  seo: ['SEO', 'سئو'],
  audit: ['Checks', 'بررسی نهایی'],
};

function Preview({ project, slug }: { project: string; slug: string }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    void api.post<any>('builder/preview', { project, slug }).then((r) => r.ok && setHtml(r.html));
  }, [project, slug]);

  // sandbox="" : no scripts, no forms, no navigation. Only a picture of the page.
  return <iframe title={slug} sandbox="" srcDoc={html} className="h-[28rem] w-full rounded-lg border bg-white" />;
}

function PageRow({ project, p, reload, busy, run }: { project: string; p: PageDetail; reload: () => Promise<void>; busy: boolean; run: (body: Record<string, unknown>) => Promise<void> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  const approve = async (edit?: string): Promise<void> => {
    const r = await api.post<any>('builder/approve', { project, stage: 'pages', slug: p.slug, edit });
    r.ok ? (setEditing(null), await reload()) : toast.error(r.error?.message ?? 'error');
  };

  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{p.title} <span className="text-muted-foreground" dir="ltr">({p.slug})</span></span>
        <span className="flex items-center gap-2">
          <span className={p.status === 'approved' ? 'text-green-600' : 'text-muted-foreground'}>{p.status === 'approved' ? t('Approved', 'تأیید شد') : p.status === 'review' ? t('Waiting for you', 'منتظر شما') : t('Not written', 'نوشته نشده')}</span>
          {p.status === 'missing' || p.status === 'pending' ? <Button size="sm" disabled={busy} onClick={() => run({ stage: 'pages', slug: p.slug })}>{t('Write', 'بنویس')}</Button> : <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>{open ? t('Hide', 'بستن') : t('Review', 'بازبینی')}</Button>}
        </span>
      </div>
      {open && (
        <div className="mt-3 space-y-3">
          <Preview key={p.revision} project={project} slug={p.slug} />
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <Input placeholder={t('What should change? (optional)', 'چه چیزی تغییر کند؟ (اختیاری)')} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
            <Button variant="outline" disabled={busy || !feedback} onClick={() => run({ stage: 'pages', slug: p.slug, feedback }).then(() => setFeedback(''))}><RotateCwIcon /> {t('Rewrite this page', 'بازنویسی این صفحه')}</Button>
          </div>
          {editing !== null ? (
            <div className="space-y-2">
              <Textarea dir="ltr" className="h-64 font-mono text-xs" value={editing} onChange={(e) => setEditing(e.target.value)} />
              <Button size="sm" onClick={() => approve(editing)}><CheckIcon /> {t('Save my edit and approve', 'ذخیره‌ی ویرایش من و تأیید')}</Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={async () => { const r = await api.post<any>('builder/page', { project, slug: p.slug }); if (r.ok) setEditing(r.main); }}>{t('Edit the HTML', 'ویرایش HTML')}</Button>
              {p.status !== 'approved' && <Button size="sm" onClick={() => approve()}><CheckIcon /> {t('Approve this page', 'تأیید این صفحه')}</Button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Wizard({ project, hosts, onBack }: { project: string; hosts: string[]; onBack: () => void }) {
  const { t } = useI18n();
  const [s, setS] = useState<BState | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [json, setJson] = useState<string | null>(null);
  const [pub, setPub] = useState({ host: hosts[0] ?? '', folder: project, url: '' });

  const reload = useCallback(async () => {
    const r = await api.post<any>('builder/state', { project });
    if (r.ok) setS(r.state);
  }, [project]);
  useEffect(() => { void reload(); }, [reload]);

  const run = async (body: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    const r = await api.post<any>('builder/run', { project, ...body }).catch(() => ({ ok: false, error: { message: 'The request failed.' } }));
    setBusy(false);
    r.ok ? setS(r.state) : toast.error(r.error?.message ?? 'error');
    setFeedback('');
  };

  const approve = async (stage: Stage, edit?: unknown): Promise<void> => {
    const r = await api.post<any>('builder/approve', { project, stage, edit });
    if (r.ok) { setS(r.state); setJson(null); } else toast.error(r.error?.message ?? 'error');
  };

  const publish = async (): Promise<void> => {
    setBusy(true);
    const r = await api.post<any>('builder/publish', { project, ...pub });
    setBusy(false);
    r.ok ? toast.success(t(`Published as release ${r.release.id}`, `منتشر شد، نسخه‌ی ${r.release.id}`)) : toast.error(r.error?.message ?? 'error');
  };

  if (!s) return <Loading />;
  const current = STAGES.find((x) => s.stages[x] !== 'approved');
  const allDone = !current;

  const stageBox = (stage: Stage, body: React.ReactNode, allowEdit = false): React.ReactNode => {
    const st = s.stages[stage];
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t(...LABELS[stage])}</CardTitle>
          <CardDescription>{st === 'approved' ? t('Approved.', 'تأیید شد.') : st === 'review' ? t('Check it, ask for changes or approve to continue.', 'بررسی کنید، تغییر بخواهید یا برای ادامه تأیید کنید.') : t('Not made yet.', 'هنوز ساخته نشده.')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {body}
          {stage !== 'pages' && (
            <div className="space-y-2">
              {st !== 'pending' && <Input placeholder={t('What should change? (optional)', 'چه چیزی تغییر کند؟ (اختیاری)')} value={feedback} onChange={(e) => setFeedback(e.target.value)} />}
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} variant={st === 'pending' ? 'default' : 'outline'} onClick={() => run({ stage, feedback })}>{busy ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />} {st === 'pending' ? t('Make it', 'بساز') : t('Redo', 'دوباره بساز')}</Button>
                {allowEdit && st !== 'pending' && <Button variant="ghost" onClick={() => setJson(JSON.stringify(stage === 'plan' ? s.plan : s.tokens, null, 2))}>{t('Edit by hand', 'ویرایش دستی')}</Button>}
                {st === 'review' && <Button disabled={busy || (stage === 'audit' && (s.audit?.errors ?? 1) > 0)} onClick={() => approve(stage)}><CheckIcon /> {t('Approve', 'تأیید')}</Button>}
              </div>
              {json !== null && s.stages[stage] !== 'pending' && (
                <div className="space-y-2">
                  <Textarea dir="ltr" className="h-64 font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} />
                  <Button size="sm" onClick={() => { try { void approve(stage, JSON.parse(json)); } catch { toast.error(t('That is not valid JSON.', 'JSON معتبر نیست.')); } }}>{t('Save my edit and approve', 'ذخیره‌ی ویرایش من و تأیید')}</Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>← {t('All sites', 'همه‌ی سایت‌ها')}</Button>
        <strong dir="ltr">{project}</strong>
        <div className="ms-auto flex flex-wrap gap-1 text-xs">
          {STAGES.map((x) => <span key={x} className={`rounded-full px-2 py-1 ${s.stages[x] === 'approved' ? 'bg-green-100 text-green-800' : x === current ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>{t(...LABELS[x])}</span>)}
        </div>
      </div>
      {busy && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2Icon className="size-4 animate-spin" /> {t('The AI is working. This can take a minute…', 'هوش مصنوعی در حال کار است. ممکن است یک دقیقه طول بکشد…')}</p>}

      {stageBox('plan', s.plan && (
        <div className="space-y-2 text-sm">
          <p><strong>{s.plan.site_name}</strong> — {s.plan.tagline}</p>
          <div className="space-y-1">{s.plan.pages.map((p) => <div key={p.slug} className="rounded border p-2"><strong>{p.title}</strong> <span className="text-muted-foreground" dir="ltr">/{p.slug === 'index' ? '' : `${p.slug}.html`}</span><div className="text-muted-foreground">{p.purpose}</div><div className="text-xs">{p.sections.join(' · ')}</div></div>)}</div>
        </div>
      ), true)}

      {s.stages.plan === 'approved' && stageBox('design', s.tokens && (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap gap-2">{Object.entries(s.tokens.palette).map(([k, v]) => <div key={k} className="text-center text-xs"><div className="h-10 w-16 rounded border" style={{ background: v }} />{k}<div dir="ltr" className="text-muted-foreground">{v}</div></div>)}</div>
          <p className="text-muted-foreground">{s.tokens.fonts.heading} / {s.tokens.fonts.body} · radius {s.tokens.radius}px · {s.tokens.maxWidth}px</p>
        </div>
      ), true)}

      {s.stages.design === 'approved' && (
        <Card>
          <CardHeader>
            <CardTitle>{t(...LABELS.pages)}</CardTitle>
            <CardDescription>{t('Write each page, look at it, ask for changes or edit it, then approve it.', 'هر صفحه را بنویسید، ببینید، تغییر بخواهید یا ویرایش کنید و تأیید کنید.')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button disabled={busy || s.pages_detail.every((p) => p.status !== 'missing')} variant="outline" onClick={() => run({ stage: 'pages' })}><SparklesIcon /> {t('Write all missing pages', 'همه‌ی صفحه‌های ننوشته را بنویس')}</Button>
            {s.pages_detail.map((p) => <PageRow key={`${p.slug}-${p.revision}`} project={project} p={p} reload={reload} busy={busy} run={run} />)}
          </CardContent>
        </Card>
      )}

      {s.stages.pages === 'approved' && stageBox('images', s.images && (
        <div className="space-y-1 text-sm">
          <p className="text-muted-foreground">{t('Placeholders are in place. Replace the files in the project’s images folder (same names) with real pictures; the prompts below say what each should show.', 'جانشین‌ها گذاشته شد. فایل‌های پوشه‌ی images پروژه را (با همان نام) با تصویر واقعی عوض کنید؛ پرامپت‌ها می‌گویند هر تصویر چه باشد.')}</p>
          {s.images.map((i) => <div key={i.file} className="rounded border p-2"><code dir="ltr">{i.file}</code> — {i.prompt}</div>)}
        </div>
      ))}

      {s.stages.images === 'approved' && stageBox('seo', <p className="text-sm text-muted-foreground">{t('Titles, descriptions, canonical and social tags, sitemap.xml and robots.txt are generated from the approved plan.', 'عنوان، توضیحات، canonical، برچسب‌های شبکه‌ی اجتماعی، sitemap.xml و robots.txt از روی طرح تأییدشده ساخته می‌شود.')}</p>)}

      {s.stages.seo === 'approved' && stageBox('audit', s.audit && (
        <div className="space-y-2 text-sm">
          <p><strong>{t('Score', 'امتیاز')}: {s.audit.score}</strong> · {s.audit.errors} {t('errors', 'خطا')} · {s.audit.warnings} {t('warnings', 'هشدار')}</p>
          <div className="max-h-72 space-y-1 overflow-auto">{s.audit.issues.map((i, n) => <div key={n} className={`rounded border p-2 ${i.level === 'error' ? 'border-destructive/50' : ''}`}><span className={i.level === 'error' ? 'text-destructive' : 'text-amber-600'}>{i.level === 'error' ? t('Error', 'خطا') : t('Warning', 'هشدار')}</span> <code dir="ltr">{i.page}</code> — {i.message}</div>)}</div>
          {s.audit.errors > 0 && <p className="text-destructive">{t('Fix the errors (rewrite the pages concerned above), then run the checks again. You cannot publish with errors.', 'خطاها را برطرف کنید (صفحه‌های مربوط را بالا بازنویسی کنید) و بررسی را دوباره اجرا کنید. با خطا نمی‌توان منتشر کرد.')}</p>}
        </div>
      ))}

      {allDone && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><RocketIcon className="size-4" /> {t('Publish', 'انتشار')}</CardTitle>
            <CardDescription>{t('Everything was approved by you. Publishing sends the site to your host as a release you can roll back.', 'همه چیز را شما تأیید کرده‌اید. انتشار، سایت را به‌صورت نسخه‌ای قابل بازگشت به هاست می‌فرستد.')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {hosts.length === 0 ? <p className="text-sm text-muted-foreground">{t('Connect a host first (Hosts page).', 'اول یک هاست وصل کنید (صفحه‌ی هاست‌ها).')}</p> : (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t('Host', 'هاست')}><Pick value={pub.host} onChange={(host) => setPub({ ...pub, host })} options={hosts.map((h) => ({ value: h, label: h }))} /></Field>
                <Field label={t('Folder on the host', 'پوشه روی هاست')}><Input dir="ltr" value={pub.folder} onChange={(e) => setPub({ ...pub, folder: e.target.value })} /></Field>
                <Field label={t('Public address (optional)', 'نشانی عمومی (اختیاری)')}><Input dir="ltr" placeholder="https://" value={pub.url} onChange={(e) => setPub({ ...pub, url: e.target.value })} /></Field>
              </div>
            )}
            <Button disabled={busy || !pub.host} onClick={publish}><RocketIcon /> {t('Publish now', 'همین حالا منتشر کن')}</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function Builder() {
  const { t, lang } = useI18n();
  const { data } = useStudio();
  const [providers, setProviders] = useState<{ id: string; name: string; model: string }[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', brief: '', language: lang, tone: '', pages_hint: '', base_url: '', provider: '' });

  useEffect(() => {
    void api.get<{ providers: { id: string; name: string; model: string }[] }>('ai/providers').then((r) => {
      setProviders(r.providers);
      if (r.providers[0]) setForm((f) => (f.provider ? f : { ...f, provider: r.providers[0].id }));
    });
  }, []);

  if (!data) return <Loading />;
  const mine = data.projects.filter((p) => p.builder);
  if (selected) return <Wizard key={selected} project={selected} hosts={data.hosts.filter((h) => h.status !== 'error' || h.last_ok).map((h) => h.name)} onBack={() => setSelected('')} />;

  const start = async (): Promise<void> => {
    setBusy(true);
    const r = await api.post<any>('builder/start', form);
    setBusy(false);
    r.ok ? setSelected(r.project) : toast.error(r.error?.message ?? 'error');
  };

  return (
    <>
      <PageTitle title={t('AI site builder', 'سازنده‌ی سایت با هوش مصنوعی')} hint={t('Describe the site. The AI proposes, you approve each step: sitemap, design, pages, images, SEO, checks, publish.', 'سایت را توصیف کنید. هوش مصنوعی پیشنهاد می‌دهد و شما هر مرحله را تأیید می‌کنید: نقشه، طراحی، صفحه‌ها، تصاویر، سئو، بررسی و انتشار.')} />
      {mine.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-2">{mine.map((p) => <Button key={p.name} variant="outline" size="sm" onClick={() => setSelected(p.name)}>{p.name}</Button>)}</div>
      )}
      {providers.length === 0 ? (
        <Empty>{t('Add an AI provider first (AI assistant page): ChatGPT, Claude, Gemini, DeepSeek, Ollama and more work.', 'اول یک سرویس هوش مصنوعی اضافه کنید (صفحه‌ی دستیار AI): ChatGPT، Claude، Gemini، DeepSeek، Ollama و غیره.')}</Empty>
      ) : (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('Project name', 'نام پروژه')} hint="a-z 0-9 -"><Input dir="ltr" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label={t('AI provider', 'سرویس هوش مصنوعی')}><Pick value={form.provider} onChange={(provider) => setForm({ ...form, provider })} options={providers.map((p) => ({ value: p.id, label: `${p.name} (${p.model})` }))} /></Field>
            </div>
            <Field label={t('Describe the site', 'سایت را توصیف کنید')} hint={t('What it is, who it is for, what visitors should do. The more specific, the better. Do not paste secrets.', 'چیست، برای کیست، بازدیدکننده چه کند. هرچه دقیق‌تر بهتر. رمز و کلید نگذارید.')}>
              <Textarea className="h-32" value={form.brief} onChange={(e) => setForm({ ...form, brief: e.target.value })} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label={t('Language', 'زبان')}><Pick value={form.language} onChange={(language) => setForm({ ...form, language: language as typeof lang })} options={[{ value: 'fa', label: 'فارسی' }, { value: 'en', label: 'English' }, { value: 'ar', label: 'العربية' }, { value: 'de', label: 'Deutsch' }, { value: 'fr', label: 'Français' }, { value: 'tr', label: 'Türkçe' }]} /></Field>
              <Field label={t('Tone (optional)', 'لحن (اختیاری)')}><Input value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })} /></Field>
              <Field label={t('Pages you expect (optional)', 'صفحه‌های مورد انتظار (اختیاری)')}><Input value={form.pages_hint} onChange={(e) => setForm({ ...form, pages_hint: e.target.value })} /></Field>
              <Field label={t('Public address (optional)', 'نشانی عمومی (اختیاری)')}><Input dir="ltr" placeholder="https://" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} /></Field>
            </div>
            <p className="text-xs text-muted-foreground">{t('Your description and the generated texts are sent to the AI provider you chose. Nothing else leaves this computer.', 'توصیف شما و متن‌های تولیدشده به سرویس هوش مصنوعی انتخابی شما فرستاده می‌شود. چیز دیگری از این کامپیوتر خارج نمی‌شود.')}</p>
            <Button disabled={busy || !form.name || form.brief.length < 20} onClick={start}><SparklesIcon /> {t('Start', 'شروع')}</Button>
          </CardContent>
        </Card>
      )}
    </>
  );
}
