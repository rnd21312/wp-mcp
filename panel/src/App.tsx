import { ActivityIcon, ArrowLeftRightIcon, BrushIcon, MousePointerClickIcon, ScanSearchIcon, CodeIcon, FileTextIcon, GlobeIcon, ImageIcon, KeyRoundIcon, LayoutDashboardIcon, MoonIcon, PlugIcon, PlugZapIcon, SearchCheckIcon, ShoppingBagIcon, SunIcon, TerminalSquareIcon, WrenchIcon, type LucideIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Pick } from '@/components/bits';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { api, type State, type ToolSpec } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { SiteProvider, useSite } from '@/lib/site';
import { cn } from '@/lib/utils';
import { Access } from '@/pages/Access';
import { ActivityPage } from '@/pages/ActivityPage';
import { Maintenance, Plugins } from '@/pages/Care';
import { Connect } from '@/pages/Connect';
import { ContentEditor, ContentList } from '@/pages/Content';
import { Design } from '@/pages/Design';
import { Developer, Transfer } from '@/pages/Dev';
import { MediaPage } from '@/pages/Media';
import { Overview } from '@/pages/Overview';
import { Seo } from '@/pages/Seo';
import { Inspector } from '@/pages/Inspector';
import { CodeEditor } from '@/pages/Editor';
import { Shop } from '@/pages/Shop';
import { Sites } from '@/pages/Sites';
import { Workbench } from '@/pages/Workbench';
import { NeedSite } from '@/components/common';

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

interface NavItem { path: string; label: string; icon: LucideIcon; hide?: boolean }

