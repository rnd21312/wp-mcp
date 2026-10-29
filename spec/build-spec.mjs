// Single source of truth for every operation. Run `node spec/build-spec.mjs` to regenerate spec/ops.json;
// scripts/sync-spec.mjs copies it into the gateway and the plugin.
//
// op(id, level, summary, params, flags)
//   level : minimum level (read < draft < live < admin). The plugin may escalate (flag e) from the real target.
//   params: { name: "type|description" }, a trailing * on the name means required.
//           types: string int bool object array any, enum:a,b,c
//   flags : w = writes, c = needs explicit confirmation (two-step; 'maybe' = the site decides from the arguments), u = result contains site content (untrusted), e = may escalate to a higher level
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ops = [];
const op = (id, level, summary, params = {}, flags = {}) => {
  const [tool, action] = id.split('.');
  const required = Object.keys(params).filter((k) => k.endsWith('*')).map((k) => k.slice(0, -1));
  const clean = {};
  for (const [k, v] of Object.entries(params)) clean[k.replace(/\*$/, '')] = v;
  ops.push({ id, tool, action, level, summary, params: clean, required, write: !!flags.w, confirm: flags.c === 'maybe' ? 'maybe' : !!flags.c, untrusted: !!flags.u, escalates: flags.e || null });
};

const ID = 'any|Post ID, or slug/path as a string';
const PAGE = { page: 'int|Page number (default 1)', per_page: 'int|Items per page (default 20, max 100)' };

/* site */
op('site.overview', 'read', 'Name, URL, theme, active plugins, content types, taxonomies, menus, SEO plugin, WooCommerce, locale, bridge ceiling and ops.', {}, { u: 1 });
op('site.ping', 'read', 'Bridge version, PHP/WP versions, clock skew and round-trip check.');

/* content */
op('content.list', 'read', 'List posts/pages/custom types (non-published statuses need draft level).', { post_type: 'string|Default post', status: 'string|publish (default), draft, pending, future, private, trash, any', search: 'string|Search text', term: 'string|taxonomy:slug filter, e.g. category:news', author: 'int|Author ID', orderby: 'enum:date,modified,title,menu_order,id|Default date', order: 'enum:asc,desc|Default desc', ...PAGE }, { u: 1, e: 'draft' });
op('content.get', 'read', 'Read one item with raw content, meta, terms, SEO, template. Drafts need draft level.', { 'id*': ID, post_type: 'string|Needed when id is a slug', include: 'array|Extras: revisions, seo, blocks' }, { u: 1, e: 'draft' });
op('content.save', 'draft', 'Create or update a post/page/custom item. Keep status draft/pending at draft level; publish or edit published items needs live.', { id: 'int|Omit to create', post_type: 'string|Default post', title: 'string|Title', content: 'string|Block markup or HTML', excerpt: 'string|Excerpt', status: 'string|draft, pending, publish, future, private', slug: 'string|URL slug', parent: 'int|Parent ID', template: 'string|Page template file or block template slug', featured_media: 'int|Attachment ID', date: 'string|Y-m-d H:i:s (site time), schedules when future', terms: 'object|{taxonomy: [names or ids]}', meta: 'object|{key: value}; protected keys are refused', menu_order: 'int|Order', comment_status: 'enum:open,closed|Comments' }, { w: 1, e: 'live' });
op('content.duplicate', 'draft', 'Copy an item as a new draft.', { 'id*': 'int|Source ID' }, { w: 1 });
op('content.trash', 'live', 'Move to trash (recoverable).', { 'id*': 'int|ID' }, { w: 1 });
op('content.restore', 'live', 'Restore from trash.', { 'id*': 'int|ID' }, { w: 1 });
op('content.delete', 'admin', 'Delete permanently. Cannot be undone.', { 'id*': 'int|ID' }, { w: 1, c: 1 });
op('content.revisions', 'draft', 'List WordPress revisions of an item, or restore one.', { 'id*': 'int|Post ID', restore: 'int|Revision ID to restore (needs live)' }, { w: 1, u: 1 });
op('content.bulk', 'live', 'Change the status of up to 50 items at once.', { 'ids*': 'array|Post IDs', 'status*': 'string|publish, draft, pending, private or trash' }, { w: 1 });
op('content.terms_list', 'read', 'List categories, tags or any taxonomy terms.', { taxonomy: 'string|Default category', search: 'string|Search', hide_empty: 'bool|Default false', ...PAGE }, { u: 1 });
op('content.terms_save', 'live', 'Create or update a term.', { id: 'int|Omit to create', taxonomy: 'string|Default category', 'name*': 'string|Name', slug: 'string|Slug', parent: 'int|Parent term', description: 'string|Description' }, { w: 1 });
op('content.terms_delete', 'live', 'Delete a term (posts keep existing).', { 'id*': 'int|Term ID', taxonomy: 'string|Default category' }, { w: 1, c: 1 });
op('content.comments_list', 'draft', 'List comments (author email only at admin level).', { post_id: 'int|Filter by post', status: 'string|approve, hold, spam, trash, all', search: 'string|Text', ...PAGE }, { u: 1 });
op('content.comments_moderate', 'live', 'Approve, hold, spam or trash comments.', { 'ids*': 'array|Comment IDs', 'action*': 'enum:approve,hold,spam,trash,unspam' }, { w: 1 });
op('content.comments_reply', 'live', 'Reply to a comment as the connected admin.', { 'comment_id*': 'int|Parent comment', 'content*': 'string|Reply text' }, { w: 1 });
op('content.comments_delete', 'admin', 'Delete comments permanently.', { 'ids*': 'array|Comment IDs' }, { w: 1, c: 1 });

