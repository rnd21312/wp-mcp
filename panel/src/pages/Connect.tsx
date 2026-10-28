import { Code, PageTitle } from '@/components/bits';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { type State } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

const slash = (s: string): string => s.replace(/\\/g, '/');

export function Connect({ state }: { state: State }) {
  const { t } = useI18n();
  const entry = slash(state.entry);
  const data = slash(state.dataDir);
  const url = `${state.publicUrl}/mcp`;
  const desktop = JSON.stringify({ mcpServers: { wp: { command: 'node', args: [entry, 'stdio'], env: { WPMCP_DATA_DIR: data, WPMCP_STDIO_LEVEL: 'draft' } } } }, null, 2);
  const remote = JSON.stringify({ mcpServers: { wp: { url, headers: { Authorization: 'Bearer wpmk_YOUR_KEY' } } } }, null, 2);

  return (
    <>
      <PageTitle title={t('Connect an AI app', 'اتصال برنامه‌ی هوش مصنوعی')} hint={t('Copy, paste, done. Everything is filled in for this installation.', 'کپی کنید، جایگذاری کنید، تمام. همه‌چیز برای همین نصب پر شده است.')} />
      <Tabs defaultValue="code">
        <TabsList>
          <TabsTrigger value="code">Claude Code</TabsTrigger>
          <TabsTrigger value="desktop">Claude Desktop</TabsTrigger>
          <TabsTrigger value="remote">{t('Over the network', 'از راه شبکه')}</TabsTrigger>
        </TabsList>

        <TabsContent value="code" className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">{t('Runs the gateway on this computer when Claude Code needs it. No server, no domain. Run once in a terminal:', 'وقتی Claude Code لازم داشته باشد، gateway را روی همین کامپیوتر اجرا می‌کند. بدون سرور و دامنه. یک بار در ترمینال اجرا کنید:')}</p>
          <Code>{`claude mcp add wp -e WPMCP_DATA_DIR=${data} -e WPMCP_STDIO_LEVEL=draft -- node ${entry} stdio`}</Code>
          <p className="text-sm text-muted-foreground">{t('WPMCP_STDIO_LEVEL is the level the AI works at: draft prepares content, live publishes and designs, admin only for maintenance.', 'WPMCP_STDIO_LEVEL سطح کار هوش مصنوعی است: draft محتوا آماده می‌کند، live منتشر و طراحی می‌کند، admin فقط برای نگهداری.')}</p>
        </TabsContent>

        <TabsContent value="desktop" className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">{t('Add this to claude_desktop_config.json (Settings → Developer → Edit config), then restart Claude Desktop.', 'این را به claude_desktop_config.json اضافه کنید (Settings ← Developer ← Edit config) و Claude Desktop را دوباره باز کنید.')}</p>
          <Code>{desktop}</Code>
        </TabsContent>

        <TabsContent value="remote" className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">{t('For Claude.ai on the web, Cursor, or another computer the gateway needs a public https address (WPMCP_PUBLIC_URL). Endpoint:', 'برای Claude.ai روی وب، Cursor یا کامپیوتر دیگر، gateway باید یک آدرس عمومی https داشته باشد (WPMCP_PUBLIC_URL). آدرس:')}</p>
          <Code>{url}</Code>
          <Code>{`claude mcp add --transport http wp ${url} --header "Authorization: Bearer wpmk_YOUR_KEY"`}</Code>
          <Code>{remote}</Code>
          <p className="text-sm text-muted-foreground">{t('Create the key under Access. Claude.ai: Settings → Connectors → Add custom connector.', 'کلید را در بخش دسترسی‌ها بسازید. Claude.ai: Settings ← Connectors ← Add custom connector.')}</p>
        </TabsContent>
      </Tabs>
    </>
  );
}
