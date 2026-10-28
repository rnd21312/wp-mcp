import { ActivityIcon, KeyRoundIcon, LayoutDashboardIcon, MoonIcon, PlugZapIcon, SunIcon, TerminalSquareIcon, GlobeIcon, type LucideIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useState } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { api, type State, type ToolSpec } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Access } from '@/pages/Access';
import { ActivityPage } from '@/pages/ActivityPage';
import { Connect } from '@/pages/Connect';
import { Overview } from '@/pages/Overview';
import { Sites } from '@/pages/Sites';
import { Workbench } from '@/pages/Workbench';

const useHash = (): [string, URLSearchParams, (h: string) => void] => {
  const read = (): string => location.hash || '#/';
  const [hash, setHash] = useState(read);
  useEffect(() => {
    const on = (): void => setHash(read());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const [path, query = ''] = hash.slice(1).split('?');

  return [path || '/', new URLSearchParams(query), (h) => { location.hash = h; }];
};

export default function App() {
  const { t, lang, setLang } = useI18n();
  const { resolvedTheme, setTheme } = useTheme();
  const [state, setState] = useState<State | null>(null);
  const [spec, setSpec] = useState<ToolSpec[]>([]);
  const [error, setError] = useState('');
  const [path, query, go] = useHash();

  const reload = useCallback(async (): Promise<void> => {
    try {
      setState(await api.state());
      setError('');
    } catch {
      setError(t('Cannot reach the gateway. Is it still running?', 'به gateway نمی‌رسم. هنوز در حال اجراست؟'));
    }
  }, [t]);

  useEffect(() => {
    void reload();
    void api.spec().then(setSpec).catch(() => undefined);
    const id = setInterval(reload, 15000);
    return () => clearInterval(id);
  }, [reload]);

  const nav: { path: string; label: string; icon: LucideIcon }[] = [
    { path: '/', label: t('Overview', 'نمای کلی'), icon: LayoutDashboardIcon },
    { path: '/sites', label: t('Sites', 'سایت‌ها'), icon: GlobeIcon },
    { path: '/workbench', label: t('Workbench', 'میز کار'), icon: TerminalSquareIcon },
    { path: '/connect', label: t('Connect AI', 'اتصال هوش مصنوعی'), icon: PlugZapIcon },
    { path: '/access', label: t('Access', 'دسترسی‌ها'), icon: KeyRoundIcon },
    { path: '/activity', label: t('Activity', 'فعالیت‌ها'), icon: ActivityIcon },
  ];

  let page = <p className="text-muted-foreground">…</p>;
  if (state) {
    if (path === '/sites') page = <Sites state={state} reload={reload} />;
    else if (path === '/workbench' && spec.length) page = <Workbench key={location.hash} state={state} spec={spec} preset={query} />;
    else if (path === '/connect') page = <Connect state={state} />;
    else if (path === '/access') page = <Access state={state} reload={reload} />;
    else if (path === '/activity') page = <ActivityPage />;
    else if (path === '/') page = <Overview state={state} go={go} />;
  }

  return (
    <div className="min-h-svh bg-background text-foreground md:flex">
      <aside className="border-b md:sticky md:top-0 md:h-svh md:w-60 md:shrink-0 md:border-e md:border-b-0">
        <div className="flex items-center justify-between gap-2 px-4 py-3 md:flex-col md:items-stretch md:gap-6 md:py-5">
          <a href="#/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">W</span>
            WP MCP
          </a>
          <nav className="flex gap-1 overflow-x-auto md:flex-col">
            {nav.map((n) => (
              <a key={n.path} href={`#${n.path}`} className={cn('flex items-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors hover:bg-muted', path === n.path ? 'bg-muted font-medium' : 'text-muted-foreground')}>
                <n.icon className="size-4" /> {n.label}
              </a>
            ))}
          </nav>
          <div className="flex gap-1 md:mt-auto">
            <Button variant="outline" size="sm" onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')}>{lang === 'fa' ? 'EN' : 'فا'}</Button>
            <Button variant="outline" size="icon-sm" aria-label="theme" onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>
              {resolvedTheme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </Button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">
        <div className="mx-auto max-w-5xl">
          {error && <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
          {page}
        </div>
      </main>
      <Toaster position="top-center" />
    </div>
  );
}