/* design */
op('design.tokens_get', 'read', 'Design tokens: colors, fonts, font sizes, spacing, layout widths (theme.json + site tokens).', {}, {});
op('design.tokens_set', 'live', 'Merge design tokens. Emitted as CSS variables (--wpm-*) and, on block themes, merged into Global Styles.', { colors: 'object|{slug: "#hex"}', fonts: 'object|{slug: "font-family stack"}', font_sizes: 'object|{slug: "1.25rem"}', spacing: 'object|{slug: "1rem"}', radius: 'string|Border radius', content_width: 'string|Content width, e.g. 1100px' }, { w: 1 });
op('design.css_get', 'read', 'Additional CSS (named sections) as stored.', { section: 'string|Only this section' });
op('design.css_set', 'live', 'Write CSS into a named section (replace, append or prepend). Other sections are untouched.', { 'css*': 'string|CSS text (max 200 KB)', section: 'string|Section name, default main', mode: 'enum:replace,append,prepend|Default replace' }, { w: 1 });
op('design.css_remove', 'live', 'Remove a CSS section.', { 'section*': 'string|Section name' }, { w: 1 });
op('design.templates_list', 'read', 'Block templates and template parts (header, footer…), or classic theme template files.', { kind: 'enum:template,part|Default both' });
op('design.template_get', 'read', 'Read a template or part (raw block markup).', { 'slug*': 'string|Template slug, e.g. header, footer, single, front-page', kind: 'enum:template,part|Default template' }, { u: 1 });
op('design.template_save', 'live', 'Create or override a template/part (block themes). Revert with design.template_reset.', { 'slug*': 'string|Slug', 'content*': 'string|Block markup', kind: 'enum:template,part|Default template', title: 'string|Title', area: 'enum:header,footer,uncategorized|For parts' }, { w: 1 });
op('design.template_reset', 'live', 'Drop the custom version, falling back to the theme file.', { 'slug*': 'string|Slug', kind: 'enum:template,part|Default template' }, { w: 1 });
op('design.menus_list', 'read', 'Menus and theme locations.');
op('design.menu_get', 'read', 'One menu as a tree.', { 'menu*': 'any|Menu ID, slug or name' });
op('design.menu_save', 'live', 'Create or replace a menu from a tree and assign locations.', { 'name*': 'string|Menu name', 'items*': 'array|[{title, url | object:"page"+object_id, children:[…]}]', locations: 'array|Theme locations to assign' }, { w: 1 });
op('design.menu_delete', 'live', 'Delete a menu and its items (recoverable with activity.undo).', { 'menu*': 'any|ID, slug or name' }, { w: 1, c: 1 });
op('design.homepage_set', 'live', 'Static front page / posts page, or latest posts.', { show_on_front: 'enum:posts,page|Mode', front_page_id: 'int|Page ID', posts_page_id: 'int|Page ID for the blog' }, { w: 1 });
op('design.branding_set', 'live', 'Site title, tagline, logo and site icon.', { title: 'string|Site title', tagline: 'string|Tagline', logo_id: 'int|Attachment ID (theme custom logo)', icon_id: 'int|Attachment ID (site icon, square ≥512px)' }, { w: 1 });
op('design.themes_list', 'draft', 'Installed themes and which is active.');
op('design.theme_activate', 'admin', 'Switch the active theme.', { 'slug*': 'string|Theme directory' }, { w: 1, c: 1 });
op('design.theme_install', 'admin', 'Install a theme from WordPress.org by slug.', { 'slug*': 'string|WordPress.org slug', activate: 'bool|Activate after install' }, { w: 1, c: 1 });
op('design.theme_install_zip', 'admin', 'Install a theme from an https zip URL (GitHub release, your own server; redirects are re-checked).', { 'url*': 'string|https URL of a zip', activate: 'bool|Activate after install', overwrite: 'bool|Replace an existing theme folder' }, { w: 1, c: 1 });
op('design.theme_files', 'admin', 'List files of the active (or given) theme.', { theme: 'string|Theme directory' });
op('design.theme_file_read', 'admin', 'Read a theme file.', { 'path*': 'string|Path inside the theme', theme: 'string|Theme directory', offset: 'int|Byte offset' }, { u: 1 });
op('design.theme_file_write', 'admin', 'Write a theme file (PHP is syntax-checked; previous content is kept for undo).', { 'path*': 'string|Path inside the theme (php, css, js, json, html)', 'content*': 'string|File content', theme: 'string|Theme directory' }, { w: 1, c: 1 });

