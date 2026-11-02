import { ActivityIcon, ArrowLeftRightIcon, MousePointerClickIcon, BotIcon, BrushIcon, ChartLineIcon, CodeIcon, FileTextIcon, FolderGit2Icon, GlobeIcon, ImageIcon, KeyRoundIcon, LayoutDashboardIcon, MoonIcon, PlugIcon, PlugZapIcon, ScanSearchIcon, SearchCheckIcon, ServerIcon, ShoppingBagIcon, SparklesIcon, SunIcon, TerminalSquareIcon, WrenchIcon, type LucideIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Pick } from '@/components/bits';
import { NeedSite } from '@/components/common';
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { api, type State, type ToolSpec } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { SiteProvider, useSite } from '@/lib/site';
import { Access } from '@/pages/Access';
import { ActivityPage } from '@/pages/ActivityPage';
import { AiPage } from '@/pages/Ai';
import { Builder } from '@/pages/Builder';
import { Maintenance, Plugins } from '@/pages/Care';
import { Connect } from '@/pages/Connect';
import { ContentEditor, ContentList } from '@/pages/Content';
import { Design } from '@/pages/Design';
import { Developer, Transfer } from '@/pages/Dev';
import { Hosts } from '@/pages/Hosts';
import { Inspector } from '@/pages/Inspector';
import { MediaPage } from '@/pages/Media';
import { Overview } from '@/pages/Overview';
import { Projects } from '@/pages/Projects';
import { SearchConsole } from '@/pages/SearchConsole';
import { Seo } from '@/pages/Seo';
import { Shop } from '@/pages/Shop';
import { Sites } from '@/pages/Sites';
import { Visual } from '@/pages/Visual';
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

interface NavItem { path: string; label: string; icon: LucideIcon; hide?: boolean }

