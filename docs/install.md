# Install

## 1. The gateway

Requirements: Node.js **22.13 or newer** (uses the built-in `node:sqlite`), a public **HTTPS** address (Claude.ai only talks to HTTPS), and a persistent folder for `data/`.

### Option A: Node

```bash
cd gateway
npm ci
npm run build
WPMCP_PUBLIC_URL=https://mcp.example.com PORT=8787 WPMCP_TRUST_PROXY=1 npm start
```

### Option B: Docker

```bash
cp .env.example .env      # set WPMCP_PUBLIC_URL at least
docker compose up -d --build
```

The image keeps its data in the `wpmcp-data` volume.

### Reverse proxy (HTTPS)

Caddy (automatic certificates):

```
mcp.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

nginx: proxy to `127.0.0.1:8787`, pass `Host` and `X-Forwarded-For`, set `client_max_body_size 16m;`, and enable `WPMCP_TRUST_PROXY=1` so rate limits use the real client address. For local tests without a domain use a tunnel (`cloudflared tunnel --url http://localhost:8787`).

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `WPMCP_PUBLIC_URL` | `http://localhost:PORT` | The address clients use. **Must be the real public https URL** in production: it appears in OAuth metadata and redirects. |
| `PORT` / `WPMCP_HOST` | `8787` / `0.0.0.0` | Listen address |
| `WPMCP_DATA_DIR` | `./data` | SQLite database and `master.key` |
| `WPMCP_MASTER_KEY` | generated in `data/master.key` | 32 bytes (64 hex or base64) encrypting site secrets and signing cookies and confirmation tokens |
| `WPMCP_ADMIN_PASSWORD` | none | Create the owner at start-up (12+ chars) instead of using the setup token |
| `WPMCP_TRUST_PROXY` | off | `1` to trust `X-Forwarded-For` |
| `WPMCP_ACCESS_TTL` / `WPMCP_REFRESH_TTL` / `WPMCP_REFRESH_GRACE` | 3600 / 15552000 / 600 | Seconds: access token, refresh token (sliding), retry grace |
| `WPMCP_ALLOW_PRIVATE_SITES`, `WPMCP_ALLOW_INSECURE_SITES` | off | **Development only**: allow sites on `localhost`/private IPs and plain http |

**Back up `data/`** (the database *and* `master.key`; without the key the stored site secrets cannot be decrypted and every site must be paired again).

### First run

Start the gateway. The log prints a **setup token**. Open `/admin`, enter it, choose an owner password (12+ characters). Anyone who cannot read the server log cannot claim an empty gateway.

CLI helpers (same data folder): `wp-mcp add-site <url> <code>`, `wp-mcp create-key --name n --level draft`, `wp-mcp sites`, `wp-mcp set-password` (reads `WPMCP_NEW_PASSWORD`), `wp-mcp stdio`.

## 2. The plugin (on each WordPress site)

Requirements: WordPress 6.2+, PHP 8.1+, the site reachable over HTTPS from the gateway.

1. Zip the folder `plugin/wp-mcp-bridge`:
   ```bash
   cd plugin && zip -r ../wp-mcp-bridge.zip wp-mcp-bridge
   ```
   (Windows PowerShell: `Compress-Archive -Path plugin\wp-mcp-bridge -DestinationPath wp-mcp-bridge.zip`)
2. *Plugins → Add New → Upload Plugin*, activate.
3. *Tools → WP MCP Bridge*: choose the highest level this connection may ever use on this site (default `admin`; pick `live` if you never want plugin/user/database actions) and press **Create pairing code**. The code is valid 15 minutes and works once.

The plugin creates two small tables (`wpm_activity`, `wpm_revisions`) and a daily cleanup job. Removing it through the Plugins screen deletes them (`uninstall.php`).

## 3. Connect the site

In the gateway admin panel → **Connect a site**: site URL, pairing code, a **unique name** (lowercase, e.g. `shop-fa`), and the highest level you allow on that site. The gateway performs the pairing over HTTPS, stores the secret encrypted, and runs a first signed call.

If it fails, see [connect.md#troubleshooting](connect.md#troubleshooting).

## Updating

Pull, `npm ci && npm run build`, restart. The database migrates itself (`CREATE TABLE IF NOT EXISTS`). The plugin version and the gateway version only need to agree on `spec/ops.json`: an operation the plugin does not know answers `unknown_op`.
