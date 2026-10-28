# WP MCP

**Let an AI run your WordPress sites, from zero to production, over MCP only.** No visual editor, no plugin UI to learn: the AI gets 16 well-described tools (123 site actions) for design, SEO, maintenance, plugins, content, shop and forms, with permission levels, two-step confirmation, undo and an activity log.

🇮🇷 [راهنمای فارسی](README.fa.md)

```
Claude.ai / Claude Code / Cursor / any MCP client
              │  Streamable HTTP (stateless) · OAuth 2.1 + PKCE · API keys
              ▼
      ┌────────────────────┐        signed HTTPS (HMAC)        ┌──────────────────────┐
      │  WP MCP gateway    │ ────────────────────────────────► │ WP MCP Bridge plugin │  site A
      │  (Node/TypeScript) │ ────────────────────────────────► │  (PHP 8.1+, light)   │  site B
      │  tokens, levels,   │                                   └──────────────────────┘  site C
      │  rate limits, log  │
      └────────────────────┘
```

## Why a gateway plus a plugin

| Question | Answer |
|---|---|
| One connection for many sites? | Yes. The AI app connects **once** to the gateway; every tool takes a `site` and every result repeats the site name. |
| Connection that does not drop? | Tokens live in the gateway (SQLite), not in `wp_options`. Access tokens last 1 h, **refresh tokens rotate and last 180 days**, a lost refresh response is tolerated, and a site being offline never invalidates the AI's login. |
| Safe by default? | Four levels (`read` < `draft` < `live` < `admin`) enforced twice (gateway and plugin), per-site ceilings, two-step confirmation for destructive actions, undo for most changes, SSRF guard, untrusted-content warnings. |
| Heavy on the WordPress site? | No. The plugin is one signed endpoint plus handlers; it does nothing until you pair a gateway. |

Details: [docs/architecture.md](docs/architecture.md).

## Quick start

1. **Run the gateway** (Node 22.13+; Docker also works, see [docs/install.md](docs/install.md)):
   ```bash
   cd gateway && npm ci && npm run build
   WPMCP_PUBLIC_URL=https://mcp.example.com npm start
   ```
   Open `/admin`, enter the setup token printed in the log, choose an owner password.
2. **Install the plugin** on each site: zip `plugin/wp-mcp-bridge`, upload it in *Plugins → Add New*, activate. Go to *Tools → WP MCP Bridge* and create a pairing code.
3. **Connect the site** in the gateway admin panel (*Connect a site*: URL + pairing code). Give it a unique name.
4. **Connect your AI**: Claude.ai (*Settings → Connectors → Add custom connector → `https://mcp.example.com/mcp`*) or Claude Code:
   ```bash
   claude mcp add --transport http wp https://mcp.example.com/mcp
   ```
   Details and API-key setup: [docs/connect.md](docs/connect.md).

## The local web panel

Double-click `start-local.cmd` (or `node gateway/dist/index.js local`): the panel opens at `http://127.0.0.1:8787/admin`, listening on this computer only. Persian (default) and English.

* **Dashboard**: connect sites with a pairing code, set per-site level ceilings, create API keys, see connected apps.
* **Workbench**: run any tool action by hand from generated forms, as a chosen level, with previews, confirmations and results. Covers every task, including `site.transfer`.
* **Connect AI**: ready-to-copy commands for Claude Code, Claude Desktop (stdio, no server needed), Cursor and remote clients, filled in for your install.
* **Activity**: everything the AI and you did.

## What the AI can do

| Tool | Covers |
|---|---|
| `site` | Start here: connected sites, overview of a site, who am I, schema of any action |
| `content` | Posts, pages, custom types, categories/tags, comments, revisions |
| `design` | Templates and parts (header/footer), CSS sections, design tokens, menus, homepage, branding, themes, theme files |
| `media` | Library, upload (base64 or https URL), alt text |
| `seo` | Yoast / Rank Math / SEOPress / built-in fields, page audit, robots.txt, sitemap, redirects, JSON-LD |
| `inspect` | Real rendered HTML, element tree, stylesheets of any page |
| `maintain` | Health, updates, DB backup/restore, logs, caches, DB cleanup, search-replace, cron, maintenance mode |
| `plugins` | List, search, install, activate, deactivate, delete |
| `users`, `options` | Users and roles (admin), site options with secret redaction |
| `rest` | Discover and call **any** REST route (WooCommerce, forms, custom) with levels derived from route and method |
| `shop`, `forms` | WooCommerce products/stock/coupons/orders; CF7, Gravity, WPForms, Fluent Forms |
| `files` | Browse/read/write/delete files in themes, plugins, mu-plugins, uploads, and read the WordPress core folder (`core`; only `.htaccess`/`robots.txt` writable; `wp-config.php` stays closed because it holds database passwords). Admin, confirmed, PHP syntax-checked, undoable |
| `transfer` | Portable export/import of posts, terms, menus, media and design. **`site.transfer`** copies content between two connected sites inside the gateway (drafts by default, images fetched including page-builder JSON, links rewritten, resumable; also users and plugin settings for admin); **`site.transfer_files`** copies theme/plugin folders |
| `activity` | What happened (gateway + site), and **undo** by revision |

Full list: [docs/TOOLS.md](docs/TOOLS.md). The AI also receives `instructions` at connect time, guide **resources**, ready **prompts** (build a site, SEO audit, maintenance, publish a post, redesign a page) and can read the activity log.

## Safety in one table

| Risk | Defence |
|---|---|
| A read-only key leaks private data | `read` sees only published, non-sensitive data. Users, orders, options, drafts, comments' emails, logs are `draft`/`admin`. Secret-looking options are never returned, even to admin. |
| AI deletes or installs something | Destructive actions are two-step (`confirm_token` bound to the exact arguments, 5 min). Permanent deletions are admin-only. Plugin install from URL: admin + confirm, https only, no redirects, no private IPs. |
| Server-side request forgery | Gateway connects through a guarded DNS lookup (blocks private/loopback/link-local/metadata at connect time), never follows redirects. The plugin applies the same rules to downloads. |
| Prompt injection from site content | Results containing site text carry a `content_notice`; instructions tell the AI never to obey them; HTML written at lower levels is `kses`-filtered. |
| Rogue OAuth app | Public clients only, PKCE S256 required, redirect allow-list (https / loopback / editor schemes), consent page shows the redirect **domain**, registration and token endpoints are rate limited, owner can lower or revoke instantly. |
| Stolen refresh token | Rotation with reuse detection: replaying an old token ends the whole chain. |
| One noisy client starves the rest | Separate buckets per connection, per write, and per site. |
| A bad theme edit kills the site | PHP is syntax-checked; the front page is probed afterwards and the change is auto-reverted on a server error. |

Read [docs/security.md](docs/security.md) for the full model and honest limits.

## Development

```bash
npm test            # gateway (123 tests) + plugin checks (108) in one go
npm run docs        # regenerate docs/TOOLS.md from spec/ops.json
```

`spec/build-spec.mjs` is the single source of truth for every action (level, arguments, confirmation). `scripts/sync-spec.mjs` copies the generated `ops.json` to the gateway and the plugin; a test fails if the copies drift.

License: MIT.
