# Tools reference

Generated from `spec/ops.json` (123 site actions + gateway actions). Every tool is called as `{site, action, args, dry_run?, confirm_token?, idempotency_key?}`.

Levels: **read** < **draft** < **live** < **admin**. `A>B` means the action starts at A and the site raises it to B from the real target (for example editing a published page). **confirm** = two-step: the first call returns a preview and a `confirm_token`, nothing changes until it is repeated with the token. **site content** = the result contains text written on the website (treated as untrusted).

## site: Site overview and connections

| Action | Level | Arguments (* required) | What it does |
|---|---|---|---|
| `transfer` | draft>live | `from*, to*, kinds, post_type, ids, page, pages, id_map, overwrite, publish` | Copy content between two sites through the gateway (resumable, drafts by default). *(gateway)* |
| `transfer_files` | admin | `from*, to*, root*, path, skip_existing` | Copy files between two sites (confirm). *(gateway)* |
| `sites` | read |  | Every site you can use: name, URL, status, your effective level. *(gateway)* |
| `whoami` | read |  | Who you are connected as: level, sites, rate limits. *(gateway)* |
| `describe` | read | `tool*, action` | Full parameter schema of one action (or all actions of one tool). *(gateway)* |
| `overview` | read |  | Name, URL, theme, active plugins, content types, taxonomies, menus, SEO plugin, WooCommerce, locale, bridge ceiling and ops. *(site content)* |
| `ping` | read |  | Bridge version, PHP/WP versions, clock skew and round-trip check. |

## content: Posts, pages, terms, comments

| Action | Level | Arguments (* required) | What it does |
|---|---|---|---|
| `list` | read>draft | `post_type, status, search, term, author, orderby, order, page, per_page` | List posts/pages/custom types (non-published statuses need draft level). *(site content)* |
| `get` | read>draft | `id*, post_type, include` | Read one item with raw content, meta, terms, SEO, template. Drafts need draft level. *(site content)* |
| `save` | draft>live | `id, post_type, title, content, excerpt, status, slug, parent, template, featured_media, date, terms, meta, menu_order, comment_status` | Create or update a post/page/custom item. Keep status draft/pending at draft level; publish or edit published items needs live. *(write)* |
| `duplicate` | draft | `id*` | Copy an item as a new draft. *(write)* |
| `trash` | live | `id*` | Move to trash (recoverable). *(write)* |
| `restore` | live | `id*` | Restore from trash. *(write)* |
| `delete` | admin | `id*` | Delete permanently. Cannot be undone. *(confirm, write)* |
| `revisions` | draft | `id*, restore` | List WordPress revisions of an item, or restore one. *(write, site content)* |
| `bulk` | live | `ids*, status*` | Change the status of up to 50 items at once. *(write)* |
| `terms_list` | read | `taxonomy, search, hide_empty, page, per_page` | List categories, tags or any taxonomy terms. *(site content)* |
| `terms_save` | live | `id, taxonomy, name*, slug, parent, description` | Create or update a term. *(write)* |
| `terms_delete` | live | `id*, taxonomy` | Delete a term (posts keep existing). *(confirm, write)* |
| `comments_list` | draft | `post_id, status, search, page, per_page` | List comments (author email only at admin level). *(site content)* |
| `comments_moderate` | live | `ids*, action*` | Approve, hold, spam or trash comments. *(write)* |
| `comments_reply` | live | `comment_id*, content*` | Reply to a comment as the connected admin. *(write)* |
| `comments_delete` | admin | `ids*` | Delete comments permanently. *(confirm, write)* |

## design: Design: templates, CSS, tokens, menus, themes