/* media */
op('media.list', 'read', 'Media library items with URLs, sizes and alt text.', { search: 'string|Text', mime: 'string|e.g. image, image/png, application/pdf', ...PAGE }, { u: 1 });
op('media.get', 'read', 'One attachment with all sizes.', { 'id*': 'int|Attachment ID' }, { u: 1 });
op('media.upload', 'draft', 'Upload a file from base64 data (max 10 MB; bigger: put it in uploads and use media.register).', { 'filename*': 'string|e.g. hero.jpg', 'data_base64*': 'string|File bytes, base64', title: 'string|Title', alt: 'string|Alt text (default: title)', caption: 'string|Caption', description: 'string|Description', attach_to: 'int|Post ID', featured: 'bool|With attach_to: make it the featured image', optimize: 'any|true (saved settings) or {max_width, quality 30-100, format webp|jpeg|png|avif|mp4|webm}: shrink and convert while storing' }, { w: 1 });
op('media.import_url', 'live', 'Download an image/file from an https URL (no redirects, no private addresses).', { 'url*': 'string|https URL', filename: 'string|Override filename', title: 'string|Title', alt: 'string|Alt text', attach_to: 'int|Post ID' }, { w: 1, c: 1 });
op('media.register', 'draft', 'Add files that already lie in wp-content/uploads (copied by FTP/files.write) to the media library: makes sizes, alt text, optional featured image. scan:true finds all unregistered files.', { paths: 'array|Paths relative to uploads, e.g. ["2025/05/hero.jpg"]', scan: 'bool|Find every file not yet in the library', attach_to: 'int|Post ID', featured: 'bool|With attach_to: first image becomes the featured image', title: 'string|Title (single file)', alt: 'string|Alt text (single file)', caption: 'string|Caption', description: 'string|Description', limit: 'int|Max files per call (default 30, max 100)', optimize: 'any|true (saved settings) or {max_width, quality 30-100, format webp|jpeg|png|avif|mp4|webm}: shrink and convert while storing' }, { w: 1 });
op('media.optimize', 'live', 'Shrink and/or convert existing library images (jpeg/png/webp/avif) or videos (ffmpeg needed) to save space. Replaces the file for good; links in posts are rewritten.', { id: 'int|Attachment ID', ids: 'array|Up to 10 attachment IDs', max_width: 'int|Resize wider images (0 = keep)', quality: 'int|30-100 (default saved setting, 82)', format: 'string|keep, webp, jpeg, png, avif, mp4, webm', fix_links: 'bool|Rewrite old URLs in post content (default true)' }, { w: 1, c: 1 });
op('media.update', 'draft', 'Edit metadata of one item: alt text, title, caption, description, slug.', { 'id*': 'int|Attachment ID', alt: 'string|Alt', title: 'string|Title', caption: 'string|Caption', description: 'string|Description', slug: 'string|File page slug' }, { w: 1 });
op('media.delete', 'admin', 'Delete an attachment and its files permanently.', { 'id*': 'int|Attachment ID' }, { w: 1, c: 1 });

