# Google Search Console

Read-only Search Console data in the local panel and for your AI, through the `search_console` MCP tool. Nothing in Search Console is changed.

## One-time setup (free, about 5 minutes)

Google only hands data to an app you own, so you create a private sign-in once. It never leaves your computer.

1. Open [Google Cloud, new project](https://console.cloud.google.com/projectcreate) and create a project (any name).
2. Enable the [Google Search Console API](https://console.cloud.google.com/apis/library/searchconsole.googleapis.com).
3. Open [Google Auth platform](https://console.cloud.google.com/auth/overview): choose **External**, fill the app name and your email. Under **Audience** add your Google email as a test user, then press **Publish app**. While an app stays in *Testing*, Google expires the sign-in after 7 days. Google shows "unverified app" when you sign in: that is expected for your own app (Advanced, continue).
4. Open [Clients](https://console.cloud.google.com/auth/clients), **Create client**, type **Desktop app**. Copy the Client ID and Client secret.
5. Open the local panel (`start-local.cmd`), page **Search Console**, paste both, press **Save**, then **Connect with Google** and sign in with the account that owns the property in Search Console.

Only the scope `webmasters.readonly` (plus your email address for display) is requested. The refresh token and the client secret are stored encrypted with the gateway master key in the data folder.

## The MCP tool

`search_console` is offered to connections that may use every site (like `studio`). Actions, all read-only:

| Action | What it gives |
|---|---|
| `status`, `sites` | Is it connected, as whom; the properties the account can read |
| `performance` | Clicks, impressions, CTR, position by `query`, `page`, `country`, `device`, `date`, `searchAppearance`; `days` or `start`/`end`, `search_type`, `filters`, `limit`, `offset` |
| `queries`, `pages` | Shortcuts for the two most used breakdowns |
| `compare` | This period against the previous one for queries or pages: gained, lost, new |
| `sitemaps` | Submitted sitemaps with errors, warnings and last read time |
| `inspect` | URL Inspection: indexed or not and why, canonical, robots, mobile usability, rich results |
| `coverage` | Inspects many pages (from the sitemaps or a list) and totals Google's verdicts: the live "Pages" report |

Data lags about two days, so default ranges end three days ago. Google allows about 2000 URL inspections per day per property; `coverage` is capped at 150 pages per call.

## Notes

- Works in local mode (`start-local.cmd` or `node gateway/dist/index.js local`). The Google sign-in returns to `http://127.0.0.1:<port>/admin/gsc/callback`, which only answers on this computer. The stdio MCP server reads the same stored sign-in from the shared data folder.
- Not available through the API: the Core Web Vitals report and the Merchant listings report. Use `coverage`/`inspect` for indexing and rich-result problems per URL.
- Disconnect in the panel, and remove the app at <https://myaccount.google.com/permissions> to revoke the token on Google's side.
