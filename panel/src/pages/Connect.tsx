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
          <TabsTrigger value="chatgpt">ChatGPT</TabsTrigger>
          <TabsTrigger value="others">{t('Gemini, Cursor, others', 'Gemini، Cursor، بقیه')}</TabsTrigger>
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

        <TabsContent value="chatgpt" className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">{t('ChatGPT can use this gateway as a remote MCP connector (Pro, Plus, Business, Enterprise, Edu with developer mode). ChatGPT\'s servers must reach the gateway, so it needs a public https address (WPMCP_PUBLIC_URL), not the local panel.', 'ChatGPT می‌تواند این gateway را به‌عنوان connector راه‌دور MCP استفاده کند (طرح‌های Pro، Plus، Business، Enterprise، Edu با حالت developer). سرورهای ChatGPT باید به gateway برسند، پس به آدرس عمومی https نیاز دارد (WPMCP_PUBLIC_URL) نه پنل محلی.')}</p>
          <ol className="list-decimal space-y-1 ps-5 text-sm text-muted-foreground"><li>{t('Run the gateway on a server or behind a tunnel with https.', 'gateway را روی سرور یا پشت تونل با https اجرا کنید.')}</li><li>{t('ChatGPT → Settings → Connectors → Advanced → Developer mode.', 'ChatGPT ← Settings ← Connectors ← Advanced ← Developer mode.')}</li><li>{t('Create a connector, URL below, authentication OAuth. Approve on the gateway page that opens.', 'یک connector بسازید، آدرس زیر، احراز هویت OAuth. در صفحه‌ی gateway که باز می‌شود تأیید کنید.')}</li></ol>
          <Code>{url}</Code>
          <p className="text-sm text-muted-foreground">{t('Without a server: use the AI assistant page with your OpenAI key. It talks to OpenAI from this computer and uses the same tools.', 'بدون سرور: از صفحه‌ی دستیار هوش مصنوعی با کلید OpenAI خودتان استفاده کنید. از همین کامپیوتر با OpenAI حرف می‌زند و همان ابزارها را به‌کار می‌برد.')}</p>
        </TabsContent>

        <TabsContent value="others" className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">{t('Any MCP client works. Local clients use the stdio command; remote clients use the https endpoint and a key from Access.', 'هر کلاینت MCP کار می‌کند. کلاینت‌های محلی از فرمان stdio و راه‌دور از آدرس https و کلیدی از بخش دسترسی‌ها استفاده می‌کنند.')}</p>
          <div className="text-sm font-medium">Gemini CLI (~/.gemini/settings.json)</div>
          <Code>{desktop}</Code>
          <div className="text-sm font-medium">Cursor (.cursor/mcp.json) · Windsurf · Cline · Zed</div>
          <Code>{desktop}</Code>
          <div className="text-sm font-medium">Codex CLI (~/.codex/config.toml)</div>
          <Code>{`[mcp_servers.wp]\ncommand = "node"\nargs = ["${entry}", "stdio"]\nenv = { WPMCP_DATA_DIR = "${data}", WPMCP_STDIO_LEVEL = "draft" }`}</Code>
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
