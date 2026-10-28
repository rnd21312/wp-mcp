import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, type Site, type State } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export interface RunResult<T = any> {
  ok: boolean;
  data?: T;
  revision?: number;
  error?: { code: string; message: string };
  cancelled?: boolean;
}

interface RunOpts {
  level?: string;
  dry?: boolean;
  /** Do not show an error toast. */
  silent?: boolean;
  /** Do not offer undo after a write. */
  quiet?: boolean;
  /** The person pressed Save themselves: confirm without asking again. */
  auto?: boolean;
  site?: string;
}

interface Ctx {
  state: State;
  site: Site | undefined;
  setSite: (name: string) => void;
  overview: any;
  level: string;
  setLevel: (l: string) => void;
  run: <T = any>(tool: string, action: string, args?: Record<string, unknown>, opts?: RunOpts) => Promise<RunResult<T>>;
  reload: () => Promise<void>;
}

const SiteCtx = createContext<Ctx | null>(null);

export const useSite = (): Ctx => {
  const c = useContext(SiteCtx);
  if (!c) throw new Error('SiteProvider missing');
  return c;
};

const stored = (key: string): string => {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};
const keep = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
};

export function SiteProvider({ state, reload, children }: { state: State; reload: () => Promise<void>; children: ReactNode }) {
  const { t } = useI18n();
  const [name, setName] = useState(stored('wpm_site'));
  const site = state.sites.find((s) => s.name === name) ?? state.sites[0];
  const [level, setLevelState] = useState(stored('wpm_level') || '');
  const [overview, setOverview] = useState<any>(null);
  const [pending, setPending] = useState<{ preview: any; action: string; resolve: (ok: boolean) => void } | null>(null);
  const effective = level && state.levels.includes(level) ? level : (site?.max_level ?? 'live');

  const run = useCallback(
    async <T,>(tool: string, action: string, args: Record<string, unknown> = {}, opts: RunOpts = {}): Promise<RunResult<T>> => {
      const target = opts.site ?? site?.name;
      const lv = opts.level ?? effective;
      const send = (token?: string) => api.post<any>('run', { site: target, tool, action, args, level: lv, dry_run: !!opts.dry, confirm_token: token });
      let r = await send();
      if (r.needs_confirmation) {
        const ok = opts.auto ? true : await new Promise<boolean>((resolve) => setPending({ preview: r.preview, action: r.action, resolve }));
        setPending(null);
        if (!ok) return { ok: false, cancelled: true };
        r = await send(r.confirm_token);
      }
      if (r.ok === false) {
        const message = r.error?.message ?? 'Error';
        if (!opts.silent) toast.error(message, { description: r.error?.code });
        return { ok: false, error: r.error ?? { code: 'error', message } };
      }
      if (r.revision && !opts.quiet) {
        toast.success(t('Done', 'انجام شد'), {
          action: {
            label: t('Undo', 'بازگردانی'),
            onClick: async () => {
              const u = await api.post<any>('run', { site: target, tool: 'activity', action: 'undo', args: { revision: r.revision }, level: lv });
              u.ok === false ? toast.error(u.error?.message ?? 'Undo failed') : toast.success(t('Reverted', 'بازگردانی شد'));
            },
          },
        });
      }
      return { ok: true, data: (r.data !== undefined ? r.data : r) as T, revision: r.revision };
    },
    [site?.name, effective, t],
  );

  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    setOverview(null);
    if (!site) return;
    void runRef.current('site', 'overview', {}, { silent: true }).then((r) => r.ok && setOverview(r.data));
  }, [site?.name]);

  const value = useMemo<Ctx>(
    () => ({ state, site, setSite: (n) => { setName(n); keep('wpm_site', n); }, overview, level: effective, setLevel: (l) => { setLevelState(l); keep('wpm_level', l); }, run, reload }),
    [state, site, overview, effective, run, reload],
  );

  return (
    <SiteCtx.Provider value={value}>
      {children}
      <Dialog open={!!pending} onOpenChange={(o) => !o && pending?.resolve(false)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('Please confirm', 'لطفاً تأیید کنید')}</DialogTitle>
            <DialogDescription>{t('Nothing has changed yet. This is what will happen:', 'هنوز چیزی تغییر نکرده. این اتفاق می‌افتد:')} <span dir="ltr" className="font-mono text-xs">{pending?.action}</span></DialogDescription>
          </DialogHeader>
          <pre dir="ltr" className="max-h-80 overflow-auto rounded-lg border bg-muted/40 p-3 text-start font-mono text-xs whitespace-pre-wrap break-words">{JSON.stringify(pending?.preview, null, 2)}</pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => pending?.resolve(false)}>{t('Cancel', 'انصراف')}</Button>
            <Button variant="destructive" onClick={() => pending?.resolve(true)}>{t('Confirm and run', 'تأیید و اجرا')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SiteCtx.Provider>
  );
}

/** Loads data from a site action and reloads when the site or the inputs change. */
export function useAction<T = any>(tool: string, action: string, args: Record<string, unknown> = {}, enabled = true) {
  const { run, site } = useSite();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify([site?.name, tool, action, args, enabled]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled || !site) return;
    let alive = true;
    setLoading(true);
    void run<T>(tool, action, args, { silent: true, quiet: true }).then((r) => {
      if (!alive) return;
      setLoading(false);
      if (r.ok) {
        setData(r.data as T);
        setError('');
      } else {
        setError(r.error?.message ?? 'Error');
      }
    });
    return () => {
      alive = false;
    };
  }, [key, tick]);

  return { data, error, loading, reload: () => setTick((n) => n + 1) };
}
