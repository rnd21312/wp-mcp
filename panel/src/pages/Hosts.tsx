import { DownloadIcon, PlusIcon, RefreshCwIcon, ServerIcon, Trash2Icon, Undo2Icon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Empty, PageTitle, Pick, StatusBadge } from '@/components/bits';
import { ErrorBox, Field, Loading } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ago, api, type HostInfo, type Studio } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { WordPressDialog } from '@/pages/WordPressDialog';

export const useStudio = () => {
  const [data, setData] = useState<Studio | null>(null);
  const refresh = useCallback(async () => setData(await api.studio()), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, refresh };
};

interface RemoteSite { id: string; name: string; kind: string; mode: string; folder: string; url: string; current: string | null; releases: number }
interface Rel { id: string; created: number; files: number; note: string }

function Sites({ host }: { host: HostInfo }) {
  const { t, lang } = useI18n();
  const [sites, setSites] = useState<RemoteSite[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState('');
  const [rels, setRels] = useState<{ current: string | null; releases: Rel[] }>({ current: null, releases: [] });
  const [form, setForm] = useState({ name: '', kind: 'static', folder: '' });
  const [script, setScript] = useState<{ site: string; domain: string; text: string } | null>(null);

  const makeScript = async (): Promise<void> => {
    if (!script) return;
    const r = await api.post<any>('hosts/node-script', { host: host.name, site: script.site, domain: script.domain });
    r.ok ? setScript({ ...script, text: r.script }) : toast.error(r.error?.message ?? 'error');
  };

  const load = useCallback(async () => {
    const r = await api.post<{ ok: boolean; sites: RemoteSite[]; error?: { message: string } }>('hosts/sites', { host: host.name });
    r.ok ? (setSites(r.sites), setErr('')) : setErr(r.error?.message ?? 'error');
  }, [host.name]);
  useEffect(() => { void load(); }, [load]);

  const showReleases = async (id: string): Promise<void> => {
    setOpen(open === id ? '' : id);
    if (open !== id) {
      const r = await api.post<any>('hosts/releases', { host: host.name, site: id });
      if (r.ok) setRels({ current: r.current, releases: r.releases });
    }
  };

  const rollback = async (site: string, release: string): Promise<void> => {
    const r = await api.post('hosts/rollback', { host: host.name, site, release });
    r.ok ? toast.success(t('Rolled back', 'برگشت انجام شد')) : toast.error(r.error?.message ?? 'error');
    await load();
    await showReleases(site);
    await showReleases(site);
  };

  const create = async (): Promise<void> => {
    const r = await api.post('hosts/sites/create', { host: host.name, ...form });
    r.ok ? (toast.success(t('Site created on the host', 'سایت روی هاست ساخته شد')), setForm({ name: '', kind: 'static', folder: '' }), await load()) : toast.error(r.error?.message ?? 'error');
  };

  if (err) return <ErrorBox message={err} />;
  if (!sites) return <Loading />;

  return (
    <div className="space-y-3">
      {script && (
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <p className="text-muted-foreground">{t('For a VPS you control. Read the script, then run it as root over SSH yourself; the agent never runs it.', 'برای VPS خودتان. اسکریپت را بخوانید و خودتان با SSH به‌صورت root اجرا کنید؛ ایجنت هرگز اجرایش نمی‌کند.')}</p>
          <div className="flex gap-2"><Input dir="ltr" placeholder="app.example.com" value={script.domain} onChange={(e) => setScript({ ...script, domain: e.target.value })} /><Button disabled={!script.domain} onClick={makeScript}>{t('Generate', 'بساز')}</Button><Button variant="ghost" onClick={() => setScript(null)}>{t('Close', 'بستن')}</Button></div>
          {script.text && <textarea readOnly dir="ltr" className="h-64 w-full rounded-lg bg-muted p-3 font-mono text-xs" value={script.text} onFocus={(e) => e.currentTarget.select()} />}
        </div>
      )}
      {sites.length === 0 && <p className="text-sm text-muted-foreground">{t('No sites on this host yet.', 'هنوز سایتی روی این هاست نیست.')}</p>}
      {sites.map((s) => (
        <div key={s.id} className="rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-medium">{s.name}</span> <span className="text-muted-foreground">· {s.kind} · {s.mode} · <span dir="ltr">/{s.folder}</span></span>
            </div>
            <div className="flex gap-2">
              {s.kind === 'node' && <Button size="sm" variant="ghost" onClick={() => setScript({ site: s.id, domain: '', text: '' })}>{t('Server script', 'اسکریپت سرور')}</Button>}
              <Button size="sm" variant="outline" onClick={() => showReleases(s.id)}>{t('Releases', 'نسخه‌ها')} ({s.releases})</Button>
            </div>
          </div>
          {open === s.id && (
            <div className="mt-3 space-y-1">
              {rels.releases.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded bg-muted/50 px-2 py-1">
                  <span dir="ltr" className="font-mono text-xs">{r.id}{r.id === rels.current ? ' ✓' : ''}</span>
                  <span className="text-xs text-muted-foreground">{r.files} {t('files', 'فایل')} · {ago(r.created, lang)} {r.note && `· ${r.note}`}</span>
                  {r.id !== rels.current && <Button size="sm" variant="ghost" onClick={() => rollback(s.id, r.id)}><Undo2Icon /> {t('Go back to this', 'برگرد به این')}</Button>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      <div className="grid gap-2 sm:grid-cols-4">
        <Input placeholder={t('New site name', 'نام سایت جدید')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Pick value={form.kind} onChange={(kind) => setForm({ ...form, kind })} options={[{ value: 'static', label: t('Static', 'ایستا') }, { value: 'spa', label: 'SPA (React/Vue/…)' }]} />
        <Input dir="ltr" placeholder={t('Folder (empty = web root)', 'پوشه (خالی = ریشه)')} value={form.folder} onChange={(e) => setForm({ ...form, folder: e.target.value })} />
        <Button disabled={!form.name} onClick={create}><PlusIcon /> {t('Create', 'بساز')}</Button>
      </div>
    </div>
  );
}

export function Hosts() {
  const { t, lang } = useI18n();
  const { data, refresh } = useStudio();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ url: '', code: '', name: '' });
  const [busy, setBusy] = useState('');
  const [agent, setAgent] = useState<{ setup_code: string } | null>(null);
  const [open, setOpen] = useState('');
  const [wpHost, setWpHost] = useState('');
  const [report, setReport] = useState<{ host: string; checks: { id: string; status: string; msg: string }[]; exposure: { path: string; status: number; safe: boolean; note: string }[] } | null>(null);

  const check = async (name: string): Promise<void> => {
    setBusy('check-' + name);
    const r = await api.post<any>('hosts/check', { name });
    setBusy('');
    r.ok ? setReport({ host: name, checks: r.checks, exposure: r.exposure }) : toast.error(r.error?.message ?? 'error');
  };

  const updateAgent = async (name: string): Promise<void> => {
    setBusy('update-' + name);
    const r = await api.post<any>('hosts/update-agent', { name });
    setBusy('');
    r.ok ? toast.success(t(`Agent updated: ${r.from} → ${r.to}`, `ایجنت به‌روز شد: ${r.from} ← ${r.to}`)) : toast.error(r.error?.message ?? 'error');
    await refresh();
  };

  const connect = async (): Promise<void> => {
    setBusy('add');
    const r = await api.post('hosts/add', form);
    setBusy('');
    if (r.ok) {
      toast.success(t('Host connected', 'هاست وصل شد'));
      setAdding(false);
      setForm({ url: '', code: '', name: '' });
      await refresh();
    } else toast.error(r.error?.message ?? 'error');
  };

  const test = async (name: string): Promise<void> => {
    setBusy(name);
    const r = await api.post<{ ok: boolean; detail: string }>('hosts/test', { name });
    r.ok ? toast.success(`${name}: ${r.detail}`) : toast.error(`${name}: ${r.detail}`);
    setBusy('');
    await refresh();
  };

  const download = async (): Promise<void> => {
    const r = await api.post<{ ok: boolean; filename: string; setup_code: string; base64: string }>('agent/zip');
    const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = r.filename;
    a.click();
    URL.revokeObjectURL(url);
    setAgent({ setup_code: r.setup_code });
  };

  if (!data) return <Loading />;

  return (
    <>
      <PageTitle title={t('Hosts', 'هاست‌ها')} hint={t('Your hosting accounts. Upload the agent once, then create and publish sites from here.', 'هاست‌های شما. ایجنت را یک بار آپلود کنید، سپس سایت‌ها را از اینجا بسازید و منتشر کنید.')}>
        <Button variant="outline" onClick={download}><DownloadIcon /> {t('Download agent', 'دانلود ایجنت')}</Button>
        <Button onClick={() => setAdding(true)}><PlusIcon /> {t('Connect a host', 'اتصال هاست')}</Button>
      </PageTitle>

      {data.hosts.length === 0 ? (
        <Empty>
          <ServerIcon className="mx-auto mb-3 size-8 opacity-50" />
          <p className="font-medium">{t('Start here', 'از اینجا شروع کنید')}</p>
          <ol className="mx-auto mt-2 max-w-md list-decimal space-y-1 text-start text-sm ps-5">
            <li>{t('Press “Download agent” and upload the zip to your host (File Manager → Upload → Extract).', 'روی «دانلود ایجنت» بزنید و زیپ را روی هاست آپلود کنید (فایل‌منیجر ← آپلود ← Extract).')}</li>
            <li>{t('Open the agent address in your browser, enter the setup code, choose a username and password.', 'نشانی ایجنت را در مرورگر باز کنید، کد نصب را بزنید و نام کاربری و گذرواژه بسازید.')}</li>
            <li>{t('In the agent press “Make a pairing code”, then “Connect a host” here.', 'در ایجنت «ساخت کد اتصال» را بزنید، سپس اینجا «اتصال هاست».')}</li>
          </ol>
        </Empty>
      ) : (
        <div className="grid gap-4">
          {data.hosts.map((h) => (
            <Card key={h.name}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  <span className="truncate">{h.name}</span>
                  <StatusBadge status={h.status} />
                </CardTitle>
                <CardDescription dir="ltr" className="truncate text-start">{h.url}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                  <span>Agent {h.agent_version || '?'}</span>
                  <span>PHP {h.caps?.php?.version ?? '?'}</span>
                  <span>{h.caps?.server?.web ?? '?'}</span>
                  <span>{t('Panel', 'پنل')}: {h.caps?.panel?.name ?? '?'}</span>
                  <span>{t('Symlinks', 'symlink')}: {h.caps?.symlink_works ? '✓' : '✗'}</span>
                  <span>{t('Upload chunk', 'تکه‌ی آپلود')}: {h.caps?.limits ? `${Math.round(h.caps.limits.chunk_bytes / 1048576 * 10) / 10} MB` : '?'}</span>
                  <span>{t('Last OK', 'آخرین موفق')}: {ago(h.last_ok, lang)}</span>
                </div>
                {h.status === 'error' && <ErrorBox message={h.last_error} />}
                {open === h.name && <Sites host={h} />}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setOpen(open === h.name ? '' : h.name)}>{t('Sites & releases', 'سایت‌ها و نسخه‌ها')}</Button>
                  <Button size="sm" variant="outline" disabled={busy === 'check-' + h.name} onClick={() => check(h.name)}>{t('Check this host', 'بررسی این هاست')}</Button>
                  {data.agent_release && h.agent_version && data.agent_release !== h.agent_version && <Button size="sm" variant="outline" disabled={busy === 'update-' + h.name} onClick={() => updateAgent(h.name)}>{t(`Update agent to ${data.agent_release}`, `به‌روزرسانی ایجنت به ${data.agent_release}`)}</Button>}
                  <Button size="sm" onClick={() => setWpHost(h.name)}><PlusIcon /> {t('New WordPress site', 'سایت وردپرس جدید')}</Button>
                  <Button size="sm" variant="outline" disabled={busy === h.name} onClick={() => test(h.name)}><RefreshCwIcon /> {t('Test', 'آزمایش')}</Button>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={async () => { if (confirm(t('Disconnect this host? Sites stay online.', 'اتصال این هاست قطع شود؟ سایت‌ها آنلاین می‌مانند.'))) { await api.post('hosts/remove', { name: h.name }); await refresh(); } }}><Trash2Icon /> {t('Disconnect', 'قطع اتصال')}</Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Connect a host', 'اتصال هاست')}</DialogTitle>
            <DialogDescription>{t('Address of the folder where you uploaded the agent, and the pairing code from its panel.', 'نشانی پوشه‌ای که ایجنت را در آن آپلود کرده‌اید و کد اتصال از پنل ایجنت.')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label={t('Agent address', 'نشانی ایجنت')}><Input dir="ltr" placeholder="https://example.com/wpm-agent/" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></Field>
            <Field label={t('Pairing code', 'کد اتصال')}><Input dir="ltr" placeholder="WPMA-XXXX-XXXX-XXXX" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
            <Field label={t('Name (optional)', 'نام (اختیاری)')}><Input dir="ltr" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          </div>
          <DialogFooter><Button disabled={!form.url || !form.code || busy === 'add'} onClick={connect}>{t('Connect', 'اتصال')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!report} onOpenChange={() => setReport(null)}>
        <DialogContent className="max-h-[90svh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('Host check', 'بررسی هاست')}: {report?.host}</DialogTitle>
            <DialogDescription>{t('What this host can do, tested from inside the agent, and what the web can reach from outside.', 'این هاست چه کارهایی می‌تواند، از داخل ایجنت آزموده شده، و آنچه از بیرون از وب در دسترس است.')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1 text-sm">
            {report?.checks.map((c) => <div key={c.id} className="flex gap-2"><span className={c.status === 'ok' ? 'text-green-600' : c.status === 'warn' ? 'text-amber-600' : 'text-destructive'}>{c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗'}</span><span>{c.msg}</span></div>)}
            <div className="pt-2 font-medium">{t('Reachable from the web', 'قابل دسترسی از وب')}</div>
            {report?.exposure.map((e) => <div key={e.path} className="flex gap-2"><span className={e.safe ? 'text-green-600' : 'text-destructive'}>{e.safe ? '✓' : '✗'}</span><span dir="ltr">{e.path}</span><span className="text-muted-foreground">{e.note}</span></div>)}
          </div>
        </DialogContent>
      </Dialog>

      {wpHost && <WordPressDialog host={wpHost} onClose={() => setWpHost('')} onDone={refresh} />}

      <Dialog open={!!agent} onOpenChange={() => setAgent(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Your setup code', 'کد نصب شما')}</DialogTitle>
            <DialogDescription>{t('The zip is downloading. Upload and extract it on your host, open its address, and enter this code on the first screen.', 'زیپ در حال دانلود است. آن را روی هاست آپلود و Extract کنید، نشانی‌اش را باز کنید و این کد را در صفحه‌ی اول بزنید.')}</DialogDescription>
          </DialogHeader>
          <div dir="ltr" className="rounded-lg bg-muted p-4 text-center font-mono text-lg tracking-wider select-all">{agent?.setup_code}</div>
          <p className="text-xs text-muted-foreground">{t('The code only works once, for the zip you just downloaded.', 'این کد فقط یک بار و فقط برای همین زیپ کار می‌کند.')}</p>
        </DialogContent>
      </Dialog>
    </>
  );
}
