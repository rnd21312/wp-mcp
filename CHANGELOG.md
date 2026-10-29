# Changelog

## Unreleased

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