/* seo */
op('seo.get', 'read', 'SEO fields of an item (title, description, canonical, robots, OG, schema), via Yoast/Rank Math/AIOSEO/SEOPress or the built-in fallback.', { 'id*': ID }, { u: 1, e: 'draft' });
op('seo.set', 'draft', 'Set SEO fields. Published items need live.', { 'id*': 'int|Post ID', title: 'string|SEO title', description: 'string|Meta description', canonical: 'string|Canonical URL', noindex: 'bool|Hide from search', nofollow: 'bool|Do not follow links', og_title: 'string|', og_description: 'string|', og_image: 'string|Image URL', focus_keyword: 'string|Focus keyword' }, { w: 1, e: 'live' });
op('seo.audit', 'read', 'Audit a page of this site: title/description length, headings, alt text, canonical, robots, OG, schema, links, size. Returns scored issues with fixes.', { path: 'string|Path like /about/', id: 'int|Post ID' }, { u: 1 });
op('seo.site_get', 'read', 'Site-wide SEO: search visibility, robots.txt, sitemap provider, organisation schema, active SEO plugin.');
op('seo.site_set', 'live', 'Site-wide SEO (built-in layer): robots.txt text, organisation schema, title separator, default OG image. Search visibility needs admin.', { robots_txt: 'string|Full robots.txt content', org_name: 'string|', org_logo: 'string|URL', org_same_as: 'array|Profile URLs', title_separator: 'string|', default_og_image: 'string|URL', blog_public: 'bool|false hides the whole site from search (admin only)' }, { w: 1, e: 'admin' });
op('seo.sitemap', 'read', 'Sitemap provider, URL and number of URLs; can switch the core sitemap on or off.', { enable: 'bool|Switch core sitemap (needs live)' }, { e: 'live' });
op('seo.redirects_list', 'draft', 'Redirects managed by the bridge.', ...[{ ...PAGE }]);
op('seo.redirect_save', 'live', 'Add or update a redirect.', { 'from*': 'string|Path like /old/ (or regex when regex=true)', 'to*': 'string|Path or URL (empty for 410/451)', code: 'enum:301,302,307,308,410,451|Default 301', regex: 'bool|Treat from as a regex' }, { w: 1 });
op('seo.redirect_delete', 'live', 'Remove a redirect.', { 'from*': 'string|Exact from value' }, { w: 1 });
op('seo.schema_get', 'read', 'Custom JSON-LD of an item.', { 'id*': 'int|Post ID' }, { u: 1 });
op('seo.schema_set', 'live', 'Set custom JSON-LD for an item (empty removes it).', { 'id*': 'int|Post ID', 'json*': 'any|JSON-LD object or array (or a JSON string)' }, { w: 1 });

