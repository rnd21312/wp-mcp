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
      {sites.length === 0 && <p className="text-sm text-muted-foreground">{t('No sites on this host yet.', 'هنوز سایتی روی این هاست نیست.')}</p>}
      {sites.map((s) => (
        <div key={s.id} className="rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-medium">{s.name}</span> <span className="text-muted-foreground">· {s.kind} · {s.mode} · <span dir="ltr">/{s.folder}</span></span>
            </div>
            <Button size="sm" variant="outline" onClick={() => showReleases(s.id)}>{t('Releases', 'نسخه‌ها')} ({s.releases})</Button>
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
