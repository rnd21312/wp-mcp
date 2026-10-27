# Connect an AI app

Your endpoint is `https://mcp.example.com/mcp` (the value of `WPMCP_PUBLIC_URL` plus `/mcp`). Two ways to sign in; both give the same tools.

* **OAuth 2.1** (browser sign-in): used by Claude.ai and by Claude Code's `/mcp` menu. You pick the **level** and the **sites** on a consent page that shows the app's name and, in large type, the **domain the result will be sent to**. Tokens renew themselves (refresh tokens last 180 days).
* **API key** (a header): good for scripts, CI and clients without OAuth. Create it in the admin panel → *API keys* with a level, optional site list and optional expiry. It is shown once.

Start with the lowest level that does the job: `read` to browse and audit, `draft` to let the AI prepare content, `live` to let it publish and design, `admin` only for maintenance sessions. You can lower an app's level in the admin panel at any time; it applies on the next call.

## Claude.ai (web and desktop app)

*Settings → Connectors → Add custom connector*, name it, URL `https://mcp.example.com/mcp`, **Add**, then **Connect**. A tab opens on your gateway: sign in as owner, choose level and sites, **Approve**. In a chat, enable the connector from the tools menu. The first thing the AI should do is `site → sites`.

## Claude Code

OAuth:

```bash
claude mcp add --transport http wp https://mcp.example.com/mcp
# then inside Claude Code:  /mcp  → select "wp" → Authenticate
```

API key:

```bash
claude mcp add --transport http wp https://mcp.example.com/mcp \
  --header "Authorization: Bearer wpmk_XXXXXXXX"
```

Add `--scope user` to use it in every project, or commit a `.mcp.json` **without** the key (use `${WPMCP_KEY}` expansion).

## Claude Desktop with a local gateway (no HTTPS, no OAuth)

Run the gateway on your own computer and let the app start it over stdio. `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wp": {
      "command": "node",
      "args": ["D:/Github/wp-mcp/gateway/dist/index.js", "stdio"],
      "env": { "WPMCP_DATA_DIR": "D:/wpmcp-data", "WPMCP_STDIO_LEVEL": "live" }
    }
  }
}
```

The stdio mode acts as the owner at `WPMCP_STDIO_LEVEL` (default `live`) on all sites; whoever can run the command is trusted, so keep that file private. Sites must be reachable over HTTPS (or set the development flags for local sites).

## Cursor, VS Code, other clients

Any client that supports remote MCP (Streamable HTTP) works. Typical `mcp.json`:

```json
{ "mcpServers": { "wp": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer wpmk_XXXXXXXX" } } } }
```

Test with the MCP Inspector: `npx @modelcontextprotocol/inspector`, transport *Streamable HTTP*, URL above, header `Authorization`.

## What the AI sees

* `instructions` on connect: how to start, levels, confirmation flow, untrusted content, idempotency.
* Resources `wpmcp://guide/*` (overview, levels, workflow, multisite, safety, design, seo, maintenance), `wpmcp://sites`, `wpmcp://ops`, `wpmcp://activity`.
* Prompts: `build_site`, `redesign_page`, `seo_audit`, `maintenance_check`, `publish_post`.
* 14 tools whose action lists are filtered to the connection's level.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `401` on `/mcp` with `invalid_token` | Key revoked or expired, or OAuth app disconnected. Reconnect (OAuth) or create a new key. A merely expired access token is renewed by the client automatically. |
| Claude.ai cannot connect | The URL must be public https and `WPMCP_PUBLIC_URL` must match it exactly. Check `https://…/.well-known/oauth-authorization-server`. |
| `level_too_low` | The action needs a higher level than the connection or the site ceiling. Raise it in the admin panel (*Ceiling* column for the site, *Level* for the app). |
| `site_required` / `unknown_site` | More than one site: pass `site`. Names come from `site → sites`. |
| `site_auth` | The site rejected the signature: the connection was revoked in WordPress or the plugin was reinstalled. Remove and connect the site again. |
| `plugin_missing` | Plugin deactivated, or a firewall/security plugin blocks `/?rest_route=/wp-mcp/v1/call`. Allow it. |
| `stale_request` / clock message | Server clocks differ by more than 5 minutes. Fix NTP on either side. |
| `unreachable` / `timeout` | The gateway cannot reach the site (DNS, firewall, Cloudflare bot protection). Allow the gateway's IP. |
| `blocked` | The site resolves to a private address. Gateways only talk to public sites (development flag exists for local tests). |
| `rate_limited` | Wait `retry_after` seconds. Limits are per connection (240/min, 60 writes/min) and per site (400/min). |
| Pairing code wrong or expired | Codes last 15 minutes and work once; 5 wrong tries burn a code. Create a new one. |