/* inspect */
op('inspect.page', 'read', 'Rendered HTML of a page of this site (same host only, redirects not followed off-site).', { 'path*': 'string|Path like /about/ or full URL on this site', max_bytes: 'int|Default 60000', offset: 'int|Byte offset' }, { u: 1 });
op('inspect.render', 'draft', 'Render a post (also drafts) through the_content, without the theme.', { 'id*': 'int|Post ID', max_bytes: 'int|Default 60000' }, { u: 1 });
op('inspect.outline', 'read', 'Compact structure of a page: headings, landmarks, images, links, forms, meta, scripts, and an element tree (depth-limited).', { 'path*': 'string|Path or URL on this site', selector: 'string|Simple selector (#id, .class, tag) to zoom into', depth: 'int|Tree depth (default 4)' }, { u: 1 });
op('inspect.styles', 'read', 'Stylesheets used by a page, or the text of one local stylesheet.', { path: 'string|Page path to list its stylesheets', css_url: 'string|One local stylesheet URL to read', offset: 'int|Byte offset', max_bytes: 'int|Default 60000' }, { u: 1 });

/* maintain */
op('maintain.health', 'draft', 'Site Health tests, versions, SSL, memory, disk, debug flags, cron, pending updates count.');
op('maintain.updates_check', 'draft', 'Available core, plugin and theme updates.', { refresh: 'bool|Force a new check' });
op('maintain.update', 'admin', 'Update core, a plugin or a theme (takes a database backup first by default).', { 'type*': 'enum:core,plugin,theme|What to update', slug: 'string|Plugin file (dir/file.php) or theme directory; omit for core', backup: 'bool|Default true' }, { w: 1, c: 1 });
op('maintain.backup_create', 'admin', 'Database backup (gzip SQL) stored outside public listing.', { label: 'string|Note' }, { w: 1 });
op('maintain.backup_list', 'admin', 'Backups made by the bridge.');
op('maintain.backup_restore', 'admin', 'Restore a database backup (replaces current data).', { 'id*': 'string|Backup ID' }, { w: 1, c: 1 });
op('maintain.backup_delete', 'admin', 'Delete a backup.', { 'id*': 'string|Backup ID' }, { w: 1, c: 1 });
op('maintain.logs', 'admin', 'Tail of debug.log / PHP error log with repeated lines grouped.', { lines: 'int|Default 100, max 500', contains: 'string|Filter text' }, { u: 1 });
op('maintain.logs_clear', 'admin', 'Empty debug.log.', {}, { w: 1, c: 1 });
op('maintain.cache_flush', 'live', 'Flush object cache, expired transients, rewrite rules and known cache plugins.', { scope: 'array|any of: object, transients, rewrite, plugins (default all)' }, { w: 1 });
op('maintain.db_info', 'admin', 'Table sizes, overhead, autoload size, counts of revisions/transients/spam/trash.');
op('maintain.db_cleanup', 'admin', 'Clean revisions, expired transients, spam, trash, auto-drafts, orphan meta.', { 'targets*': 'array|revisions, transients, spam, trash, auto_drafts, orphan_meta', keep_revisions: 'int|Revisions to keep per post (default 5)' }, { w: 1, c: 1 });
op('maintain.db_optimize', 'admin', 'OPTIMIZE TABLE on the site tables.', {}, { w: 1 });
op('maintain.search_replace', 'admin', 'Serialization-safe search and replace across the database. Always preview first.', { 'search*': 'string|Text to find', 'replace*': 'string|Replacement', tables: 'array|Limit to these tables', apply: 'bool|false (default) only counts' }, { w: 1, c: 'maybe' });
op('maintain.language_install', 'admin', 'Download a language pack (core, plugins, themes), e.g. fa_IR, and optionally make it the site language.', { 'locale*': 'string|e.g. fa_IR, ar, de_DE', activate: 'bool|Also set it as the site language' }, { w: 1 });
op('maintain.cron_list', 'admin', 'Scheduled events.');
op('maintain.cron_run', 'admin', 'Run a scheduled hook now.', { 'hook*': 'string|Registered hook name' }, { w: 1 });
op('maintain.maintenance_mode', 'admin', 'Serve a 503 maintenance page to visitors (admins and the bridge still see the site).', { 'enabled*': 'bool|On or off', message: 'string|Visitor message' }, { w: 1 });