| Action | Level | Arguments (* required) | What it does |
|---|---|---|---|
| `tokens_get` | read |  | Design tokens: colors, fonts, font sizes, spacing, layout widths (theme.json + site tokens). |
| `tokens_set` | live | `colors, fonts, font_sizes, spacing, radius, content_width` | Merge design tokens. Emitted as CSS variables (--wpm-*) and, on block themes, merged into Global Styles. *(write)* |
| `css_get` | read | `section` | Additional CSS (named sections) as stored. |
| `css_set` | live | `css*, section, mode` | Write CSS into a named section (replace, append or prepend). Other sections are untouched. *(write)* |
| `css_remove` | live | `section*` | Remove a CSS section. *(write)* |
| `templates_list` | read | `kind` | Block templates and template parts (header, footer…), or classic theme template files. |
| `template_get` | read | `slug*, kind` | Read a template or part (raw block markup). *(site content)* |
| `template_save` | live | `slug*, content*, kind, title, area` | Create or override a template/part (block themes). Revert with design.template_reset. *(write)* |
| `template_reset` | live | `slug*, kind` | Drop the custom version, falling back to the theme file. *(write)* |
| `menus_list` | read |  | Menus and theme locations. |
| `menu_get` | read | `menu*` | One menu as a tree. |
| `menu_save` | live | `name*, items*, locations` | Create or replace a menu from a tree and assign locations. *(write)* |
| `menu_delete` | live | `menu*` | Delete a menu and its items (recoverable with activity.undo). *(confirm, write)* |
| `homepage_set` | live | `show_on_front, front_page_id, posts_page_id` | Static front page / posts page, or latest posts. *(write)* |
| `branding_set` | live | `title, tagline, logo_id, icon_id` | Site title, tagline, logo and site icon. *(write)* |
| `themes_list` | draft |  | Installed themes and which is active. |
| `theme_activate` | admin | `slug*` | Switch the active theme. *(confirm, write)* |
| `theme_install` | admin | `slug*, activate` | Install a theme from WordPress.org by slug. *(confirm, write)* |
| `theme_files` | admin | `theme` | List files of the active (or given) theme. |
| `theme_file_read` | admin | `path*, theme, offset` | Read a theme file. *(site content)* |
| `theme_file_write` | admin | `path*, content*, theme` | Write a theme file (PHP is syntax-checked; previous content is kept for undo). *(confirm, write)* |

## media: Media library

| Action | Level | Arguments (* required) | What it does |
|---|---|---|---|
| `list` | read | `search, mime, page, per_page` | Media library items with URLs, sizes and alt text. *(site content)* |
| `get` | read | `id*` | One attachment with all sizes. *(site content)* |
| `upload` | draft | `filename*, data_base64*, title, alt, caption, attach_to` | Upload a file from base64 data. *(write)* |
| `import_url` | live | `url*, filename, title, alt, attach_to` | Download an image/file from an https URL (no redirects, no private addresses). *(confirm, write)* |
| `update` | draft | `id*, alt, title, caption, description` | Update alt text, title, caption. *(write)* |
| `delete` | admin | `id*` | Delete an attachment and its files permanently. *(confirm, write)* |

## seo: SEO

| Action | Level | Arguments (* required) | What it does |
|---|---|---|---|
| `get` | read>draft | `id*` | SEO fields of an item (title, description, canonical, robots, OG, schema), via Yoast/Rank Math/AIOSEO/SEOPress or the built-in fallback. *(site content)* |
| `set` | draft>live | `id*, title, description, canonical, noindex, nofollow, og_title, og_description, og_image, focus_keyword` | Set SEO fields. Published items need live. *(write)* |
| `audit` | read | `path, id` | Audit a page of this site: title/description length, headings, alt text, canonical, robots, OG, schema, links, size. Returns scored issues with fixes. *(site content)* |
| `site_get` | read |  | Site-wide SEO: search visibility, robots.txt, sitemap provider, organisation schema, active SEO plugin. |
| `site_set` | live>admin | `robots_txt, org_name, org_logo, org_same_as, title_separator, default_og_image, blog_public` | Site-wide SEO (built-in layer): robots.txt text, organisation schema, title separator, default OG image. Search visibility needs admin. *(write)* |
| `sitemap` | read>live | `enable` | Sitemap provider, URL and number of URLs; can switch the core sitemap on or off. |
| `redirects_list` | draft | `page, per_page` | Redirects managed by the bridge. |
| `redirect_save` | live | `from*, to*, code, regex` | Add or update a redirect. *(write)* |
| `redirect_delete` | live | `from*` | Remove a redirect. *(write)* |
| `schema_get` | read | `id*` | Custom JSON-LD of an item. *(site content)* |
| `schema_set` | live | `id*, json*` | Set custom JSON-LD for an item (empty removes it). *(write)* |

## inspect: Inspect rendered pages

