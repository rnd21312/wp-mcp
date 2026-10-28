import { PlayIcon, ShieldAlertIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { LevelBadge, PageTitle, Pick } from '@/components/bits';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, type State, type ToolSpec } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

type Result = Record<string, any>;

const parseParam = (def: string): { type: string; options: string[]; desc: string } => {
  const bar = def.indexOf('|');
  const type = bar < 0 ? def : def.slice(0, bar);
  const desc = bar < 0 ? '' : def.slice(bar + 1);

  return type.startsWith('enum:') ? { type: 'enum', options: type.slice(5).split(','), desc } : { type, options: [], desc };
};

export function Workbench({ state, spec, preset }: { state: State; spec: ToolSpec[]; preset: URLSearchParams }) {
  const { t } = useI18n();
  const [tool, setTool] = useState(preset.get('tool') ?? 'site');
  const [action, setAction] = useState(preset.get('action') ?? 'sites');
  const [site, setSite] = useState(preset.get('site') ?? state.sites[0]?.name ?? '');
  const [level, setLevel] = useState(preset.get('level') ?? 'live');
  const [dry, setDry] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  const toolSpec = spec.find((x) => x.name === tool) ?? spec[0];
  const actionSpec = toolSpec.actions.find((a) => a.action === action) ?? toolSpec.actions[0];

  useEffect(() => {
    if (!toolSpec.actions.some((a) => a.action === action)) setAction(toolSpec.actions[0].action);
  }, [tool]);
  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const name of Object.keys(actionSpec.params)) if (preset.get(`arg_${name}`)) initial[name] = preset.get(`arg_${name}`)!;
    setValues(initial);
    setRaw('');
    setResult(null);
  }, [tool, action]);

  const args = useMemo(() => {
    if (raw.trim()) {
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    const out: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(actionSpec.params)) {
      const v = (values[name] ?? '').trim();
      if (v === '') continue;
      const { type } = parseParam(def);
      try {
        out[name] = type === 'int' ? Number(v) : type === 'bool' ? v === 'true' : ['object', 'array', 'any'].includes(type) ? JSON.parse(v) : v;
      } catch {
        out[name] = v;
      }
    }

    return out;
  }, [values, raw, actionSpec]);

  const run = async (confirmToken?: string): Promise<void> => {
    if (args === null) {
      toast.error(t('The JSON is not valid', 'JSON معتبر نیست'));
      return;
    }
    setBusy(true);
    const r = await api.post<Result>('run', { site: site || undefined, tool, action: actionSpec.action, args, level, dry_run: dry, confirm_token: confirmToken });
    setResult(r);
    setBusy(false);
  };

  const levels = state.levels.map((l) => ({ value: l, label: l }));
  const needsConfirm = !!result?.needs_confirmation;

  return (
    <>
      <PageTitle title={t('Workbench', 'میز کار')} hint={t('Run any action by hand with the same safety rules the AI has: levels, previews and confirmations.', 'هر عملیات را دستی و با همان قواعد ایمنی هوش مصنوعی اجرا کنید: سطح‌ها، پیش‌نمایش و تأیید.')} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{t('Action', 'عملیات')}</CardTitle>
            <CardDescription>{actionSpec.summary}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t('Site', 'سایت')}</Label>
                <Pick value={site || '-'} onChange={(v) => setSite(v === '-' ? '' : v)} options={[{ value: '-', label: t('(none)', '(بدون)') }, ...state.sites.map((s) => ({ value: s.name, label: s.name }))]} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('Run as level', 'اجرا با سطح')}</Label>
                <Pick value={level} onChange={setLevel} options={levels} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t('Tool', 'ابزار')}</Label>
              <Pick value={tool} onChange={setTool} options={spec.map((x) => ({ value: x.name, label: `${x.name} · ${x.title}` }))} />
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-2">
                {t('Action', 'عملیات')} <LevelBadge level={actionSpec.level} />
                {actionSpec.confirm && <Badge variant="outline">{t('confirm', 'تأیید')}</Badge>}
              </Label>
              <Pick value={actionSpec.action} onChange={setAction} options={toolSpec.actions.map((a) => ({ value: a.action, label: a.action }))} />
            </div>

            {Object.entries(actionSpec.params).map(([name, def]) => {
              const p = parseParam(def);
              const required = actionSpec.required.includes(name);
              return (
                <div key={name} className="space-y-1.5">
                  <Label>
                    <span dir="ltr">{name}</span>
                    {required && <span className="text-destructive"> *</span>}
                  </Label>
                  {p.type === 'enum' || p.type === 'bool' ? (
                    <Pick value={values[name] || '-'} onChange={(v) => setValues({ ...values, [name]: v === '-' ? '' : v })} options={[{ value: '-', label: '—' }, ...(p.type === 'bool' ? ['true', 'false'] : p.options).map((o) => ({ value: o, label: o }))]} />
                  ) : ['object', 'array', 'any'].includes(p.type) ? (
                    <Textarea dir="ltr" rows={2} className="font-mono text-xs" placeholder={p.type === 'array' ? '["a","b"]' : p.type === 'object' ? '{"key":"value"}' : ''} value={values[name] ?? ''} onChange={(e) => setValues({ ...values, [name]: e.target.value })} />
                  ) : (
                    <Input dir="ltr" type={p.type === 'int' ? 'number' : 'text'} value={values[name] ?? ''} onChange={(e) => setValues({ ...values, [name]: e.target.value })} />
                  )}
                  {p.desc && <p className="text-xs text-muted-foreground">{p.desc}</p>}
                </div>
              );
            })}

            <details className="rounded-lg border p-3 text-sm">
              <summary className="cursor-pointer text-muted-foreground">{t('Edit arguments as JSON', 'ویرایش آرگومان‌ها به‌صورت JSON')}</summary>
              <Textarea dir="ltr" rows={5} className="mt-2 font-mono text-xs" value={raw || JSON.stringify(args ?? {}, null, 1)} onChange={(e) => setRaw(e.target.value)} />
            </details>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <Label htmlFor="dry">{t('Dry run (preview only)', 'اجرای آزمایشی (فقط پیش‌نمایش)')}</Label>
              <Switch id="dry" checked={dry} onCheckedChange={setDry} />
            </div>
            <Button className="w-full" size="lg" disabled={busy} onClick={() => run()}>
              <PlayIcon /> {busy ? t('Running…', 'در حال اجرا…') : t('Run', 'اجرا')}
            </Button>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {t('Result', 'نتیجه')}
              {result && <Badge variant="secondary" className={result.ok === false ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300' : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'}>{result.ok === false ? t('error', 'خطا') : 'ok'}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {needsConfirm && (
              <Alert>
                <ShieldAlertIcon />
                <AlertTitle>{t('Confirmation needed. Nothing has changed yet.', 'تأیید لازم است. هنوز چیزی تغییر نکرده.')}</AlertTitle>
                <AlertDescription className="space-y-3">
                  <p>{t('Read the preview below. If it is what you want, confirm.', 'پیش‌نمایش زیر را بخوانید؛ اگر همین را می‌خواهید تأیید کنید.')}</p>
                  <Button variant="destructive" disabled={busy} onClick={() => run(result!.confirm_token)}>{t('Confirm and run', 'تأیید و اجرا')}</Button>
                </AlertDescription>
              </Alert>
            )}
            {result ? (
              <pre dir="ltr" className="max-h-[70vh] overflow-auto rounded-lg border bg-muted/40 p-3 text-start font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{JSON.stringify(result, null, 2)}</pre>
            ) : (
              <p className="py-12 text-center text-sm text-muted-foreground">{t('The answer appears here.', 'پاسخ اینجا نشان داده می‌شود.')}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
