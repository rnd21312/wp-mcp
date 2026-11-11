# Changelog

## Unreleased

### Files and full control
- `files.search`: find text in a theme, plugin, mu-plugins, uploads or core (path, line, text).
- `files.patch`: change part of a file by exact replacement instead of sending the whole file.
- `files.write_many` is all or nothing: every file is checked first, the site is probed once, and everything is put back if it breaks.
- `local_path` on `files.write`, `files.write_many` and `media.upload`: a local AI app uploads a file from this computer; large files go in pieces (64 MB). Folders are limited by `WPMCP_UPLOAD_DIRS`.
- `maintain.config_get` / `maintain.config_set`: wp-config.php constants, never credentials, keys, salts or paths.
- WordPress core files can be edited when the site owner switches it on in Tools > WP MCP Bridge (off by default).
- Fixed: `files.write` could not create a new theme or plugin folder.

- `files.fetch_many`: download up to 25 https files (20 MB each, 100 MB together) into a root with one confirmation instead of one per file. Each file is saved and undoable on its own; failures are listed.

- `snippets` tool for the Code Snippets plugin: list, get, save, activate, deactivate, delete. Uses the plugin's own functions; PHP is syntax-checked, active code is confirmed first, the front page is probed and the change reverted if the site breaks; every change is undoable. `site.overview` reports whether the plugin is active.

- `maintain.core_verify` compares WordPress core files with the official checksums of api.wordpress.org (modified, missing, unexpected files); `maintain.core_restore` puts back the verified original of modified or missing files, confirmed first and undoable. It works without the core-edit switch because it can only write bytes that match the official checksum.

- Security: in Claude.ai connector mode (no login) the gateway now registers and auto-approves only Claude's own callback addresses; any other redirect address is refused at registration and has to sign in. Note: anyone who knows the tunnel address can still add it as a connector in their own Claude account, so keep the address secret and stop the tunnel when unused.

### Building a site
- `design.theme_bases` and `design.theme_scaffold`: build a theme from three bundled bases (block-rtl, classic-rtl, shop-rtl with WooCommerce), all RTL and Persian friendly, with your name, slug and design tokens, in one all-or-nothing write. The tokens also become the site design tokens. Undoable.
- `plugins.scaffold`: skeleton of a new plugin (header, class, uninstall, readme, optional admin page, shortcode, REST route, custom post type). It returns the files, or writes plugins/<slug> (never activates), optionally with a zip.
- `design.tokens_sync` writes the design tokens into the active block theme's theme.json and the Elementor kit (Global Colors and Fonts). `design.tokens_audit` finds colors and fonts written directly in the site CSS and says which ones equal a token. `design.patterns_list` and `design.pattern_get`: five block patterns (hero, features, pricing, contact, footer) with English and Persian texts that follow the token slugs; they are also in the editor inserter under "WP MCP".
- `site.build`: build or extend a whole site from one JSON map (plugins, theme scaffold, tokens, pages from text or bundled patterns, menu, home page, branding, options). `dry_run` lists the steps, a real run is confirmed once, stops at the first failure and resumes with `from_step` and `page_ids`. Checked against your level before anything runs.
- `studio.wordpress_install` (admin, confirmed) installs a new WordPress site on a host and connects it. The database comes from a profile the owner saves as JSON in the data folder (`db-profiles/<name>.json`: method manual or mysql_root); credentials are refused in the call, and the generated administrator password is written to `wp-installs/<site>.txt` instead of being shown to the AI. `studio.db_profiles` lists profile names.

### SEO and Google
- Search Console: `sitemap_submit` and `sitemap_delete`. They need the new panel button "Connect and allow changes" (scope `webmasters`, a reconnect), level live and a confirmation; the sitemap must be on the property. The default connection stays read-only.
- IndexNow for Bing, Yandex, Naver, Seznam and Yep: `seo.indexnow_setup` makes a key that the bridge serves at `/<key>.txt` (no file written), `seo.indexnow_status` checks it, `seo.indexnow_submit` sends URLs, post ids or the most recently changed items (max 500 per call, this site only, nothing when the site is hidden from search).
- Search Console `indexing_publish` and `indexing_status` (Google Indexing API): opt-in connection with a warning (Google supports it only for job posting and live stream pages), an acknowledgement in every call, a confirmation, the URL must be in one of your properties, and a local counter of Google's 200 requests per day. Connecting now asks Google for exactly the access you chose (no longer accumulating earlier grants).
- Bulk SEO: `seo.bulk_set` (title, description and more for up to 50 pages, each undoable), `seo.alt_fill` (alt text from titles and file names for images that have none; camera names are skipped; one undoable revision), `seo.links_check` (broken link report of up to 20 pages; links to the site by default, `external:true` also checks outside links with safe HTTP only).

### Easier for AI clients
- Argument and action aliases, `describe` on any tool, wp-content paths as roots.
- A confirmed call sends the token alone; the arguments are remembered.
- Pages and files come in 32 KB windows with `next_offset`.
- Fixed: `scroll-behavior` rejected as script CSS, semicolons inside SQL strings, listing a missing mu-plugins folder, numeric redirect codes.

### Small fixes
- `site.whoami` shows where the level is set (panel, `WPMCP_STDIO_LEVEL`, API key or app grant), per-site caps, gateway version and data folder; `level_too_low` says the same.
- `inspect.outline` selectors accept comma lists, `[attr]`, `[attr=v]` (`^=`, `$=`, `*=`, `~=`), compounds and the `>` and space combinators.
- Fixed: `content.save` failed on a page whose stored page template no longer exists (WordPress re-validates it on every save, even with `template: ""`). `""` now means the default template and a stale template is reset with a note; an unknown template is refused with the list of real ones.