/* plugins */
op('plugins.list', 'draft', 'Installed plugins with version, status and update availability.', { status: 'enum:all,active,inactive,update|Default all' });
op('plugins.search', 'draft', 'Search WordPress.org.', { 'query*': 'string|Search', per_page: 'int|Default 10' }, { u: 1 });
op('plugins.install', 'admin', 'Install a plugin from WordPress.org by slug.', { 'slug*': 'string|WordPress.org slug', activate: 'bool|Activate after install' }, { w: 1, c: 1 });
op('plugins.install_zip', 'admin', 'Install a plugin from an https zip URL (no redirects, no private addresses).', { 'url*': 'string|https URL of a zip', activate: 'bool|Activate after install' }, { w: 1, c: 1 });
op('plugins.activate', 'admin', 'Activate a plugin.', { 'plugin*': 'string|Plugin file, e.g. woocommerce/woocommerce.php' }, { w: 1 });
op('plugins.deactivate', 'admin', 'Deactivate a plugin (the bridge itself cannot be deactivated).', { 'plugin*': 'string|Plugin file' }, { w: 1 });
op('plugins.delete', 'admin', 'Delete an inactive plugin and its files.', { 'plugin*': 'string|Plugin file' }, { w: 1, c: 1 });
op('plugins.settings_find', 'admin', 'Names of options that belong to a plugin (values hidden; read them with options.get).', { 'slug*': 'string|Plugin slug or option prefix' });

/* users */
op('users.authors', 'read', 'Public authors: ID, name, slug, post count.', { ...PAGE });
op('users.list', 'admin', 'Users with roles (emails included).', { role: 'string|Filter', search: 'string|', ...PAGE }, { u: 1 });
op('users.get', 'admin', 'One user, by ID, login or email.', { 'id*': 'any|ID, login or email' }, { u: 1 });
op('users.create', 'admin', 'Create a user and send the standard set-password email.', { 'login*': 'string|', 'email*': 'string|', role: 'string|Default subscriber', display_name: 'string|' }, { w: 1, c: 1 });
op('users.update', 'admin', 'Update name, email or role (role changes are confirmed).', { 'id*': 'int|', display_name: 'string|', email: 'string|', role: 'string|' }, { w: 1, c: 1 });
op('users.delete', 'admin', 'Delete a user, reassigning content.', { 'id*': 'int|', reassign: 'int|User to receive content' }, { w: 1, c: 1 });
op('users.send_reset', 'admin', 'Send a password-reset email to a user.', { 'id*': 'int|' }, { w: 1 });
op('users.roles', 'admin', 'Roles and their capabilities.');

/* options */
op('options.get', 'read', 'Read options. Safe keys at read level, everything else at admin; keys that look like secrets are never returned.', { 'keys*': 'array|Option names' }, { e: 'admin' });
op('options.list', 'read', 'Names of readable options, optionally by prefix.', { prefix: 'string|', ...PAGE }, { e: 'admin' });
op('options.set', 'live', 'Write options. Safe keys (title, tagline, permalinks, reading…) at live, others at admin (confirmed); secrets are refused.', { 'values*': 'object|{option: value}' }, { w: 1, e: 'admin', c: 'maybe' });
op('options.delete', 'admin', 'Delete an option.', { 'key*': 'string|' }, { w: 1, c: 1 });

