import { DownloadIcon, ExternalLinkIcon, GlobeIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Empty, LevelBadge, PageTitle, Pick, StatusBadge } from '@/components/bits';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ago, api, type Site, type State } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export function Sites({ state, reload }: { state: State; reload: () => Promise<void> }) {
  const { t, lang } = useI18n();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Site | null>(null);
  const [busy, setBusy] = useState('');
  const levels = state.levels.map((l) => ({ value: l, label: l }));

  const test = async (name: string): Promise<void> => {
    setBusy(name);
    const r = await api.post<{ ok: boolean; detail: string }>('sites/test', { name });
    r.ok ? toast.success(`${name}: ${r.detail}`) : toast.error(`${name}: ${r.detail}`);
    await reload();
    setBusy('');
  };

  const downloadPlugin = async (): Promise<void> => {
    const r = await api.post<{ ok: boolean; filename: string; version: string; base64: string }>('plugin/zip');
    const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = r.filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(t(`Plugin ${r.version} downloaded. Upload it in Plugins → Add New (replace the old one).`, `افزونه ${r.version} دانلود شد. در «افزونه‌ها ← افزودن» آپلود و جایگزین کنید.`));
  };

  return (
    <>
      <PageTitle title={t('Sites', 'سایت‌ها')} hint={t('Every WordPress site the AI can work on. Names are unique and shown in every result.', 'همه‌ی سایت‌های وردپرسی که هوش مصنوعی می‌تواند رویشان کار کند. نام‌ها یکتا هستند و در هر نتیجه تکرار می‌شوند.')}>
        <Button variant="outline" onClick={downloadPlugin}>
          <DownloadIcon /> {t('Download plugin', 'دانلود افزونه')}
        </Button>
        <Button onClick={() => setAdding(true)}>
          <PlusIcon /> {t('Connect a site', 'اتصال سایت')}
        </Button>
      </PageTitle>

      {state.sites.length === 0 ? (
        <Empty>
          <GlobeIcon className="mx-auto mb-3 size-8 opacity-50" />
          {t('No site yet. Install the plugin on your site, create a pairing code and connect it here.', 'هنوز سایتی نیست. افزونه را روی سایت نصب کنید، کد جفت‌سازی بسازید و اینجا وصلش کنید.')}
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {state.sites.map((s) => (
            <Card key={s.name}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  <span className="truncate">{s.name}</span>
                  <StatusBadge status={s.status} />
                </CardTitle>
                <CardDescription dir="ltr" className="truncate text-start">
                  <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                    {s.url} <ExternalLinkIcon className="size-3" />
                  </a>
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {s.title && <div className="font-medium">{s.title}</div>}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                  <span>WordPress {s.wp_version || '?'}</span>
                  <span>Bridge {s.plugin_version || '?'}</span>
                  <span>{t('Last OK', 'آخرین موفق')}: {ago(s.last_ok, lang)}</span>
                </div>
                {s.status === 'error' && s.last_error && (
                  <Alert variant="destructive">
                    <AlertTitle>{t('Last problem', 'آخرین مشکل')}</AlertTitle>
                    <AlertDescription>{s.last_error}</AlertDescription>
                  </Alert>
                )}
                <div>
                  <Label className="mb-1.5 flex items-center gap-2">
                    {t('Highest level on this site', 'بالاترین سطح روی این سایت')} <LevelBadge level={s.max_level} />
                  </Label>
                  <Pick
                    value={s.max_level}
                    options={levels}
                    onChange={async (level) => {
                      await api.post('sites/level', { name: s.name, level });
                      toast.success(t('Ceiling updated', 'سقف سطح تغییر کرد'));
                      await reload();
                    }}
                  />
                </div>
              </CardContent>
              <CardFooter className="gap-2">
                <Button variant="outline" size="sm" disabled={busy === s.name} onClick={() => test(s.name)}>
                  <RefreshCwIcon className={busy === s.name ? 'animate-spin' : ''} /> {t('Test', 'آزمایش')}
                </Button>
                <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setRemoving(s)}>
                  <Trash2Icon /> {t('Remove', 'حذف')}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <AddSite open={adding} onClose={() => setAdding(false)} state={state} reload={reload} />

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Remove this site?', 'این سایت حذف شود؟')}</DialogTitle>
            <DialogDescription>{t('Only the connection is removed. Nothing changes on the website; you can connect it again with a new pairing code.', 'فقط اتصال حذف می‌شود. روی خود وب‌سایت چیزی عوض نمی‌شود و با کد جفت‌سازی تازه می‌توانید دوباره وصلش کنید.')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>{t('Cancel', 'انصراف')}</Button>
            <Button
              variant="destructive"
              onClick={async () => {
                await api.post('sites/remove', { name: removing!.name });
                setRemoving(null);
                toast.success(t('Removed', 'حذف شد'));
                await reload();
              }}
            >
              {t('Remove', 'حذف')} {removing?.name}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AddSite({ open, onClose, state, reload }: { open: boolean; onClose: () => void; state: State; reload: () => Promise<void> }) {
  const { t } = useI18n();
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [level, setLevel] = useState('live');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError('');
    const r = await api.post<{ ok: boolean; error?: { message: string }; site?: Site }>('sites/add', { url, code, name, max_level: level });
    setBusy(false);
    if (!r.ok) {
      setError(r.error?.message ?? 'Failed');
      return;
    }
    toast.success(t(`Connected "${r.site?.name}"`, `«${r.site?.name}» وصل شد`));
    setUrl('');
    setCode('');
    setName('');
    onClose();
    await reload();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Connect a site', 'اتصال سایت')}</DialogTitle>
          <DialogDescription>
            {t('In WordPress open Tools → WP MCP Bridge and press "Create pairing code". The code works once for 15 minutes.', 'در وردپرس به ابزارها ← WP MCP Bridge بروید و «Create pairing code» را بزنید. کد ۱۵ دقیقه و فقط یک بار معتبر است.')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t('Site address', 'آدرس سایت')}</Label>
            <Input dir="ltr" placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('Pairing code', 'کد جفت‌سازی')}</Label>
            <Input dir="ltr" placeholder="WPMP-XXXX-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('Unique name (optional)', 'نام یکتا (اختیاری)')}</Label>
              <Input dir="ltr" placeholder="mysite" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('Highest level allowed', 'بالاترین سطح مجاز')}</Label>
              <Pick value={level} onChange={setLevel} options={state.levels.map((l) => ({ value: l, label: l }))} />
            </div>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('Cancel', 'انصراف')}</Button>
          <Button disabled={busy || !url || !code} onClick={submit}>{busy ? t('Connecting…', 'در حال اتصال…') : t('Connect', 'اتصال')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