### Project
- ESLint and Prettier, gateway sources grouped into folders, one tracked `ops.json`.

## Unreleased

2.3.0, signed bridge updates: the plugin now updates itself through WordPress (Plugins page, panel Sites button, or `maintain.update` for `wp-mcp-bridge/wp-mcp-bridge.php`) from a release signed with your Ed25519 key. Checksum, signature, newer version and zip layout are verified before any file changes; classes are preloaded so the swap cannot mix versions. `npm run release` writes `dist/bridge-latest.json`; `release:keygen` also writes the bridge public key. Fixed: `maintain.update` reported success when the download step failed. Bridges older than 2.3 need the zip uploaded once by hand. See docs/release.md.

2.2.0: `builder` tool (Elementor and Bricks element trees: get/set/element_add/element_update/element_remove, markup for Divi/WPBakery/Avada) and `fields` tool (ACF and Meta Box groups and values, ACF group creation), `inspect.ticket`. Panel: shadcn sidebar shell and a Visual editor (live page, class-based style overrides saved as a CSS section, Elementor/Bricks settings, add/remove elements, inline text edit, template parts / theme files / post content opened as code through source markers, which need the bridge 2.2+). Bridge adds comment markers around template parts, theme files, post content, plugin shortcodes and blocks (with the plugin file that renders them) and WooCommerce templates, only for requests that carry a signed editor header. The editor opens any page of the site by address, not only listed pages.

2.1.0, wider access: `files.mkdir/rmdir/move/copy/fetch/unzip`, `maintain.sql` (read-only) and `sql_write` (confirmed), `design.theme_delete`, `content.meta_get/meta_set/meta_delete` (post, term, comment, user), `shop.gateways_list/gateway_set/shipping_zones`. Raw PHP execution was deliberately not added. Fixes from a real build session: `files.write` now creates missing `themes/<slug>`, `plugins/<slug>`, `mu-plugins` and `uploads` folders (a whole theme can be built over MCP), `files.write_many` writes up to 60 files at once, `files.list` on `themes`/`plugins` lists folders, nested roots like `themes/x/inc` work. New `design.theme_install_zip` and `maintain.language_install` (e.g. fa_IR). Zip and media downloads follow redirects (each hop re-checked), so GitHub release links work. Fixed `media.import_url`/`upload` failing with `wp_handle_sideload(): Argument #1 cannot be passed by reference`. The gateway accepts common argument slips (`options`->`values`, `route`/`url`->`path`, `dry_run` inside args, `[{slug,color}]` lists as objects) and `transfer_files` accepts root `themes` + path `<theme>`.

Google Search Console: new local-panel page (sign in with Google, dashboard of clicks, queries, pages, countries, devices, sitemaps, live indexing check, URL inspection) and read-only `search_console` MCP tool (status, sites, performance, queries, pages, compare, sitemaps, inspect, coverage). The owner's own Google OAuth client (Desktop app) is used; only a read-only refresh token is stored, encrypted. See docs/search-console.md.

Media: `media.register` adds files already in wp-content/uploads to the library (sizes, alt, featured image); `media.upload` is hardened (uploads folder check, memory/time, thumbnail failure no longer loses the file, clear errors) and accepts `optimize`; `media.optimize` shrinks/converts images (webp, avif, jpeg) and videos (ffmpeg), rewriting links; `media.update` edits caption, description, slug. Plugin admin page now has separate MCP (connection only), Activity and Media tabs; the Media tab can optimize every library upload automatically.

Search Console: `overview` and `opportunities` actions, compact `{cols, data}` tables in the MCP tool, limits (Core Web Vitals, Merchant listings) stated. Fewer tokens: shorter tool descriptions and result envelopes.

## 2.0.0

M6: signed agent self-update (Ed25519, anti-downgrade, backup and automatic restore), host self-test with outside exposure probe, `studio` MCP tool (static projects, confirmed publish/rollback), release and key scripts, Linux CI with symlink and signed-update tests, test matrix.

## 2.0.0-m5

M5: AI site builder with human checkpoints (sitemap, design system, pages, images, SEO, audit, publish), server-enforced order, deterministic shell/SEO/CSS/audit.

## 2.0.0-m4

M4: Node.js sites (releases with rollback, private env file, Passenger config, restart markers, user-run VPS setup script, extra allowed locations), Node and Next SSR (standalone) templates, post-deploy health check.

## 2.0.0-m3

M2: WordPress provisioning (official core with checksum, database via cPanel/DirectAdmin/MySQL admin/manual, wp-config, bridge auto-activation and pairing). M3: React/Vue/Svelte (Vite), Astro and Next static-export templates with local npm builds and live log.

## 2.0.0-m1

M1, Host Agent MVP: PHP agent (setup wizard, scrypt-class password hashing, lockout, TOTP, signed API with replay protection, chunked verified uploads, immutable releases, atomic switch, rollback, backups, audit log, capability detection), Studio hosts and projects, deploy of static and single-page sites. See docs/agent.md.

## 0.1.0

First release: stateless MCP gateway (OAuth 2.1 + PKCE, rotating 180-day refresh tokens, API keys, multi-site, levels, confirmations, idempotency, rate limits, SSRF guard, activity log, admin panel, stdio mode) and the WP MCP Bridge plugin (117 actions, undo snapshots, site log). English and Persian docs.