| Action | Level | Arguments (* required) | What it does |
|---|---|---|---|
| `page` | read | `path*, max_bytes, offset` | Rendered HTML of a page of this site (same host only, redirects not followed off-site). *(site content)* |
| `render` | draft | `id*, max_bytes` | Render a post (also drafts) through the_content, without the theme. *(site content)* |
| `outline` | read | `path*, selector, depth` | Compact structure of a page: headings, landmarks, images, links, forms, meta, scripts, and an element tree (depth-limited). *(site content)* |
| `styles` | read | `path, css_url, offset, max_bytes` | Stylesheets used by a page, or the text of one local stylesheet. *(site content)* |

## maintain: Maintenance

| Action | Level | Arguments (* required) | What it does |
|---|---|---|---|
| `health` | draft |  | Site Health tests, versions, SSL, memory, disk, debug flags, cron, pending updates count. |
| `updates_check` | draft | `refresh` | Available core, plugin and theme updates. |
| `update` | admin | `type*, slug, backup` | Update core, a plugin or a theme (takes a database backup first by default). *(confirm, write)* |
| `backup_create` | admin | `label` | Database backup (gzip SQL) stored outside public listing. *(write)* |
| `backup_list` | admin |  | Backups made by the bridge. |
| `backup_restore` | admin | `id*` | Restore a database backup (replaces current data). *(confirm, write)* |
| `backup_delete` | admin | `id*` | Delete a backup. *(confirm, write)* |
| `logs` | admin | `lines, contains` | Tail of debug.log / PHP error log with repeated lines grouped. *(site content)* |
| `logs_clear` | admin |  | Empty debug.log. *(confirm, write)* |
| `cache_flush` | live | `scope` | Flush object cache, expired transients, rewrite rules and known cache plugins. *(write)* |
| `db_info` | admin |  | Table sizes, overhead, autoload size, counts of revisions/transients/spam/trash. |
| `db_cleanup` | admin | `targets*, keep_revisions` | Clean revisions, expired transients, spam, trash, auto-drafts, orphan meta. *(confirm, write)* |
| `db_optimize` | admin |  | OPTIMIZE TABLE on the site tables. *(write)* |
| `search_replace` | admin | `search*, replace*, tables, apply` | Serialization-safe search and replace across the database. Always preview first. *(confirm if risky, write)* |
| `cron_list` | admin |  | Scheduled events. |
| `cron_run` | admin | `hook*` | Run a scheduled hook now. *(write)* |
| `maintenance_mode` | admin | `enabled*, message` | Serve a 503 maintenance page to visitors (admins and the bridge still see the site). *(write)* |

## plugins: Plugins

| Action | Level | Arguments (* required) | What it does |
|---|---|---|---|
| `list` | draft | `status` | Installed plugins with version, status and update availability. |
| `search` | draft | `query*, per_page` | Search WordPress.org. *(site content)* |
| `install` | admin | `slug*, activate` | Install a plugin from WordPress.org by slug. *(confirm, write)* |
| `install_zip` | admin | `url*, activate` | Install a plugin from an https zip URL (no redirects, no private addresses). *(confirm, write)* |
| `activate` | admin | `plugin*` | Activate a plugin. *(write)* |
| `deactivate` | admin | `plugin*` | Deactivate a plugin (the bridge itself cannot be deactivated). *(write)* |
| `delete` | admin | `plugin*` | Delete an inactive plugin and its files. *(confirm, write)* |
| `settings_find` | admin | `slug*` | Names of options that belong to a plugin (values hidden; read them with options.get). |

## users: Users

| Action | Level | Arguments (* required) | What it does |
|---|---|---|---|
| `authors` | read | `page, per_page` | Public authors: ID, name, slug, post count. |
| `list` | admin | `role, search, page, per_page` | Users with roles (emails included). *(site content)* |
| `get` | admin | `id*` | One user, by ID, login or email. *(site content)* |
| `create` | admin | `login*, email*, role, display_name` | Create a user and send the standard set-password email. *(confirm, write)* |
| `update` | admin | `id*, display_name, email, role` | Update name, email or role (role changes are confirmed). *(confirm, write)* |
| `delete` | admin | `id*, reassign` | Delete a user, reassigning content. *(confirm, write)* |
| `send_reset` | admin | `id*` | Send a password-reset email to a user. *(write)* |
| `roles` | admin |  | Roles and their capabilities. |

## options: Site options

| Action | Level | Arguments (* required) | What it does |
|---|---|---|---|
| `get` | read>admin | `keys*` | Read options. Safe keys at read level, everything else at admin; keys that look like secrets are never returned. |
| `list` | read>admin | `prefix, page, per_page` | Names of readable options, optionally by prefix. |
| `set` | live>admin | `values*` | Write options. Safe keys (title, tagline, permalinks, reading…) at live, others at admin (confirmed); secrets are refused. *(confirm if risky, write)* |
| `delete` | admin | `key*` | Delete an option. *(confirm, write)* |

