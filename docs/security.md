# Security model

## Who is trusted

* **The owner** (one per gateway) signs in to `/admin` with a password. They create API keys, approve OAuth apps and connect sites.
* **A connection** (API key or OAuth app) acts at one *level* on some *sites*. It is trusted only as far as its level.
* **The WordPress administrator** who creates a pairing code is the account the bridge acts as on that site.
* **Website content** (posts, comments, form entries, option values, titles) is *not* trusted: strangers can write it.

## Levels

| Level | Allows | Examples |
|---|---|---|
| `read` | Published, non-sensitive data | published content and terms, design tokens, CSS, menus, SEO fields, rendered HTML, page audit, activity |
| `draft` | + drafts, private content, uploads, comment text, plugin list, health, updates check, revisions | save draft, upload media, set SEO on drafts, REST discovery |
| `live` | + anything visitors see | publish/edit published, templates, CSS, tokens, menus, redirects, products/stock/coupons, moderation, cache, forms, undo |
| `admin` | + everything sensitive | plugins, updates, backups/restore, users, options, orders, DB cleanup, search-replace, theme files, logs, any unlisted REST route |

The effective level is `min(connection level, site ceiling)`. The ceiling is set in the gateway **and** inside WordPress (*Tools → WP MCP Bridge*), and the plugin re-checks every call, so a compromised gateway still cannot exceed what the site owner allowed. Some actions *escalate* from the real target (editing a published post needs `live`; changing site visibility needs `admin`).

What `read` cannot see, on purpose: drafts and private posts, users (only public author names), orders and customers, options other than public settings, comment emails/IPs, logs, plugin versions, form entries, backups. Option or meta values whose key looks like a secret (`*secret*`, `*token*`, `*password*`, `*api_key*`, `*license*`, `*smtp*`…) are never returned, even to admin, and cannot be written.

## Confirmation, undo, activity

* Actions marked **confirm** (permanent deletes, plugin/theme install, URL imports, updates, restore, search-replace with apply, theme-file writes, role changes…) return a preview and a `confirm_token` first. The token is signed, valid 5 minutes, and bound to the connection, site, action **and exact arguments**. This is a guard against accidents and runaway loops; the AI is told to show the preview to the person and wait for a yes. It does not by itself prove a human said yes: use your MCP client's own tool-approval prompts for that, and keep high levels for supervised sessions.
* Every write records a before-snapshot. `activity.undo {revision}` restores posts (fields, meta, terms), options and settings, CSS, tokens, menus, redirects, plugin activation, theme, comment states, theme files. Not undoable: permanent deletes, plugin deletion, DB cleanup/optimize, search-replace, updates, user deletion. `maintain.update` takes a database backup first and `maintain.backup_restore` takes a safety backup before restoring.
* The gateway logs every call (who, site, action, result, short argument summary) and so does the plugin (writes and failures). The AI can read both with `activity.log` and `activity.list`; the owner sees them in the admin panel and in *Tools → WP MCP Bridge*.

## Network defences

* **Gateway → site**: HTTPS; the DNS answer is checked **at connect time** and private, loopback, link-local, metadata (169.254.x), CGNAT, multicast and reserved ranges are refused (defeats rebinding); redirects are never followed; responses are size-capped; timeouts are enforced. Local/private sites need an explicit development flag.
* **Plugin downloads** (`media.import_url`, `plugins.install_zip`): https only, no credentials, no redirects, every resolved address must be public, size caps, real file-type checks. `install_zip` is admin + confirm. The plugin resolves the host before fetching; a very fast DNS rebinding between the check and the fetch is a theoretical residual risk, which is why URL-based installs are admin-only.
* **Request signing**: HMAC-SHA256 over time, nonce, key id, route and body hash; ±5 minutes; nonce replay cache; the reply is signed too and the gateway rejects unsigned replies.
* **Pairing**: one-time code (80 bits), 15 minutes, 5 wrong tries burn it, refused over plain http, rate limited per address. The site secret is shown to the gateway once and stored AES-256-GCM encrypted.
* **Inspect tools** only fetch pages of the site itself.

## OAuth

* Authorization code + **PKCE S256 only**, public clients only, single-use codes (60 s).
* Dynamic registration is allowed (Claude.ai needs it) but constrained: 1–5 redirect URIs that must be `https`, loopback `http` (desktop tools) or an editor scheme; no fragments, credentials, `javascript:`/`data:`; max 200 registrations; 10 per hour per address; unused registrations are purged after a day.
* The consent page (English or Persian, `&lang=fa`) requires an owner session, shows the self-declared app name with a "not verified" note, the **redirect domain in large type**, level choices (no pre-selected `admin`) and site checkboxes, and has CSRF protection.
* Access token 1 h; refresh token 180 days sliding, rotating, reuse of an old token after the 10-minute retry window revokes the chain. Tokens are stored as SHA-256 hashes only. The owner's *current* grant is consulted on every call, so lowering a level or disconnecting an app is immediate.
* Token endpoint is rate limited per client; failed bearer attempts are throttled per address.

## Prompt injection

Text that comes from the website is returned with a `content_notice` and the server `instructions` tell the model to treat it as data. That is advice to the model, not enforcement. The enforcement is structural: a model that reads a malicious comment still cannot exceed its level, still hits the confirmation step for destructive actions, can be undone, and is visible in the log. Below `admin`, HTML the AI writes is filtered with `kses` (no scripts); CSS rejects `</style>`, `javascript:`, `expression()`, and remote `@import` except Google Fonts.

## Admin panel

Password hashed with scrypt, signed `HttpOnly` `SameSite=Lax` cookie (`Secure` on https), CSRF tokens on every form, login throttling, strict CSP and `X-Frame-Options: DENY`. There is no 2FA: if the panel is internet-facing, put it behind your reverse proxy's authentication or IP allow-list.

## Honest limits

* An `admin` connection is powerful by design: installing a plugin or writing a theme file is code execution on that site. Grant `admin` rarely, to supervised sessions, and set the site ceiling to `live` if you never want it.
* Rate limits live in memory of one gateway process.
* The master key encrypts site secrets; anyone who can read `data/` and the key can impersonate the gateway to your sites. Protect and back up that folder.
* Logs contain short argument summaries (not full content). They can include page titles or slugs.
* The built-in SEO layer, redirects and CSS apply on top of the theme; conflicting plugins can override them.
* The plugin cannot be unit-tested without WordPress here: the repo ships policy/signature/spec-coverage tests that run without it and lints every file; a staging site is the right place for a first real run.

## Reporting

Please report vulnerabilities privately to the maintainer rather than in a public issue.
