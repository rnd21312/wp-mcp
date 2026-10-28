import { ExternalLinkIcon, LinkIcon, LogOutIcon, SearchCheckIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { PageTitle, Pick } from '@/components/bits';
import { ErrorBox, Field, Loading } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface Status { ok: boolean; configured: boolean; connected: boolean; email: string; client_id: string; redirect_uri: string }
interface Row { [k: string]: any; clicks: number; impressions: number; ctr_pct: number; position: number }
interface Perf { ok: boolean; error?: { message: string }; totals: Row; rows: Row[]; range: { start: string; end: string } }

const num = (n: number, lang: string): string => Number(n ?? 0).toLocaleString(lang === 'fa' ? 'fa' : 'en');
const run = <T,>(action: string, args: Record<string, unknown> = {}): Promise<T> => api.post<T>('gsc/run', { action, args });

function Setup({ status, reload }: { status: Status; reload: () => Promise<void> }) {
  const { t } = useI18n();
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const [err, setErr] = useState('');
  const link = (href: string, label: string) => <a className="text-primary hover:underline" dir="ltr" href={href} target="_blank" rel="noreferrer">{label} <ExternalLinkIcon className="inline size-3" /></a>;

  const save = async (): Promise<void> => {
    setErr('');
    const r = await api.post<any>('gsc/client', { client_id: id, client_secret: secret });
    if (r.ok === false) setErr(r.error?.message ?? 'Failed');
    else { setSecret(''); await reload(); }
  };
  const connect = async (): Promise<void> => {
    setErr('');
    const r = await api.post<any>('gsc/connect');
    if (r.ok && r.url) window.open(r.url, '_blank', 'noopener');
    else setErr(r.error?.message ?? 'Failed');
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>{t('1. Create a Google sign-in (one time, free)', '۱. ساخت ورود گوگل (یک بار، رایگان)')}</CardTitle><CardDescription>{t('Google needs an "app" that you own to hand data to this panel. It stays on your computer.', 'گوگل برای دادن اطلاعات به این پنل یک «برنامه»ی متعلق به خودتان می‌خواهد. همه‌چیز روی کامپیوتر خودتان می‌ماند.')}</CardDescription></CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-2 ps-5 text-sm leading-relaxed">
            <li>{t('Open', 'باز کنید')} {link('https://console.cloud.google.com/projectcreate', 'Google Cloud, new project')} {t('and create a project (any name).', 'و یک پروژه بسازید (هر نامی).')}</li>
            <li>{t('Enable', 'فعال کنید')} {link('https://console.cloud.google.com/apis/library/searchconsole.googleapis.com', 'Google Search Console API')}.</li>
            <li>{t('Open', 'باز کنید')} {link('https://console.cloud.google.com/auth/overview', 'Google Auth platform')}: {t('choose "External", fill the app name and your email. Under Audience add your Google email as a test user, then press "Publish app" so the sign-in does not expire after 7 days (Google warns "unverified app": that is normal for your own app).', 'گزینه‌ی «External» را بزنید، نام برنامه و ایمیل خود را بنویسید. در بخش Audience ایمیل گوگل خود را به‌عنوان کاربر آزمایشی اضافه کنید و «Publish app» را بزنید تا ورود بعد از ۷ روز منقضی نشود (گوگل هشدار «برنامه تأییدنشده» می‌دهد؛ برای برنامه‌ی شخصی طبیعی است).')}</li>
            <li>{t('Open', 'باز کنید')} {link('https://console.cloud.google.com/auth/clients', 'Clients')}, {t('Create client, type "Desktop app", then copy the Client ID and Client secret below.', 'Create client بزنید، نوع «Desktop app» را انتخاب کنید و Client ID و Client secret را در پایین بچسبانید.')}</li>
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('2. Paste it here and sign in', '۲. اینجا بچسبانید و وارد شوید')}</CardTitle><CardDescription>{t('Stored encrypted on this computer. Only read access to Search Console is requested.', 'رمزشده روی همین کامپیوتر ذخیره می‌شود. فقط دسترسی خواندن به Search Console درخواست می‌شود.')}</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <Field label="Client ID"><Input dir="ltr" value={id} onChange={(e) => setId(e.target.value)} placeholder="123…apps.googleusercontent.com" autoComplete="off" /></Field>
          <Field label="Client secret"><Input dir="ltr" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" /></Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={!id || !secret} onClick={save}>{t('Save', 'ذخیره')}</Button>
            <Button disabled={!status.configured} onClick={connect}><LinkIcon /> {t('Connect with Google', 'اتصال با گوگل')}</Button>
            <Button variant="ghost" onClick={reload}>{t('I connected: refresh', 'وصل شدم: بازخوانی')}</Button>
          </div>
          {status.configured && <p className="text-xs text-muted-foreground" dir="ltr">Client: {status.client_id}</p>}
          {err && <ErrorBox message={err} />}
        </CardContent>
      </Card>
    </div>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => <Card><CardContent className="py-4"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-2xl font-semibold" dir="ltr">{value}</div></CardContent></Card>;

function RowsTable({ rows, dim, shorten }: { rows: Row[]; dim: string; shorten?: boolean }) {
  const { t, lang } = useI18n();
  const cut = (s: string): string => (shorten ? s.replace(/^https?:\/\/[^/]+/, '') || '/' : s);

  return (
    <Table>
      <TableHeader><TableRow><TableHead>{dim}</TableHead><TableHead className="text-end">{t('Clicks', 'کلیک')}</TableHead><TableHead className="text-end">{t('Impr.', 'نمایش')}</TableHead><TableHead className="text-end">CTR</TableHead><TableHead className="text-end">{t('Pos.', 'جایگاه')}</TableHead></TableRow></TableHeader>
      <TableBody>
        {rows.map((r) => <TableRow key={String(r[dim])}><TableCell className="max-w-[22rem] truncate" dir="auto" title={String(r[dim])}>{cut(String(r[dim]))}</TableCell><TableCell className="text-end">{num(r.clicks, lang)}</TableCell><TableCell className="text-end">{num(r.impressions, lang)}</TableCell><TableCell className="text-end">{r.ctr_pct}%</TableCell><TableCell className="text-end">{r.position}</TableCell></TableRow>)}
      </TableBody>
    </Table>
  );
}

function Dashboard({ status, reload }: { status: Status; reload: () => Promise<void> }) {
  const { t, lang } = useI18n();
  const [sites, setSites] = useState<{ site: string; permission: string }[]>([]);
  const [site, setSite] = useState('');
  const [days, setDays] = useState('28');
  const [perf, setPerf] = useState<Record<string, Perf>>({});
  const [maps, setMaps] = useState<any[]>([]);
  const [cov, setCov] = useState<any>(null);
  const [insp, setInsp] = useState<any>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    void run<any>('sites').then((r) => {
      if (r.ok === false) return setErr(r.error?.message ?? 'Failed');
      setSites(r.sites);
      setSite((s) => s || (r.sites.find((x: any) => x.permission !== 'siteUnverifiedUser')?.site ?? ''));
    });
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (!site) return;
    setBusy('data');
    setErr('');
    const args = { site, days: Number(days) };
    const [q, p, c, d, m] = await Promise.all([run<Perf>('performance', { ...args, dimensions: ['query'], limit: 15 }), run<Perf>('performance', { ...args, dimensions: ['page'], limit: 15 }), run<Perf>('performance', { ...args, dimensions: ['country'], limit: 6 }), run<Perf>('performance', { ...args, dimensions: ['device'] }), run<any>('sitemaps', { site })]);
    const bad = [q, p, c, d, m].find((x: any) => x.ok === false) as any;
    if (bad) setErr(bad.error?.message ?? 'Failed');
    setPerf({ query: q, page: p, country: c, device: d });
    setMaps(m.sitemaps ?? []);
    setBusy('');
  }, [site, days]);
  useEffect(() => { void load(); }, [load]);

  const totals = perf.query?.totals;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-72"><Pick value={site} onChange={setSite} options={sites.map((s) => ({ value: s.site, label: s.site }))} /></div>
        <div className="w-40"><Pick value={days} onChange={setDays} options={[{ value: '7', label: t('Last 7 days', '۷ روز اخیر') }, { value: '28', label: t('Last 28 days', '۲۸ روز اخیر') }, { value: '90', label: t('Last 90 days', '۹۰ روز اخیر') }, { value: '180', label: t('Last 6 months', '۶ ماه اخیر') }]} /></div>
        <Badge variant="secondary" dir="ltr">{status.email || 'Google'}</Badge>
        {perf.query?.range && <span className="text-xs text-muted-foreground" dir="ltr">{perf.query.range.start} → {perf.query.range.end}</span>}
        <Button className="ms-auto" variant="outline" size="sm" onClick={async () => { await api.post('gsc/disconnect'); await reload(); }}><LogOutIcon /> {t('Disconnect', 'قطع اتصال')}</Button>
      </div>
      {err && <ErrorBox message={err} />}
      {busy === 'data' && !totals && <Loading />}

      {totals && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label={t('Clicks', 'کلیک‌ها')} value={num(totals.clicks, lang)} />
          <Stat label={t('Impressions', 'نمایش‌ها')} value={num(totals.impressions, lang)} />
          <Stat label="CTR" value={`${totals.ctr_pct}%`} />
          <Stat label={t('Avg. position', 'میانگین جایگاه')} value={String(totals.position)} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>{t('Top queries', 'پرتکرارترین جستجوها')}</CardTitle></CardHeader><CardContent>{perf.query?.rows && <RowsTable rows={perf.query.rows} dim="query" />}</CardContent></Card>
        <Card><CardHeader><CardTitle>{t('Top pages', 'پربازدیدترین صفحه‌ها')}</CardTitle></CardHeader><CardContent>{perf.page?.rows && <RowsTable rows={perf.page.rows} dim="page" shorten />}</CardContent></Card>
        <Card><CardHeader><CardTitle>{t('Countries', 'کشورها')}</CardTitle></CardHeader><CardContent>{perf.country?.rows && <RowsTable rows={perf.country.rows} dim="country" />}</CardContent></Card>
        <Card><CardHeader><CardTitle>{t('Devices', 'دستگاه‌ها')}</CardTitle></CardHeader><CardContent>{perf.device?.rows && <RowsTable rows={perf.device.rows} dim="device" />}</CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle>{t('Sitemaps', 'نقشه‌های سایت')}</CardTitle></CardHeader>
        <CardContent>
          {maps.length === 0 ? <p className="text-sm text-muted-foreground">{t('No sitemap submitted in Search Console. Submit one there (Sitemaps).', 'نقشه‌ای در Search Console ثبت نشده. از بخش Sitemaps ثبت کنید.')}</p> : (
            <Table><TableHeader><TableRow><TableHead>URL</TableHead><TableHead>{t('Last read', 'آخرین خواندن')}</TableHead><TableHead className="text-end">{t('Errors', 'خطا')}</TableHead><TableHead className="text-end">{t('Warnings', 'هشدار')}</TableHead></TableRow></TableHeader>
              <TableBody>{maps.map((m) => <TableRow key={m.path}><TableCell dir="ltr" className="max-w-[22rem] truncate">{m.path}</TableCell><TableCell dir="ltr">{String(m.last_downloaded ?? '').slice(0, 10)}</TableCell><TableCell className="text-end">{m.errors}</TableCell><TableCell className="text-end">{m.warnings}</TableCell></TableRow>)}</TableBody></Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('Indexing check', 'بررسی ایندکس')}</CardTitle><CardDescription>{t('Asks Google about the pages in your sitemap (the live "Pages" report). Up to 40 at a time.', 'از گوگل درباره‌ی صفحه‌های نقشه‌ی سایت می‌پرسد (گزارش زنده‌ی «Pages»). تا ۴۰ صفحه در هر بار.')}</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button disabled={!!busy || !site} onClick={async () => { setBusy('cov'); setCov(await run('coverage', { site, limit: 40 })); setBusy(''); }}><SearchCheckIcon /> {t('Check indexing', 'بررسی ایندکس')}</Button>
          </div>
          {busy === 'cov' && <Loading />}
          {cov?.ok === false && <ErrorBox message={cov.error?.message ?? 'Failed'} />}
          {cov?.ok && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">{Object.entries(cov.summary as Record<string, number>).map(([k, v]) => <Badge key={k} variant="secondary" dir="ltr">{k}: {v}</Badge>)}</div>
              <p className="text-sm">{t(`Indexed ${cov.indexed} of ${cov.inspected} checked (${cov.urls_known} known).`, `${num(cov.indexed, lang)} از ${num(cov.inspected, lang)} صفحه‌ی بررسی‌شده ایندکس است (${num(cov.urls_known, lang)} صفحه شناخته‌شده).`)}</p>
              {cov.problems.length > 0 && <Table><TableHeader><TableRow><TableHead>URL</TableHead><TableHead>{t('Status', 'وضعیت')}</TableHead></TableRow></TableHeader><TableBody>{cov.problems.map((p: any) => <TableRow key={p.url}><TableCell dir="ltr" className="max-w-[26rem] truncate" title={p.url}>{p.url.replace(/^https?:\/\/[^/]+/, '') || '/'}</TableCell><TableCell dir="ltr">{p.coverage ?? p.error}</TableCell></TableRow>)}</TableBody></Table>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('Inspect one URL', 'بازرسی یک آدرس')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2"><Input dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /><Button disabled={!url || !!busy} onClick={async () => { setBusy('insp'); setInsp(await run('inspect', { site, url })); setBusy(''); }}>{t('Inspect', 'بازرسی')}</Button></div>
          {busy === 'insp' && <Loading />}
          {insp?.ok === false && <ErrorBox message={insp.error?.message ?? 'Failed'} />}
          {insp?.ok && <pre dir="ltr" className="max-h-96 overflow-auto rounded-lg border bg-muted/50 p-3 text-start text-xs whitespace-pre-wrap">{JSON.stringify(insp, null, 2)}</pre>}
        </CardContent>
      </Card>
    </div>
  );
}

export function SearchConsole() {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  const reload = useCallback(async (): Promise<void> => setStatus(await api.get<Status>('gsc/status')), []);
  useEffect(() => { void reload(); }, [reload]);

  return (
    <>
      <PageTitle title={t('Google Search Console', 'گوگل سرچ کنسول')} hint={t('Real clicks, searches and indexing from Google, read-only. The same data is available to your AI through the "search_console" tool.', 'کلیک‌ها، جستجوها و وضعیت ایندکس واقعی از گوگل، فقط خواندنی. همین داده‌ها از طریق ابزار «search_console» در اختیار هوش مصنوعی شما هم هست.')} />
      {!status ? <Loading /> : status.connected ? <Dashboard status={status} reload={reload} /> : <Setup status={status} reload={reload} />}
    </>
  );
}
