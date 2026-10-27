# اتصال یک برنامه‌ی هوش مصنوعی

آدرس شما `https://mcp.example.com/mcp` است (مقدار `WPMCP_PUBLIC_URL` به‌علاوه `/mcp`). دو روش ورود هست و ابزارها یکسان‌اند.

* **OAuth 2.1** (ورود با مرورگر): Claude.ai و منوی `/mcp` در Claude Code. در صفحه‌ی تأیید **سطح** و **سایت‌ها** را انتخاب می‌کنید؛ نام برنامه و، با حروف درشت، **دامنه‌ای که نتیجه‌ی ورود به آن فرستاده می‌شود** نمایش داده می‌شود. توکن‌ها خودشان تمدید می‌شوند (refresh token ۱۸۰ روز).
* **کلید API** (یک header): برای اسکریپت، CI و کلاینت‌های بدون OAuth. در پنل ← *API keys* با سطح، فهرست اختیاری سایت و انقضای اختیاری بسازید. فقط یک بار نمایش داده می‌شود.

با کمترین سطحی که کار را انجام می‌دهد شروع کنید: `read` برای مرور و ممیزی، `draft` برای آماده‌کردن محتوا، `live` برای انتشار و طراحی، `admin` فقط برای نشست‌های نگهداری. سطح هر برنامه را هر زمان در پنل می‌توانید پایین بیاورید؛ از فراخوانی بعدی اعمال می‌شود.

## Claude.ai (وب و دسکتاپ)

*Settings ← Connectors ← Add custom connector*، یک نام، آدرس `https://mcp.example.com/mcp`، **Add** و بعد **Connect**. تبی روی gateway باز می‌شود: به‌عنوان مالک وارد شوید، سطح و سایت‌ها را انتخاب و **Approve** کنید. در گفتگو، connector را از منوی ابزارها روشن کنید. اولین کار هوش مصنوعی باید `site ← sites` باشد.

## Claude Code

با OAuth:

```bash
claude mcp add --transport http wp https://mcp.example.com/mcp
# سپس داخل Claude Code:  /mcp  ← انتخاب "wp" ← Authenticate
```

با کلید API:

```bash
claude mcp add --transport http wp https://mcp.example.com/mcp \
  --header "Authorization: Bearer wpmk_XXXXXXXX"
```

برای استفاده در همه‌ی پروژه‌ها `--scope user` بگذارید، یا یک `.mcp.json` **بدون کلید** commit کنید (با `${WPMCP_KEY}`).

## Claude Desktop با gateway محلی (بدون HTTPS و OAuth)

gateway را روی کامپیوتر خودتان اجرا کنید و بگذارید برنامه آن را با stdio راه بیندازد. فایل `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wp": {
      "command": "node",
      "args": ["D:/Github/wp-mcp/gateway/dist/index.js", "stdio"],
      "env": { "WPMCP_DATA_DIR": "D:/wpmcp-data", "WPMCP_STDIO_LEVEL": "live" }
    }
  }
}
```

حالت stdio با سطح `WPMCP_STDIO_LEVEL` (پیش‌فرض `live`) روی همه‌ی سایت‌ها به‌جای مالک عمل می‌کند؛ هر کس بتواند این فرمان را اجرا کند مورد اعتماد است، پس این فایل را خصوصی نگه دارید. سایت‌ها باید با HTTPS در دسترس باشند (یا برای سایت محلی پرچم توسعه را بگذارید).

## Cursor، VS Code و کلاینت‌های دیگر

هر کلاینتی که MCP راه‌دور (Streamable HTTP) را بپذیرد کار می‌کند. نمونه‌ی `mcp.json`:

```json
{ "mcpServers": { "wp": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer wpmk_XXXXXXXX" } } } }
```

برای آزمایش از MCP Inspector استفاده کنید: `npx @modelcontextprotocol/inspector`، ترنسپورت *Streamable HTTP*، آدرس بالا و header به نام `Authorization`.

## هوش مصنوعی چه می‌بیند

* `instructions` هنگام اتصال: شروع کار، سطح‌ها، روند تأیید، محتوای غیرقابل‌اعتماد، idempotency.
* منابع `wpmcp://guide/*` (نمای کلی، سطح‌ها، روند کار، چندسایتی، ایمنی، طراحی، سئو، نگهداری)، `wpmcp://sites`، `wpmcp://ops`، `wpmcp://activity`.
* promptها: `build_site`، `redesign_page`، `seo_audit`، `maintenance_check`، `publish_post`.
* ۱۴ ابزار که فهرست عملیاتشان با سطح اتصال فیلتر شده است.

## عیب‌یابی

| نشانه | علت و راه‌حل |
|---|---|
| `401` روی `/mcp` با `invalid_token` | کلید باطل یا منقضی شده، یا اپ OAuth قطع شده. دوباره وصل شوید (OAuth) یا کلید تازه بسازید. منقضی‌شدن ساده‌ی توکن دسترسی را کلاینت خودش تمدید می‌کند. |
| Claude.ai وصل نمی‌شود | آدرس باید https عمومی باشد و `WPMCP_PUBLIC_URL` دقیقاً همان. `https://…/.well-known/oauth-authorization-server` را بررسی کنید. |
| `level_too_low` | عملیات سطح بالاتری از اتصال یا سقف سایت می‌خواهد. در پنل بالا ببرید (ستون *Ceiling* برای سایت، *Level* برای اپ). |
| `site_required` / `unknown_site` | بیش از یک سایت دارید: `site` بدهید. نام‌ها را از `site ← sites` بگیرید. |
| `site_auth` | سایت امضا را نپذیرفت: اتصال در وردپرس باطل شده یا افزونه دوباره نصب شده. سایت را حذف و دوباره وصل کنید. |
| `plugin_missing` | افزونه غیرفعال است یا فایروال/افزونه‌ی امنیتی `/?rest_route=/wp-mcp/v1/call` را می‌بندد. اجازه بدهید. |
| `stale_request` / پیام ساعت | ساعت دو سرور بیش از ۵ دقیقه اختلاف دارد. NTP را درست کنید. |
| `unreachable` / `timeout` | gateway به سایت نمی‌رسد (DNS، فایروال، محافظ ربات Cloudflare). IP gateway را مجاز کنید. |
| `blocked` | سایت به آدرس خصوصی resolve می‌شود. gateway فقط با سایت‌های عمومی حرف می‌زند (برای آزمایش محلی پرچم توسعه هست). |
| `rate_limited` | `retry_after` ثانیه صبر کنید. سقف‌ها برای هر اتصال (۲۴۰ در دقیقه، ۶۰ نوشتن در دقیقه) و هر سایت (۴۰۰ در دقیقه) است. |
| کد جفت‌سازی اشتباه یا منقضی | کد ۱۵ دقیقه اعتبار و یک بار مصرف دارد؛ ۵ بار اشتباه آن را می‌سوزاند. کد تازه بسازید. |
