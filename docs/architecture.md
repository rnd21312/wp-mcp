# Architecture

## Decision: central gateway + light WordPress plugin

Two shapes were possible:

| | Plugin only (an MCP endpoint inside every site) | **Gateway + plugin (chosen)** |
|---|---|---|
| Many sites | One connector per site in Claude; the AI has to juggle several servers | One connector; every tool takes `site`, results echo it |
| Persistent login | Tokens and refresh tokens live in `wp_options` of each site; a locked or cached option, a migration, or a security plugin can drop them | Tokens live in the gateway's SQLite, independent from the sites; a site being down or reinstalled does not log the AI out |
| OAuth server | Re-implemented and exposed on every public site (more attack surface, rate limit shared with the token endpoint) | One hardened implementation, separate rate-limit buckets |
| Safety checks | Spread over many sites, each needs updates | Levels, confirmations, SSRF guard, activity log in one place; the plugin enforces them again (defence in depth) |
| Cost | Nothing to host | One small Node service to host (Docker or a single process) |

The cost is real, and so is the benefit, so the gateway wins. The plugin stays small on purpose: one signed endpoint, a list of handlers, and nothing else until a gateway is paired.

## Components

```
spec/build-spec.mjs ──► spec/ops.json ──► gateway/src/generated/ops.json
                                      └─► plugin/wp-mcp-bridge/ops.json
```

`ops.json` is the single definition of the 123 site actions: minimum level, arguments, whether they write, whether they need confirmation, whether results contain site text. A test fails when the copies differ, and a PHP test fails when an action has no handler (or a handler has no action).

### Gateway (`gateway/`, TypeScript, Node ≥ 22.13, no runtime dependencies)

| File | Job |
|---|---|
| `http.ts` | Routing, body limits, CORS, `/mcp` (POST only, stateless) |
| `mcp/server.ts` | JSON-RPC: initialize (with `instructions`), tools, resources, prompts |
| `mcp/tools.ts` | The pipeline of a tool call (below) |
| `mcp/guide.ts` | Instructions, guide resources, prompts |
| `registry.ts` | Tools and actions from the spec, argument validation and coercion |
| `oauth.ts` | OAuth 2.1: discovery, dynamic registration, authorize/consent, token, revoke |
| `auth.ts` | Bearer tokens and API keys → a *principal* (level, sites) |
| `wpclient.ts` | Signed calls to the plugin, retries, reply verification |
| `ssrf.ts` | Guarded HTTP: DNS checked at connect time, no redirects, size caps |
| `store.ts` | SQLite (`node:sqlite`): sites, keys, clients, grants, tokens, activity, idempotency |
| `admin.ts` | Owner panel: sites, keys, apps, activity |

### Plugin (`plugin/wp-mcp-bridge/`, PHP ≥ 8.1)

| File | Job |
|---|---|
| `Api.php` | `/wp-json/wp-mcp/v1/{call,pair,ping}`; verify, authorise, run, log, sign the reply |
| `Signature.php`, `Connections.php` | HMAC signing; one-time pairing codes; per-connection secrets and ceilings |
| `Policy.php` | Pure rules: option tiers, secret redaction, REST route levels, URL/SSRF checks, theme paths |
| `Revisions.php`, `Activity.php` | Undo snapshots and the site-side log (two small tables) |
| `Frontend.php` | Public effects of settings: CSS sections, tokens, redirects, built-in SEO, robots.txt, maintenance |
| `Handlers/*.php` | One class per tool: `op_<action>` (and optional `preview_<action>`) |

## A tool call, step by step

1. `POST /mcp` with `Authorization: Bearer …` → principal (API key, or OAuth access token checked against the owner's *current* grant, so changes apply at once).
2. Validate `action` and `args` against the spec (unknown or mistyped arguments get a precise error with the signature).
3. Pick the site (`site` is required when the principal can use more than one). Compute the **effective level** = `min(principal level, site ceiling)`. Deny if below the action's level.
4. Rate limits: per connection, per connection for writes, per site.
5. Confirmation: actions flagged `confirm` return `needs_confirmation` with a preview (the plugin's `dry_run`) and a `confirm_token` bound to principal, site, action and exact arguments. `maybe` actions (generic REST, options) let the plugin decide from the arguments.
6. Idempotency: a client-supplied `idempotency_key` replays the stored result; the gateway always sends a key to the plugin so transport retries cannot write twice.
7. Signed `POST` to the plugin: `HMAC-SHA256(secret, time, nonce, key id, route, sha256(body))`, 5-minute window, nonce replay cache. The plugin sets the acting administrator, re-checks the level (and escalates from the real target: editing a *published* post needs `live` even though saving a draft needs `draft`), records an undo snapshot, runs the handler and signs the reply; the gateway refuses unsigned replies.
8. The gateway logs the call and answers with `{ok, site, action, revision?, data, content_notice?}`.

## Persistence of the connection

* OAuth access token: 1 hour. Refresh token: **180 days, sliding, rotating**. A retry of a refresh whose response was lost is answered (10 min grace). A refresh token replayed after that ends the chain.
* The refresh grant is checked against the owner's current grant; lowering the level or disconnecting an app takes effect on the next call.
* No MCP session state: any gateway instance can serve any request, and the AI client can disconnect and reconnect freely.
* API keys never expire unless you set an expiry.

## Known limits

* One owner per gateway; rate limits are in memory (single process).
* The plugin cannot snapshot everything (plugin deletion, DB cleanup, updates and permanent deletes are not undoable; maintain.update takes a DB backup first).
* Sites must be reachable from the gateway over HTTPS.