## rest: Generic REST layer

| Action | Level | Arguments (* required) | What it does |
|---|---|---|---|
| `routes` | draft | `namespace, search` | REST namespaces and routes (with methods) so you can reach any plugin. |
| `call` | read>admin | `method*, path*, query, body` | Call any REST route internally as the connected admin. Level depends on method and route: public content GET = read, sensitive routes and unknown namespaces = admin, DELETE needs confirmation. *(confirm if risky, write, site content)* |

## shop: WooCommerce

| Action | Level | Arguments (* required) | What it does |
|---|---|---|---|
| `status` | read |  | Is WooCommerce active: version, currency, product/order counts, pages. |
| `products_list` | read>draft | `search, category, status, page, per_page` | Products (published only at read level). *(site content)* |
| `product_get` | read>draft | `id*` | One product with prices, stock, attributes, variations summary. *(site content)* |
| `product_save` | draft>live | `id, name, type, status, description, short_description, sku, regular_price, sale_price, manage_stock, stock_quantity, categories, images, attributes` | Create or update a simple/variable product (publishing needs live). *(write)* |
| `product_delete` | admin | `id*` | Delete a product permanently. *(confirm, write)* |
| `stock_update` | live | `items*` | Set stock or price of products quickly. *(write)* |
| `coupons_list` | live | `page, per_page` | List discount coupons. |
| `coupon_save` | live | `id, code*, discount_type, amount, date_expires, usage_limit` | Create or update a coupon. *(write)* |
| `orders_list` | admin | `status, page, per_page` | Orders (customer data included). *(site content)* |
| `order_get` | admin | `id*` | One order with billing and shipping details. *(site content)* |
| `order_update` | admin | `id*, status, note` | Change order status or add a note. *(confirm, write)* |

## forms: Forms

| Action | Level | Arguments (* required) | What it does |
|---|---|---|---|
| `list` | live |  | Forms from Contact Form 7, Gravity Forms, WPForms or Fluent Forms. |
| `get` | live | `id*, provider` | Form definition (fields and mail settings, without secrets). *(site content)* |
| `save` | live | `id, title, form, mail_to, mail_subject, mail_body` | Create or update a Contact Form 7 form (other providers: use rest.call). *(write)* |
| `entries` | admin | `id*, provider, page, per_page` | Submitted entries (personal data). *(site content)* |

## files: Files in wp-content

| Action | Level | Arguments (* required) | What it does |
|---|---|---|---|
| `list` | admin | `root*, path, depth` | List files under a root: themes/<slug>, plugins/<slug>, mu-plugins, uploads[/sub]. |
| `read` | admin | `root*, path*, offset` | Read a file: text as text, other types as base64 (2 MB max). *(site content)* |
| `write` | admin | `root*, path*, content, data_base64` | Create or replace a file. Text types in themes/plugins/mu-plugins, media types in uploads. PHP is syntax-checked and the front page probed; previous content is kept for undo. *(confirm, write)* |
| `delete` | admin | `root*, path*` | Delete a file permanently. *(confirm, write)* |

## transfer: Export and import content

| Action | Level | Arguments (* required) | What it does |
|---|---|---|---|
| `export` | draft | `kind*, post_type, status, ids, page, per_page` | Export a page of content as portable JSON: posts (with meta, terms, SEO, builder data), terms, menus, media index or design settings. *(site content)* |
| `import` | draft>live | `kind*, items*, id_map, source_url, overwrite, publish` | Import items made by transfer.export. Creates drafts by default and skips slugs that already exist. *(confirm if risky, write)* |

## activity: Activity and undo

| Action | Level | Arguments (* required) | What it does |
|---|---|---|---|
| `log` | read | `limit, mine` | Gateway log of calls made by AI clients. *(gateway)* |
| `list` | read | `op, status, since, page, per_page` | What the bridge did on this site: operation, who, when, result, revision ID. |
| `revisions` | draft | `target, id, page, per_page` | Undoable changes with before/after summary. |
| `undo` | live | `revision*` | Revert a change by revision ID (needs at least the level of the original change). Permanent deletions cannot be undone. *(write)* |

