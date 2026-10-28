import { KeyRoundIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Code, Empty, LevelBadge, PageTitle, Pick } from '@/components/bits';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ago, api, type State } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

const scope = (s: string[] | '*', all: string): string => (s === '*' ? all : s.join(', '));

export function Access({ state, reload }: { state: State; reload: () => Promise<void> }) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [level, setLevel] = useState('draft');
  const [days, setDays] = useState('0');
  const [picked, setPicked] = useState<string[]>([]);
  const [token, setToken] = useState('');
  const levels = state.levels.map((l) => ({ value: l, label: l }));
  const all = t('all sites', 'همه‌ی سایت‌ها');

  const create = async (): Promise<void> => {
    const r = await api.post<{ ok: boolean; token: string }>('keys/create', { name, level, days: Number(days), sites: picked });
    if (r.ok) {
      setToken(r.token);
      setName('');
      await reload();
    }
  };

  return (
    <>
      <PageTitle title={t('Access', 'دسترسی‌ها')} hint={t('API keys and OAuth apps for connecting AI over the network. Local stdio connections need neither.', 'کلیدهای API و برنامه‌های OAuth برای اتصال هوش مصنوعی از راه شبکه. اتصال محلی stdio به هیچ‌کدام نیاز ندارد.')}>
        <Button onClick={() => { setToken(''); setOpen(true); }}>
          <PlusIcon /> {t('New API key', 'کلید API جدید')}
        </Button>
      </PageTitle>

      <Card>
        <CardHeader>
          <CardTitle>{t('API keys', 'کلیدهای API')}</CardTitle>
          <CardDescription>{t('A key is shown once when created. Revoke it any time.', 'کلید فقط یک بار هنگام ساخت نمایش داده می‌شود. هر زمان می‌توانید ابطالش کنید.')}</CardDescription>
        </CardHeader>
        <CardContent>
          {state.keys.length === 0 ? (
            <Empty><KeyRoundIcon className="mx-auto mb-2 size-6 opacity-50" />{t('No keys yet.', 'هنوز کلیدی نیست.')}</Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Name', 'نام')}</TableHead>
                  <TableHead>{t('Level', 'سطح')}</TableHead>
                  <TableHead>{t('Sites', 'سایت‌ها')}</TableHead>
                  <TableHead>{t('Last used', 'آخرین استفاده')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.keys.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell>
                      {k.name}
                      <div dir="ltr" className="text-start font-mono text-xs text-muted-foreground">{k.prefix}…</div>
                    </TableCell>
                    <TableCell><LevelBadge level={k.level} /></TableCell>
                    <TableCell>{scope(k.sites, all)}</TableCell>
                    <TableCell>{ago(k.last_used, lang)}</TableCell>
                    <TableCell className="text-end">
                      <Button variant="ghost" size="sm" className="text-destructive" onClick={async () => { await api.post('keys/revoke', { id: k.id }); toast.success(t('Revoked', 'ابطال شد')); await reload(); }}>
                        {t('Revoke', 'ابطال')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t('Connected apps (OAuth)', 'برنامه‌های متصل (OAuth)')}</CardTitle>
          <CardDescription>{t('Apps such as Claude.ai that you approved. Lower a level or disconnect and it applies on the next call.', 'برنامه‌هایی مثل Claude.ai که تأیید کرده‌اید. سطح را پایین بیاورید یا قطع کنید؛ از فراخوانی بعدی اعمال می‌شود.')}</CardDescription>
        </CardHeader>
        <CardContent>
          {state.clients.length === 0 ? (
            <Empty>{t('No app is connected.', 'هیچ برنامه‌ای متصل نیست.')}</Empty>
          ) : (
            <Table>
              <TableBody>
                {state.clients.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      {c.name}
                      <div className="text-xs text-muted-foreground">{scope(c.sites, all)} · {ago(c.last_used, lang)}</div>
                    </TableCell>
                    <TableCell className="w-36">
                      <Pick size="sm" value={c.level} options={levels} onChange={async (v) => { await api.post('clients/level', { id: c.id, level: v }); await reload(); }} />
                    </TableCell>
                    <TableCell className="text-end">
                      <Button variant="ghost" size="sm" className="text-destructive" onClick={async () => { await api.post('clients/revoke', { id: c.id }); await reload(); }}>
                        {t('Disconnect', 'قطع اتصال')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('New API key', 'کلید API جدید')}</DialogTitle>
            <DialogDescription>{t('Pick the lowest level that does the job.', 'کمترین سطحی را که کار را انجام می‌دهد انتخاب کنید.')}</DialogDescription>
          </DialogHeader>
          {token ? (
            <div className="space-y-3">
              <Alert>
                <AlertTitle>{t('Copy it now', 'همین الان کپی کنید')}</AlertTitle>
                <AlertDescription>{t('This key is not shown again.', 'این کلید دوباره نمایش داده نمی‌شود.')}</AlertDescription>
              </Alert>
              <Code>{token}</Code>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5"><Label>{t('Name', 'نام')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Claude Code on laptop', 'Claude Code روی لپ‌تاپ')} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5"><Label>{t('Level', 'سطح')}</Label><Pick value={level} onChange={setLevel} options={levels} /></div>
                <div className="space-y-1.5"><Label>{t('Expires after days (0 = never)', 'انقضا (روز، ۰ = هرگز)')}</Label><Input type="number" min={0} value={days} onChange={(e) => setDays(e.target.value)} /></div>
              </div>
              <div className="space-y-1.5">
                <Label>{t('Sites (none ticked = all)', 'سایت‌ها (هیچ‌کدام = همه)')}</Label>
                <div className="flex flex-wrap gap-2">
                  {state.sites.map((s) => (
                    <Button key={s.name} type="button" size="sm" variant={picked.includes(s.name) ? 'default' : 'outline'} onClick={() => setPicked(picked.includes(s.name) ? picked.filter((x) => x !== s.name) : [...picked, s.name])}>{s.name}</Button>
                  ))}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{token ? t('Close', 'بستن') : t('Cancel', 'انصراف')}</Button>
            {!token && <Button disabled={!name} onClick={create}>{t('Create key', 'ساخت کلید')}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