function Shell({ state, spec, reload }: { state: State; spec: ToolSpec[]; reload: () => Promise<void> }) {
  const { t, lang, setLang } = useI18n();
  const { resolvedTheme, setTheme } = useTheme();
  const { site, setSite, level, setLevel, overview } = useSite();
  const [path, query, go] = useHash();

  const groups: { title: string; items: NavItem[] }[] = [
    { title: t('Site', 'سایت'), items: [
      { path: '/', label: t('Overview', 'نمای کلی'), icon: LayoutDashboardIcon },
      { path: '/content', label: t('Content', 'محتوا'), icon: FileTextIcon },
      { path: '/media', label: t('Media', 'رسانه'), icon: ImageIcon },
      { path: '/shop', label: t('Shop', 'فروشگاه'), icon: ShoppingBagIcon, hide: overview ? !overview.woocommerce : false },
      { path: '/visual', label: t('Visual editor', 'ویرایشگر بصری'), icon: MousePointerClickIcon },
      { path: '/design', label: t('Design', 'طراحی'), icon: BrushIcon },
    ] },
    { title: t('Search', 'جستجو'), items: [
      { path: '/seo', label: t('SEO', 'سئو'), icon: SearchCheckIcon },
      { path: '/search-console', label: t('Search Console', 'سرچ کنسول گوگل'), icon: ChartLineIcon },
      { path: '/inspector', label: t('URL Inspector', 'بازرس URL'), icon: ScanSearchIcon },
    ] },
    { title: t('Build & publish', 'ساخت و انتشار'), items: [
      { path: '/builder', label: t('AI site builder', 'سازنده‌ی سایت با AI'), icon: SparklesIcon },
      { path: '/projects', label: t('Projects', 'پروژه‌ها'), icon: FolderGit2Icon },
      { path: '/hosts', label: t('Hosts', 'هاست‌ها'), icon: ServerIcon },
    ] },
    { title: t('Care', 'نگهداری'), items: [
      { path: '/maintenance', label: t('Maintenance', 'نگهداری'), icon: WrenchIcon },
      { path: '/plugins', label: t('Plugins', 'افزونه‌ها'), icon: PlugIcon },
      { path: '/transfer', label: t('Copy between sites', 'کپی بین سایت‌ها'), icon: ArrowLeftRightIcon },
    ] },
    { title: t('AI & developer', 'هوش مصنوعی و برنامه‌نویس'), items: [
      { path: '/ai', label: t('AI assistant', 'دستیار هوش مصنوعی'), icon: BotIcon },
      { path: '/workbench', label: t('Workbench', 'میز کار'), icon: TerminalSquareIcon },
      { path: '/dev', label: t('Theme & REST', 'پوسته و REST'), icon: CodeIcon },
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
  if (path === '/hosts') page = <Hosts />;
  else if (path === '/builder') page = <Builder />;
  else if (path === '/projects') page = <Projects />;
  else if (path === '/sites') page = <Sites state={state} reload={reload} />;
  else if (path === '/connect') page = <Connect state={state} />;
  else if (path === '/access') page = <Access state={state} reload={reload} />;
  else if (path === '/activity') page = <ActivityPage />;
  else if (path === '/workbench' && spec.length) page = <Workbench key={location.hash} state={state} spec={spec} preset={query} />;
  else if (path === '/content') page = siteOnly(<ContentList key={`${site?.name}${query.get('type')}`} query={query} go={go} />);
  else if (path === '/content/edit') page = siteOnly(<ContentEditor key={`${site?.name}${location.hash}`} query={query} go={go} />);
  else if (path === '/media') page = siteOnly(<MediaPage key={site?.name} />);
  else if (path === '/shop') page = siteOnly(<Shop key={site?.name} />);
  else if (path === '/ai') page = <AiPage key={site?.name} />;
  else if (path === '/inspector') page = <Inspector key={site?.name} />;
  else if (path === '/search-console') page = <SearchConsole />;
  else if (path === '/seo') page = siteOnly(<Seo key={site?.name} />);
  else if (path === '/visual') page = siteOnly(<Visual key={site?.name} />);
  else if (path === '/design') page = siteOnly(<Design key={site?.name} />);
  else if (path === '/maintenance') page = siteOnly(<Maintenance key={site?.name} />);
  else if (path === '/plugins') page = siteOnly(<Plugins key={site?.name} />);
  else if (path === '/dev') page = siteOnly(<Developer key={site?.name} go={go} />);
  else if (path === '/transfer') page = <Transfer />;

  const active = (p: string): boolean => (p === '/' ? path === '/' : path === p || path.startsWith(`${p}/`));
  const current = groups.flatMap((g) => g.items.map((n) => ({ ...n, group: g.title }))).find((n) => active(n.path));

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" side={lang === 'fa' ? 'right' : 'left'}>
        <SidebarHeader className="gap-3">
          <a href="#/" className="flex items-center gap-2 px-1 font-semibold tracking-tight">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">W</span>
            <span className="truncate group-data-[collapsible=icon]:hidden">WP MCP</span>
          </a>
          <div className="group-data-[collapsible=icon]:hidden">
            {state.sites.length > 0
              ? <Pick value={site?.name ?? ''} onChange={setSite} options={state.sites.map((s) => ({ value: s.name, label: s.name }))} />
              : <span className="px-1 text-sm text-muted-foreground">{t('No site connected', 'سایتی وصل نیست')}</span>}
          </div>
        </SidebarHeader>
        <SidebarContent>
          {groups.map((g) => (
            <SidebarGroup key={g.title}>
              <SidebarGroupLabel>{g.title}</SidebarGroupLabel>
              <SidebarMenu>
                {g.items.filter((n) => !n.hide).map((n) => (
                  <SidebarMenuItem key={n.path}>
                    <SidebarMenuButton isActive={active(n.path)} tooltip={n.label} render={<a href={`#${n.path}`} />}>
                      <n.icon />
                      <span>{n.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mx-1 h-5" />
          <Breadcrumb className="min-w-0">
            <BreadcrumbList>
              {current && <BreadcrumbItem className="hidden sm:block">{current.group}</BreadcrumbItem>}
              {current && <BreadcrumbSeparator className="hidden sm:block" />}
              <BreadcrumbItem><BreadcrumbPage className="truncate">{current?.label ?? t('Content', 'محتوا')}</BreadcrumbPage></BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="ms-auto flex items-center gap-2">
            {site && <a dir="ltr" href={site.url} target="_blank" rel="noreferrer" className="hidden max-w-56 truncate text-xs text-muted-foreground hover:underline lg:block">{site.url}</a>}
            <div className="w-28" title={t('Level the panel acts at', 'سطحی که پنل با آن کار می‌کند')}><Pick size="sm" value={level} onChange={setLevel} options={state.levels.map((l) => ({ value: l, label: l }))} /></div>
            <Button variant="outline" size="sm" onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')}>{lang === 'fa' ? 'EN' : 'فا'}</Button>
            <Button variant="outline" size="icon-sm" aria-label="theme" onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>{resolvedTheme === 'dark' ? <SunIcon /> : <MoonIcon />}</Button>
          </div>
        </header>
        <main className="p-4 md:p-8"><div className={path === '/visual' ? '' : 'mx-auto max-w-6xl'}>{page}</div></main>
      </SidebarInset>
      <Toaster position="top-center" />
    </SidebarProvider>
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