/* rest */
op('rest.routes', 'draft', 'REST namespaces and routes (with methods) so you can reach any plugin.', { namespace: 'string|e.g. wc/v3', search: 'string|Substring of the route' });
op('rest.call', 'read', 'Call any REST route internally as the connected admin. Level depends on method and route: public content GET = read, sensitive routes and unknown namespaces = admin, DELETE needs confirmation.', { 'method*': 'enum:GET,POST,PUT,PATCH,DELETE|HTTP method', 'path*': 'string|e.g. /wp/v2/posts or /wc/v3/products', query: 'object|Query parameters', body: 'object|JSON body' }, { w: 1, u: 1, e: 'admin', c: 'maybe' });

/* shop (WooCommerce) */
op('shop.status', 'read', 'Is WooCommerce active: version, currency, product/order counts, pages.', {}, {});
op('shop.products_list', 'read', 'Products (published only at read level).', { search: 'string|', category: 'string|Category slug', status: 'string|publish, draft, any', ...PAGE }, { u: 1, e: 'draft' });
op('shop.product_get', 'read', 'One product with prices, stock, attributes, variations summary.', { 'id*': 'int|' }, { u: 1, e: 'draft' });
op('shop.product_save', 'draft', 'Create or update a simple/variable product (publishing needs live).', { id: 'int|Omit to create', name: 'string|', type: 'enum:simple,variable,grouped,external|', status: 'string|', description: 'string|', short_description: 'string|', sku: 'string|', regular_price: 'string|', sale_price: 'string|', manage_stock: 'bool|', stock_quantity: 'int|', categories: 'array|Category names or IDs', images: 'array|Attachment IDs', attributes: 'array|[{name, options:[…], variation:bool}]' }, { w: 1, e: 'live' });
op('shop.product_delete', 'admin', 'Delete a product permanently.', { 'id*': 'int|' }, { w: 1, c: 1 });
op('shop.stock_update', 'live', 'Set stock or price of products quickly.', { 'items*': 'array|[{id, stock_quantity?, regular_price?, sale_price?}] max 50' }, { w: 1 });
op('shop.coupons_list', 'live', 'List discount coupons.', { ...PAGE });
op('shop.coupon_save', 'live', 'Create or update a coupon.', { id: 'int|', 'code*': 'string|', discount_type: 'enum:percent,fixed_cart,fixed_product|', amount: 'string|', date_expires: 'string|', usage_limit: 'int|' }, { w: 1 });
op('shop.orders_list', 'admin', 'Orders (customer data included).', { status: 'string|', ...PAGE }, { u: 1 });
op('shop.order_get', 'admin', 'One order with billing and shipping details.', { 'id*': 'int|' }, { u: 1 });
op('shop.order_update', 'admin', 'Change order status or add a note.', { 'id*': 'int|', status: 'string|', note: 'string|Private note' }, { w: 1, c: 1 });

/* forms */
op('forms.list', 'live', 'Forms from Contact Form 7, Gravity Forms, WPForms or Fluent Forms.');
op('forms.get', 'live', 'Form definition (fields and mail settings, without secrets).', { 'id*': 'any|Form ID', provider: 'string|cf7, gravity, wpforms, fluent' }, { u: 1 });
op('forms.save', 'live', 'Create or update a Contact Form 7 form (other providers: use rest.call).', { id: 'int|', title: 'string|', form: 'string|CF7 form markup', mail_to: 'string|Recipient', mail_subject: 'string|', mail_body: 'string|' }, { w: 1 });
op('forms.entries', 'admin', 'Submitted entries (personal data).', { 'id*': 'any|Form ID', provider: 'string|', ...PAGE }, { u: 1 });

