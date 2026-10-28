import { CheckCircle2Icon, GlobeIcon, SearchCheckIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { PageTitle, Pick } from '@/components/bits';
import { Field, Loading } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { analyze, type Check, type FetchInfo, type Report } from '@/lib/seoAnalysis';
import { useAction, useSite } from '@/lib/site';

const SEV: Record<string, string> = {
  high: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  medium: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  low: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  ok: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
};

const Ring = ({ score }: { score: number }) => {
  const color = score >= 80 ? '#10b981' : score >= 55 ? '#f59e0b' : '#f43f5e';
  const c = 2 * Math.PI * 42;

  return (
    <svg viewBox="0 0 100 100" className="size-28">
      <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth="9" />
      <circle cx="50" cy="50" r="42" fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${(score / 100) * c} ${c}`} transform="rotate(-90 50 50)" />
      <text x="50" y="58" textAnchor="middle" fontSize="28" fontWeight="700" fill="currentColor">{score}</text>
    </svg>
  );
};

function Serp({ r, mobile }: { r: Report; mobile: boolean }) {
  let host = r.url;
  let crumbs = '';
  try { const u = new URL(r.url); host = u.hostname; crumbs = decodeURIComponent(u.pathname).split('/').filter(Boolean).join(' › '); } catch { /* keep */ }
  const title = r.title.length > 60 ? `${r.title.slice(0, 58)}…` : r.title;
  const desc = (r.description || r.text.slice(0, 160)).slice(0, mobile ? 120 : 160);

  return (
    <div dir="ltr" className={`rounded-xl border bg-white p-4 text-start text-black ${mobile ? 'max-w-sm' : 'max-w-2xl'}`} style={{ fontFamily: 'Arial, sans-serif' }}>
      <div className="flex items-center gap-2 text-xs text-[#202124]"><span className="grid size-6 place-items-center rounded-full bg-[#f1f3f4]">{r.favicon ? <img src={new URL(r.favicon, r.url).href} alt="" className="size-4" /> : <GlobeIcon className="size-3" />}</span><span>{host}{crumbs && <span className="text-[#5f6368]"> › {crumbs}</span>}</span></div>
      <div className="mt-1 text-xl leading-snug text-[#1a0dab]">{title || '—'}</div>
      <div className="mt-1 text-sm leading-snug text-[#4d5156]">{desc}{desc.length >= (mobile ? 120 : 160) && '…'}</div>
    </div>
  );
}

function Social({ r }: { r: Report }) {
  const img = r.og.image ? new URL(r.og.image, r.url).href : '';
  const host = (() => { try { return new URL(r.url).hostname; } catch { return ''; } })();

  return (
    <div dir="ltr" className="max-w-md overflow-hidden rounded-lg border bg-white text-start text-black" style={{ fontFamily: 'Arial, sans-serif' }}>
      {img ? <img src={img} alt="" className="aspect-[1.91/1] w-full object-cover" /> : <div className="grid aspect-[1.91/1] place-items-center bg-[#f0f2f5] text-xs text-[#65676b]">no og:image</div>}
      <div className="bg-[#f0f2f5] p-3"><div className="text-xs uppercase text-[#65676b]">{host}</div><div className="font-semibold">{r.og.title || r.title}</div><div className="text-sm text-[#65676b]">{(r.og.description || r.description).slice(0, 120)}</div></div>
    </div>
  );
}

export function Inspector() {
  const { t } = useI18n();
  const { site } = useSite();
  const pages = useAction<any>('content', 'list', { post_type: 'page', per_page: 50 });
  const [url, setUrl] = useState('');
  const [keyword, setKeyword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [info, setInfo] = useState<(FetchInfo & { url: string }) | null>(null);
  const [linkStatus, setLinkStatus] = useState<Record<string, number | string>>({});
  const [checking, setChecking] = useState(false);

  const inspect = async (target = url): Promise<void> => {
    if (!target) return;
    setBusy(true);
    setErr('');
    setLinkStatus({});
    const r = await api.post<any>('inspect/fetch', { url: target });
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? 'Failed'); setReport(null); return; }
    const f: FetchInfo & { url: string } = { url: r.final.url, status: r.final.status, ms: r.final.ms, bytes: r.final.bytes, headers: r.final.headers, chain: r.chain };
    setInfo(f);
    setReport(analyze(r.final.html, r.final.url, f, keyword));
  };

  const checkLinks = async (): Promise<void> => {
    if (!report) return;
    setChecking(true);
    const r = await api.post<any>('inspect/links', { urls: report.links.map((l) => l.href) });
    setLinkStatus(r.statuses ?? {});
    setChecking(false);
  };

  const options = [{ value: '-', label: t('Pick a page of the site…', 'یک صفحه‌ی سایت انتخاب کنید…') }, ...(pages.data?.items ?? []).filter((p: any) => p.status === 'publish').map((p: any) => ({ value: p.url, label: p.title }))];
  const groups = report ? { high: report.checks.filter((c) => c.severity === 'high'), medium: report.checks.filter((c) => c.severity === 'medium'), low: report.checks.filter((c) => c.severity === 'low'), ok: report.checks.filter((c) => c.severity === 'ok') } : null;
  const broken = Object.entries(linkStatus).filter(([, s]) => typeof s !== 'number' || s >= 400);

  const row = (c: Check) => (
    <div key={c.id + c.title} className="rounded-lg border p-3 text-sm">
      <div className="flex items-center gap-2"><Badge variant="secondary" className={SEV[c.severity]}>{c.severity === 'ok' ? '✓' : c.severity}</Badge><span className="font-medium">{c.title}</span></div>
      {c.detail && <p dir="auto" className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{c.detail}</p>}
      {c.fix && <p className="mt-1 text-xs">{c.fix}</p>}
    </div>
  );

  return (
    <>
      <PageTitle title={t('URL Inspector', 'بازرس URL')} hint={t('Like Search Console\'s URL inspection: fetches the page the way a crawler does and checks indexing, snippets, structure, links and speed.', 'مثل بازرسی URL در Search Console: صفحه را مثل خزنده می‌گیرد و ایندکس، اسنیپت، ساختار، لینک‌ها و سرعت را بررسی می‌کند.')} />
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="grid gap-3 md:grid-cols-[1fr_16rem]">
            <Field label={t('Address', 'آدرس')}><Input dir="ltr" placeholder="https://example.com/page/" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && inspect()} /></Field>
            <Field label={t('Focus keyword (optional)', 'کلمه‌ی کلیدی (اختیاری)')}><Input value={keyword} onChange={(e) => setKeyword(e.target.value)} /></Field>
          </div>
          <div className="flex flex-wrap gap-2">
            {site && <div className="w-72"><Pick value="-" onChange={(v) => { if (v !== '-') { setUrl(v); void inspect(v); } }} options={options} /></div>}
            <Button disabled={busy || !url} onClick={() => inspect()}><SearchCheckIcon /> {busy ? t('Inspecting…', 'در حال بازرسی…') : t('Inspect', 'بازرسی')}</Button>
            {site && <Button variant="outline" onClick={() => { setUrl(site.url); void inspect(site.url); }}>{t('Home page', 'صفحه‌ی اصلی')}</Button>}
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
        </CardContent>
      </Card>

      {busy && <Loading />}
      {report && info && groups && !busy && (
        <div className="mt-6 space-y-6">
          <div className="grid gap-4 md:grid-cols-[auto_1fr]">
            <Card><CardContent className="flex items-center gap-4 pt-4"><Ring score={report.score} /><div className="space-y-1 text-sm"><div className="flex items-center gap-1.5 text-rose-600"><TriangleAlertIcon className="size-4" />{groups.high.length} {t('critical', 'بحرانی')}</div><div className="text-amber-600">{groups.medium.length} {t('warnings', 'هشدار')}</div><div className="text-sky-600">{groups.low.length} {t('tips', 'پیشنهاد')}</div><div className="flex items-center gap-1.5 text-emerald-600"><CheckCircle2Icon className="size-4" />{groups.ok.length} {t('passed', 'موفق')}</div></div></CardContent></Card>
            <Card><CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 pt-4 text-sm md:grid-cols-4">
              <div><div className="text-xs text-muted-foreground">HTTP</div><b>{info.status}</b></div>
              <div><div className="text-xs text-muted-foreground">{t('Response', 'پاسخ')}</div><b>{info.ms} ms</b></div>
              <div><div className="text-xs text-muted-foreground">{t('Size', 'حجم')}</div><b>{(info.bytes / 1024).toFixed(0)} KB</b></div>
              <div><div className="text-xs text-muted-foreground">{t('Words', 'کلمات')}</div><b>{report.words}</b></div>
              <div className="col-span-2"><div className="text-xs text-muted-foreground">{t('Indexing', 'ایندکس')}</div><b>{/noindex/i.test(report.robots) ? t('Blocked (noindex)', 'مسدود (noindex)') : t('Allowed', 'مجاز')}</b></div>
              <div className="col-span-2 min-w-0"><div className="text-xs text-muted-foreground">Canonical</div><div dir="ltr" className="truncate text-start text-xs">{report.canonical || '—'}</div></div>
            </CardContent></Card>
          </div>

          <Tabs defaultValue="issues">
            <TabsList className="flex-wrap"><TabsTrigger value="issues">{t('Issues', 'مشکلات')}</TabsTrigger><TabsTrigger value="preview">{t('Previews', 'پیش‌نمایش‌ها')}</TabsTrigger><TabsTrigger value="structure">{t('Structure', 'ساختار')}</TabsTrigger><TabsTrigger value="links">{t('Links', 'لینک‌ها')}</TabsTrigger><TabsTrigger value="schema">Schema</TabsTrigger><TabsTrigger value="images">{t('Images', 'تصاویر')}</TabsTrigger><TabsTrigger value="tech">{t('Technical', 'فنی')}</TabsTrigger></TabsList>

            <TabsContent value="issues" className="mt-4 grid gap-2 md:grid-cols-2">{[...groups.high, ...groups.medium, ...groups.low, ...groups.ok].map(row)}</TabsContent>

            <TabsContent value="preview" className="mt-4 space-y-6">
              <div><h3 className="mb-2 text-sm font-medium">Google · {t('desktop', 'دسکتاپ')}</h3><Serp r={report} mobile={false} /></div>
              <div><h3 className="mb-2 text-sm font-medium">Google · {t('mobile', 'موبایل')}</h3><Serp r={report} mobile /></div>
              <div><h3 className="mb-2 text-sm font-medium">{t('Social share (Facebook / LinkedIn / Telegram)', 'اشتراک اجتماعی (فیسبوک / لینکدین / تلگرام)')}</h3><Social r={report} /></div>
            </TabsContent>

            <TabsContent value="structure" className="mt-4">
              <Card><CardHeader><CardTitle>{t('Heading outline', 'ساختار سرتیترها')}</CardTitle><CardDescription>{t('How a crawler reads the page.', 'خزنده صفحه را این‌طور می‌خواند.')}</CardDescription></CardHeader>
                <CardContent className="space-y-1">{report.headings.map((h, i) => <div key={i} style={{ paddingInlineStart: (h.level - 1) * 20 }} className="flex items-center gap-2 text-sm"><Badge variant="outline" className="font-mono">H{h.level}</Badge><span className="truncate">{h.text || '—'}</span></div>)}</CardContent></Card>
              {report.keyword && <Card className="mt-4"><CardHeader><CardTitle>{t('Keyword', 'کلمه‌ی کلیدی')}: {report.keyword.word}</CardTitle></CardHeader><CardContent className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
                <div>{t('Count', 'تعداد')}: <b>{report.keyword.count}</b></div><div>{t('Density', 'تراکم')}: <b>{report.keyword.density.toFixed(2)}%</b></div>
                {([['inTitle', 'Title'], ['inH1', 'H1'], ['inDescription', 'Description'], ['inUrl', 'URL'], ['inFirst100', t('First 100 words', '۱۰۰ کلمه‌ی اول')], ['inAlt', 'Alt']] as const).map(([k, l]) => <div key={k}>{l}: {report.keyword![k] ? '✓' : '✗'}</div>)}
              </CardContent></Card>}
            </TabsContent>

            <TabsContent value="links" className="mt-4 space-y-3">
              <div className="flex items-center gap-3"><Button variant="outline" size="sm" disabled={checking} onClick={checkLinks}>{checking ? '…' : t('Check link status', 'بررسی وضعیت لینک‌ها')}</Button><span className="text-sm text-muted-foreground">{report.links.filter((l) => l.internal).length} {t('internal', 'داخلی')} · {report.links.filter((l) => !l.internal).length} {t('external', 'خارجی')}{broken.length > 0 && <b className="ms-3 text-destructive">{broken.length} {t('broken', 'خراب')}</b>}</span></div>
              <Card><CardContent className="max-h-[28rem] divide-y overflow-auto p-0">
                {report.links.slice(0, 200).map((l, i) => { const s = linkStatus[l.href]; return (
                  <div key={i} className="flex items-center gap-3 px-3 py-2 text-xs"><Badge variant="outline">{l.internal ? 'int' : 'ext'}</Badge>{l.nofollow && <Badge variant="secondary">nofollow</Badge>}<span className="min-w-0 flex-1"><span className="block truncate">{l.text || <i className="text-destructive">{t('no text', 'بدون متن')}</i>}</span><span dir="ltr" className="block truncate text-start text-muted-foreground">{l.href}</span></span>{s !== undefined && <Badge variant="secondary" className={typeof s === 'number' && s < 400 ? SEV.ok : SEV.high}>{s}</Badge>}</div>
                ); })}
              </CardContent></Card>
            </TabsContent>

            <TabsContent value="schema" className="mt-4 space-y-3">
              {report.schema.length === 0 && <p className="text-sm text-muted-foreground">{t('No JSON-LD found.', 'JSON-LD پیدا نشد.')}</p>}
              {report.schema.map((s, i) => <Card key={i}><CardHeader><CardTitle className="flex items-center gap-2">{s.type}{s.problems.length ? <Badge variant="secondary" className={SEV.medium}>{t('missing', 'کم دارد')}: {s.problems.join(', ')}</Badge> : <Badge variant="secondary" className={SEV.ok}>✓</Badge>}</CardTitle></CardHeader><CardContent><pre dir="ltr" className="max-h-60 overflow-auto rounded-lg bg-muted/40 p-3 text-start font-mono text-xs">{JSON.stringify(s.raw, null, 2)}</pre></CardContent></Card>)}
            </TabsContent>

            <TabsContent value="images" className="mt-4">
              <Card><CardContent className="max-h-[30rem] divide-y overflow-auto p-0">{report.images.map((im, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2 text-xs"><img src={im.src} alt="" className="size-10 rounded border object-cover" loading="lazy" /><span className="min-w-0 flex-1"><span dir="ltr" className="block truncate text-start text-muted-foreground">{im.src}</span><span className={im.alt ? '' : 'text-destructive'}>{im.alt || t('no alt text', 'بدون متن جایگزین')}</span></span>{im.lazy && <Badge variant="outline">lazy</Badge>}{(!im.width || !im.height) && <Badge variant="secondary" className={SEV.low}>no size</Badge>}</div>
              ))}</CardContent></Card>
            </TabsContent>

            <TabsContent value="tech" className="mt-4 grid gap-4 md:grid-cols-2">
              <Card><CardHeader><CardTitle>{t('Redirect chain', 'زنجیره‌ی ریدایرکت')}</CardTitle></CardHeader><CardContent className="space-y-1 text-xs">{info.chain.map((c, i) => <div dir="ltr" key={i} className="text-start"><Badge variant="outline" className="me-2">{c.status}</Badge>{c.url}</div>)}</CardContent></Card>
              <Card><CardHeader><CardTitle>{t('Response headers', 'هدرهای پاسخ')}</CardTitle></CardHeader><CardContent className="space-y-1 text-xs">{Object.entries(info.headers).filter(([, v]) => v).map(([k, v]) => <div dir="ltr" key={k} className="text-start"><b>{k}</b>: {v}</div>)}</CardContent></Card>
              <Card><CardHeader><CardTitle>Open Graph / Twitter</CardTitle></CardHeader><CardContent className="space-y-1 text-xs">{[...Object.entries(report.og).map(([k, v]) => [`og:${k}`, v]), ...Object.entries(report.twitter).map(([k, v]) => [`twitter:${k}`, v])].map(([k, v]) => <div dir="ltr" key={k} className="text-start break-all"><b>{k}</b>: {v}</div>)}</CardContent></Card>
              <Card><CardHeader><CardTitle>hreflang</CardTitle></CardHeader><CardContent className="space-y-1 text-xs">{report.hreflang.length ? report.hreflang.map((h) => <div dir="ltr" key={h.lang} className="text-start"><b>{h.lang}</b> {h.href}</div>) : <span className="text-muted-foreground">—</span>}</CardContent></Card>
            </TabsContent>
          </Tabs>
        </div>
      )}
    </>
  );
}
