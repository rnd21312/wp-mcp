# Google Search Console

داده‌های Search Console در پنل محلی و برای هوش مصنوعی شما، از طریق ابزار MCP به نام `search_console`. به‌طور پیش‌فرض فقط‌خواندنی است، مگر اینکه در پنل «اتصال با اجازه‌ی تغییر» را بزنید که ارسال و حذف سایت‌مپ را هم ممکن می‌کند.

## راه‌اندازی یک‌باره (رایگان، حدود ۵ دقیقه)

گوگل داده را فقط به برنامه‌ای می‌دهد که خودتان صاحبش باشید؛ پس یک ورود خصوصی می‌سازید. این ورود هرگز کامپیوتر شما را ترک نمی‌کند.

1. [Google Cloud، پروژه‌ی جدید](https://console.cloud.google.com/projectcreate) را باز کنید و یک پروژه بسازید (هر نامی).
2. [Google Search Console API](https://console.cloud.google.com/apis/library/searchconsole.googleapis.com) را فعال کنید.
3. [Google Auth platform](https://console.cloud.google.com/auth/overview) را باز کنید: **External** را انتخاب کنید و نام برنامه و ایمیل خود را بنویسید. در **Audience** ایمیل گوگل خودتان را به‌عنوان کاربر آزمایشی اضافه کنید و **Publish app** را بزنید. تا وقتی برنامه در حالت *Testing* بماند، گوگل ورود را بعد از ۷ روز منقضی می‌کند. هنگام ورود گوگل «unverified app» نشان می‌دهد: برای برنامه‌ی خودتان طبیعی است (Advanced، ادامه).
4. [Clients](https://console.cloud.google.com/auth/clients) را باز کنید، **Create client** و نوع **Desktop app**. Client ID و Client secret را کپی کنید.
5. پنل محلی (`wpmcp.cmd`)، صفحه‌ی **Search Console**: هر دو را بچسبانید، **Save** و سپس **Connect with Google** را بزنید و با حسابی وارد شوید که مالک property در Search Console است.

به‌طور پیش‌فرض فقط scope با نام `webmasters.readonly` (و ایمیل شما برای نمایش) درخواست می‌شود. «اتصال با اجازه‌ی تغییر» به‌جای آن `webmasters` می‌خواهد که `sitemap_submit` و `sitemap_delete` را مجاز می‌کند (و چیز دیگری از آنچه این پروژه استفاده می‌کند). برای برگشت به فقط‌خواندنی با دکمه‌ی ساده دوباره وصل شوید (هر دکمه‌ی اتصال از گوگل دقیقاً همان دسترسی را می‌خواهد که نامش می‌گوید).

## Indexing API (اختیاری، با هشدار)

گوگل Indexing API را فقط برای صفحه‌های دارای نشانه‌گذاری ساختاریافته‌ی `JobPosting` یا `BroadcastEvent` (پخش زنده، داخل `VideoObject`) مستند کرده است، با سهمیه‌ی پیش‌فرض ۲۰۰ درخواست ارسال در روز. برای دکمه‌ی «Request indexing» در Search Console هیچ API وجود ندارد. برای هر صفحه‌ی دیگر ممکن است API درخواست را بپذیرد و کاری نکند، و سوءاستفاده می‌تواند سهمیه را از شما بگیرد. به همین دلیل به‌طور پیش‌فرض خاموش است: در پنل «Connect with Indexing API access» را بزنید (بعد از هشدار) و «Web Search Indexing API» را در پروژه‌ی Google Cloud خود فعال کنید. بعد از آن `indexing_publish {url, acknowledge_restriction:true}` (سطح live، با تأیید، نشانی باید داخل یکی از propertyهای شما باشد، شمارش در برابر ۲۰۰ در روز) و `indexing_status {url}` کار می‌کنند. برای صفحه‌های معمولی از سایت‌مپ استفاده کنید و برای Bing و Yandex از IndexNow. refresh token و client secret با کلید اصلی gateway رمز می‌شوند و در پوشه‌ی داده می‌مانند.

## ابزار MCP

`search_console` به اتصال‌هایی داده می‌شود که اجازه‌ی استفاده از همه‌ی سایت‌ها را دارند (مثل `studio`). عملیات فقط‌خواندنی‌اند، به‌جز `sitemap_submit` و `sitemap_delete` (سطح live، اتصالی که اجازه‌ی تغییر دارد و تأیید می‌خواهند، و سایت‌مپ باید به property تعلق داشته باشد):

| عملیات | چه می‌دهد |
|---|---|
| `status`، `sites` | وصل است یا نه و با چه حسابی؛ propertyهایی که حساب می‌تواند بخواند |
| `performance` | کلیک، نمایش، CTR، جایگاه بر اساس `query`، `page`، `country`، `device`، `date`، `searchAppearance`؛ `days` یا `start`/`end`، `search_type`، `filters`، `limit`، `offset` |
| `queries`، `pages` | میان‌بر دو تفکیک پرکاربرد |
| `compare` | این دوره در برابر دوره‌ی قبل برای عبارت‌ها یا صفحه‌ها: چه بالا رفت، چه افتاد، چه تازه است |
| `sitemaps` | سایت‌مپ‌های ارسال‌شده با خطا، هشدار و زمان آخرین خواندن |
| `inspect` | URL Inspection: ایندکس شده یا نه و چرا، canonical، robots، قابلیت استفاده در موبایل، rich results |
| `coverage` | چند صفحه را (از سایت‌مپ یا فهرست) بررسی می‌کند و حکم گوگل را جمع می‌زند: گزارش زنده‌ی «Pages» |

داده‌ها حدود دو روز تأخیر دارند، پس بازه‌های پیش‌فرض سه روز پیش تمام می‌شوند. گوگل حدود ۲۰۰۰ بازرسی URL در روز برای هر property اجازه می‌دهد؛ `coverage` در هر فراخوانی به ۱۵۰ صفحه محدود است.

## نکته‌ها

- در حالت محلی کار می‌کند (`wpmcp.cmd` یا `node gateway/dist/index.js local`). ورود گوگل به `http://127.0.0.1:<port>/admin/gsc/callback` برمی‌گردد که فقط روی همین کامپیوتر جواب می‌دهد. سرور stdio MCP همان ورود ذخیره‌شده را از پوشه‌ی داده‌ی مشترک می‌خواند.
- از طریق API در دسترس نیست: گزارش Core Web Vitals و گزارش Merchant listings. برای مشکل ایندکس و rich result هر URL از `coverage`/`inspect` استفاده کنید.
- در پنل قطع کنید، و برای ابطال توکن در سمت گوگل برنامه را در <https://myaccount.google.com/permissions> حذف کنید.