function Shell({ state, spec, reload }: { state: State; spec: ToolSpec[]; reload: () => Promise<void> }) {
  const { t, lang, setLang } = useI18n();
  const { resolvedTheme, setTheme } = useTheme();
  const { site, setSite, level, setLevel, overview } = useSite();
  const [path, query, go] = useHash();

  const groups: { title: string; items: NavItem[] }[] = [
    { title: t('Manage', 'مدیریت'), items: [
      { path: '/', label: t('Overview', 'نمای کلی'), icon: LayoutDashboardIcon },
      { path: '/content', label: t('Content', 'محتوا'), icon: FileTextIcon },
      { path: '/media', label: t('Media', 'رسانه'), icon: ImageIcon },
      { path: '/shop', label: t('Shop', 'فروشگاه'), icon: ShoppingBagIcon, hide: overview ? !overview.woocommerce : false },
      { path: '/editor', label: t('Code & visual editor', 'ویرایشگر کد و بصری'), icon: MousePointerClickIcon },
      { path: '/seo', label: t('SEO', 'سئو'), icon: SearchCheckIcon },
      { path: '/inspector', label: t('URL Inspector', 'بازرس URL'), icon: ScanSearchIcon },
      { path: '/design', label: t('Design', 'طراحی'), icon: BrushIcon },
    ] },
    { title: t('Care', 'نگهداری'), items: [
      { path: '/maintenance', label: t('Maintenance', 'نگهداری'), icon: WrenchIcon },
      { path: '/plugins', label: t('Plugins', 'افزونه‌ها'), icon: PlugIcon },
      { path: '/transfer', label: t('Copy between sites', 'کپی بین سایت‌ها'), icon: ArrowLeftRightIcon },
    ] },
    { title: t('Developer', 'برنامه‌نویس'), items: [
      { path: '/dev', label: t('Theme & REST', 'پوسته و REST'), icon: CodeIcon },
      { path: '/workbench', label: t('Workbench', 'میز کار'), icon: TerminalSquareIcon },
    ] },
    { title: t('Setup', 'تنظیمات'), items: [
      { path: '/sites', label: t('Sites', 'سایت‌ها'), icon: GlobeIcon },
      { path: '/connect', label: t('Connect AI', 'اتصال هوش مصنوعی'), icon: PlugZapIcon },
      { path: '/access', label: t('Access', 'دسترسی‌ها'), icon: KeyRoundIcon },
      { path: '/activity', label: t('Activity', 'فعالیت‌ها'), icon: ActivityIcon },
    ] },
  ];

  const siteOnly = (el: ReactElement): ReactElement => <NeedSite>{el}</NeedSite>;
  let page: ReactElement = <Overview state={state} go={go} />;
  if (path === '/sites') page = <Sites state={state} reload={reload} />;
  else if (path === '/connect') page = <Connect state={state} />;
  else if (path === '/access') page = <Access state={state} reload={reload} />;
  else if (path === '/activity') page = <ActivityPage />;
  else if (path === '/workbench' && spec.length) page = <Workbench key={location.hash} state={state} spec={spec} preset={query} />;
  else if (path === '/content') page = siteOnly(<ContentList key={`${site?.name}${query.get('type')}`} query={query} go={go} />);
  else if (path === '/content/edit') page = siteOnly(<ContentEditor key={`${site?.name}${location.hash}`} query={query} go={go} />);
  else if (path === '/media') page = siteOnly(<MediaPage key={site?.name} />);
  else if (path === '/shop') page = siteOnly(<Shop key={site?.name} />);
  else if (path === '/editor') page = siteOnly(<CodeEditor key={site?.name} go={go} />);
  else if (path === '/inspector') page = <Inspector key={site?.name} />;
  else if (path === '/seo') page = siteOnly(<Seo key={site?.name} />);
  else if (path === '/design') page = siteOnly(<Design key={site?.name} />);
  else if (path === '/maintenance') page = siteOnly(<Maintenance key={site?.name} />);
  else if (path === '/plugins') page = siteOnly(<Plugins key={site?.name} />);
  else if (path === '/dev') page = siteOnly(<Developer key={site?.name} go={go} />);
  else if (path === '/transfer') page = <Transfer />;

  if (path === '/editor' && site) return <><CodeEditor key={site.name} go={go} /><Toaster position="top-center" /></>;

  const active = (p: string): boolean => (p === '/' ? path === '/' : path === p || path.startsWith(`${p}/`));

  return (
    <div className="min-h-svh bg-background text-foreground md:flex">
      <aside className="border-b md:sticky md:top-0 md:h-svh md:w-60 md:shrink-0 md:overflow-y-auto md:border-e md:border-b-0">
        <div className="flex flex-col gap-4 px-3 py-3 md:py-5">
          <div className="flex items-center justify-between">
            <a href="#/" className="flex items-center gap-2 font-semibold tracking-tight"><span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">W</span>WP MCP</a>
            <div className="flex gap-1 md:hidden">
              <Button variant="outline" size="sm" onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')}>{lang === 'fa' ? 'EN' : 'فا'}</Button>
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto md:flex-col md:gap-4 md:overflow-visible">
            {groups.map((g) => (
              <div key={g.title} className="flex gap-1 md:flex-col">
                <div className="hidden px-3 pb-1 text-xs font-medium text-muted-foreground md:block">{g.title}</div>
                {g.items.filter((n) => !n.hide).map((n) => (
                  <a key={n.path} href={`#${n.path}`} className={cn('flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors hover:bg-muted', active(n.path) ? 'bg-muted font-medium' : 'text-muted-foreground')}><n.icon className="size-4" /> {n.label}</a>
                ))}
              </div>
            ))}
          </nav>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background/85 px-4 py-2 backdrop-blur md:px-8">
          <div className="w-48">{state.sites.length > 0 ? <Pick size="sm" value={site?.name ?? ''} onChange={setSite} options={state.sites.map((s) => ({ value: s.name, label: s.name }))} /> : <span className="text-sm text-muted-foreground">{t('No site connected', 'سایتی وصل نیست')}</span>}</div>
          <div className="w-32" title={t('Level the panel acts at', 'سطحی که پنل با آن کار می‌کند')}><Pick size="sm" value={level} onChange={setLevel} options={state.levels.map((l) => ({ value: l, label: l }))} /></div>
          {site && <a dir="ltr" href={site.url} target="_blank" rel="noreferrer" className="hidden truncate text-xs text-muted-foreground hover:underline sm:block">{site.url}</a>}
          <div className="ms-auto hidden gap-1 md:flex">
            <Button variant="outline" size="sm" onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')}>{lang === 'fa' ? 'EN' : 'فا'}</Button>
            <Button variant="outline" size="icon-sm" aria-label="theme" onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>{resolvedTheme === 'dark' ? <SunIcon /> : <MoonIcon />}</Button>
          </div>
        </header>
        <main className="p-4 md:p-8"><div className={path === '/visual' ? '' : 'mx-auto max-w-6xl'}>{page}</div></main>
      </div>
      <Toaster position="top-center" />
    </div>
  );
}

export default function App() {
  const { t } = useI18n();
  const [state, setState] = useState<State | null>(null);
  const [spec, setSpec] = useState<ToolSpec[]>([]);
  const [error, setError] = useState('');

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
    const id = setInterval(reload, 20000);
    return () => clearInterval(id);
  }, [reload]);

  if (!state) return <div className="grid min-h-svh place-items-center text-sm text-muted-foreground">{error || '…'}</div>;

  return (
    <SiteProvider state={state} reload={reload}>
      <Shell state={state} spec={spec} reload={reload} />
    </SiteProvider>
  );
}