/* files (wp-content) */
op('files.list', 'admin', 'List files under a root (root "themes" or "plugins" lists folders): core (WordPress folder, read-only except .htaccess and robots.txt), themes/<slug>, plugins/<slug>, mu-plugins, uploads[/sub].', { 'root*': 'string|e.g. themes/twentytwentyfive, plugins/akismet, mu-plugins, uploads/2026', path: 'string|Subfolder inside the root', depth: 'int|1-4 (default 2)' });
op('files.read', 'admin', 'Read a file: text as text, other types as base64 (2 MB max).', { 'root*': 'string|See files.list', 'path*': 'string|File path inside the root', offset: 'int|Byte offset' }, { u: 1 });
op('files.write', 'admin', 'Create or replace a file; missing theme/plugin/mu-plugins folders are created. Text types in themes/plugins/mu-plugins, media types in uploads. PHP is syntax-checked and the front page probed; previous content is kept for undo.', { 'root*': 'string|See files.list', 'path*': 'string|File path inside the root', content: 'string|Text content', data_base64: 'string|Binary content (instead of content)' }, { w: 1, c: 1 });
op('files.write_many', 'admin', 'Write up to 60 files into one root in one call (a theme or plugin skeleton). New themes/<slug>, plugins/<slug>, mu-plugins and uploads folders are created. Each file is undoable.', { 'root*': 'string|See files.list', 'files*': 'array|[{path, content | data_base64}]' }, { w: 1, c: 1 });
op('files.delete', 'admin', 'Delete a file permanently.', { 'root*': 'string|See files.list', 'path*': 'string|File path inside the root' }, { w: 1, c: 1 });

/* transfer (building blocks; site.transfer in the gateway chains them between two sites) */
op('transfer.export', 'draft', 'Export a page of content as portable JSON: posts (with meta, terms, SEO, builder data), terms, menus, media index or design settings.', { 'kind*': 'enum:posts,terms,menus,media,design,users,options|What to export (users and options need admin)', post_type: 'string|For posts and media (default page)', status: 'string|publish (default); other statuses need draft level', ids: 'array|Only these post IDs', page: 'int|Page number', per_page: 'int|Default 10, max 25', prefixes: 'array|For kind options: option name prefixes, e.g. ["woocommerce_"]' }, { u: 1 });
op('transfer.import', 'draft', 'Import items made by transfer.export. Creates drafts by default and skips slugs that already exist.', { 'kind*': 'enum:posts,terms,menus,media,design,users,options|What is imported (users and options need admin and confirmation)', 'items*': 'array|Items from transfer.export', id_map: 'object|{posts:{old:new}, media:{old:new}} from earlier imports', source_url: 'string|Home URL of the source site (its links are rewritten and its uploads fetched over https)', overwrite: 'bool|Replace content of existing slugs', publish: 'bool|Keep the source status instead of draft (live level)' }, { w: 1, e: 'live', c: 'maybe' });

/* activity */
op('activity.list', 'read', 'What the bridge did on this site: operation, who, when, result, revision ID.', { op: 'string|Filter by operation', status: 'enum:ok,error,denied|', since: 'string|ISO date', ...PAGE });
op('activity.revisions', 'draft', 'Undoable changes with before/after summary.', { target: 'string|post, option, file, redirect, css…', id: 'any|Target ID', ...PAGE });
op('activity.undo', 'live', 'Revert a change by revision ID (needs at least the level of the original change). Permanent deletions cannot be undone.', { 'revision*': 'int|Revision ID' }, { w: 1 });

const here = dirname(fileURLToPath(import.meta.url));
const spec = { version: 1, levels: ['read', 'draft', 'live', 'admin'], ops };
writeFileSync(join(here, 'ops.json'), JSON.stringify(spec, null, 1) + '\n');
console.log(`spec: ${ops.length} ops`);
