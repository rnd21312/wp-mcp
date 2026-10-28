# نصب

## ۱. gateway

پیش‌نیاز: Node.js **نسخه ۲۲.۱۳ یا بالاتر** (از `node:sqlite` داخلی استفاده می‌کند)، یک آدرس عمومی **HTTPS** (Claude.ai فقط با HTTPS کار می‌کند) و یک پوشه‌ی پایدار برای `data/`.

### روش الف: Node

```bash
cd gateway
npm ci
npm run build
WPMCP_PUBLIC_URL=https://mcp.example.com PORT=8787 WPMCP_TRUST_PROXY=1 npm start
```

### روش ب: Docker

```bash
cp .env.example .env      # دست‌کم WPMCP_PUBLIC_URL را بگذارید
docker compose up -d --build
```

داده‌ها در volume به نام `wpmcp-data` می‌مانند.

### پروکسی معکوس (HTTPS)

Caddy (گواهی خودکار):

```
mcp.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

nginx: به `127.0.0.1:8787` پروکسی کنید، `Host` و `X-Forwarded-For` را پاس بدهید، `client_max_body_size 16m;` بگذارید و `WPMCP_TRUST_PROXY=1` را روشن کنید تا rate limit از آدرس واقعی کلاینت استفاده کند. برای آزمایش بدون دامنه از تونل استفاده کنید (`cloudflared tunnel --url http://localhost:8787`).

### متغیرهای محیطی

| متغیر | پیش‌فرض | معنی |
|---|---|---|
| `WPMCP_PUBLIC_URL` | `http://localhost:PORT` | آدرسی که کلاینت‌ها استفاده می‌کنند. در محیط واقعی **باید همان آدرس https عمومی باشد**؛ در metadata و redirectهای OAuth می‌آید. |
| `PORT` / `WPMCP_HOST` | `8787` / `0.0.0.0` | آدرس گوش‌دادن |
| `WPMCP_DATA_DIR` | `./data` | پایگاه SQLite و `master.key` |
| `WPMCP_MASTER_KEY` | ساخته‌شده در `data/master.key` | ۳۲ بایت (۶۴ هگز یا base64)؛ secret سایت‌ها را رمز و کوکی و توکن تأیید را امضا می‌کند |
| `WPMCP_ADMIN_PASSWORD` | ندارد | مالک را هنگام شروع بسازد (حداقل ۱۲ نویسه) به‌جای توکن راه‌اندازی |
| `WPMCP_TRUST_PROXY` | خاموش | `1` یعنی به `X-Forwarded-For` اعتماد کن |
| `WPMCP_ACCESS_TTL` / `WPMCP_REFRESH_TTL` / `WPMCP_REFRESH_GRACE` | ۳۶۰۰ / ۱۵۵۵۲۰۰۰ / ۶۰۰ | ثانیه: توکن دسترسی، refresh token (لغزان)، مهلت retry |
| `WPMCP_ALLOW_PRIVATE_SITES`، `WPMCP_ALLOW_INSECURE_SITES` | خاموش | **فقط توسعه**: سایت روی `localhost`/IP خصوصی و http ساده |

**از `data/` بکاپ بگیرید** (پایگاه *و* `master.key`؛ بدون کلید، secretهای ذخیره‌شده‌ی سایت‌ها خوانده نمی‌شود و باید همه‌ی سایت‌ها را دوباره جفت کنید).

### اولین اجرا

gateway را اجرا کنید. در لاگ یک **توکن راه‌اندازی** چاپ می‌شود. `/admin` را باز کنید، آن را وارد و رمز مالک (حداقل ۱۲ نویسه) را انتخاب کنید. کسی که به لاگ سرور دسترسی ندارد نمی‌تواند gateway خالی را تصاحب کند.

دستورهای CLI (همان پوشه‌ی داده): `wp-mcp add-site <url> <code>`، `wp-mcp create-key --name n --level draft`، `wp-mcp sites`، `wp-mcp set-password` (از `WPMCP_NEW_PASSWORD` می‌خواند)، `wp-mcp stdio`.

### پنل محلی (بدون سرور و دامنه)

`start-local.cmd` (ویندوز) یا `node gateway/dist/index.js local` پنل را روی `127.0.0.1:8787` اجرا و باز می‌کند. برای اتصال سایت‌ها، اجرای عملیات در میز کار و گرفتن دستورهایی که Claude Code یا Claude Desktop (stdio) را به همین پوشه‌ی داده وصل می‌کنند.

## ۲. افزونه (روی هر سایت وردپرس)

پیش‌نیاز: وردپرس ۶.۲+، PHP 8.1+، و سایتی که از gateway با HTTPS در دسترس باشد.

۱. با `node scripts/package-plugin.mjs` فایل آپلود را بسازید (`dist/wp-mcp-bridge.zip`، بدون نیاز به ابزار zip)، یا خودتان پوشه‌ی `plugin/wp-mcp-bridge` را zip کنید:
   ```bash
   cd plugin && zip -r ../wp-mcp-bridge.zip wp-mcp-bridge
   ```
   (در PowerShell ویندوز: `Compress-Archive -Path plugin\wp-mcp-bridge -DestinationPath wp-mcp-bridge.zip`)
۲. *افزونه‌ها ← افزودن ← بارگذاری افزونه* و فعال‌سازی.
۳. *ابزارها ← WP MCP Bridge*: بالاترین سطحی را که این اتصال مجاز است روی این سایت داشته باشد انتخاب کنید (پیش‌فرض `admin`؛ اگر هرگز نمی‌خواهید عملیات افزونه/کاربر/دیتابیس انجام شود `live` بگذارید) و **Create pairing code** را بزنید. کد ۱۵ دقیقه معتبر و یک‌بار‌مصرف است.

افزونه دو جدول کوچک (`wpm_activity` و `wpm_revisions`) و یک کار روزانه‌ی پاکسازی می‌سازد. حذف از صفحه‌ی افزونه‌ها آن‌ها را پاک می‌کند (`uninstall.php`).

## ۳. اتصال سایت

در پنل gateway ← **Connect a site**: آدرس سایت، کد جفت‌سازی، یک **نام یکتا** (حروف کوچک، مثلاً `shop-fa`) و بالاترین سطح مجاز روی آن سایت. gateway جفت‌سازی را با HTTPS انجام می‌دهد، secret را رمزشده ذخیره می‌کند و یک فراخوانی امضاشده‌ی آزمایشی می‌زند.

اگر شکست خورد، [connect.md](connect.md#troubleshooting) را ببینید.

## به‌روزرسانی

کد را بگیرید، `npm ci && npm run build` و راه‌اندازی مجدد. پایگاه خودش مهاجرت می‌کند. نسخه‌ی افزونه و gateway فقط باید روی `spec/ops.json` هم‌نظر باشند: عملیاتی که افزونه نمی‌شناسد `unknown_op` برمی‌گرداند.
