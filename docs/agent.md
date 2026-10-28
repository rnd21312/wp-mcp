# Host Agent (version 2)

The Host Agent is one small PHP application you put on your hosting. It lets the Studio (on your computer) create sites and publish them, safely, from zero. It needs only **PHP 8.1+** and HTTPS. No Node, no shell, no database for the agent itself.

## Set up in five steps

1. In the Studio open **Hosts → Download agent**. The zip contains a one-time **setup code** (shown in the Studio).
2. Upload the zip to your hosting (File Manager → Upload → Extract), next to your site files, for example in `public_html`. You get a `wpm-agent` folder.
3. Open `https://your-domain/wpm-agent/`. The wizard checks the host, asks for the setup code, a username and a password (10+ characters). Turn on two-factor authentication on the **Security** page.
4. In the agent press **Make a pairing code** (valid 10 minutes).
5. In the Studio: **Hosts → Connect a host**, paste the address and the code. The Studio now holds a signing secret; nothing else is stored.

Using the generic `dist/wpm-agent.zip` (`npm run package:agent`) works too: the wizard then shows the path of a file that holds the setup code, which you open in your file manager.

## Publish a site

**Projects → New project** makes a folder on your computer (static or single-page app). Edit files in the Studio (or in any editor, they are plain files), then **Publish now**. The first publish creates the site on the host; later ones add a release. **Hosts → Sites & releases** lists releases and rolls back in one click. The agent panel offers the same thing: upload a zip in the browser, see releases, roll back.

Single-page apps (React, Vue, Svelte built with Vite, and so on): publish the build folder (`dist/` is used automatically when it contains `index.html`); the agent adds the rewrite rules for Apache/LiteSpeed. On nginx add `try_files $uri /index.html;` for that location.

## How a deploy works

```
zip (Studio) → chunks sized to the host's post_max_size → sha256 check on the host
→ unpack into releases/<id> (validated) → switch → keep the last 5 releases
```

* **Symlink mode** (VPS, hosts that allow symlinks, new or empty folder): the live folder is a symlink to the release; the switch is one atomic rename.
* **Sync mode** (every shared host, or when the folder already has files): files of the new release are written beside their final names and renamed in place, HTML last; files only the old release had are removed. **Files the agent did not put there are never deleted**, and any it must overwrite are first copied to `backups/<release>/`.
* Rollback runs the same switch towards an older release. Releases are immutable.

## Security model

| Concern | Measure |
|---|---|
| Who can set it up | Setup code that only the person with the zip/file access knows; wrong codes are rate limited; the code file is deleted after setup |
| Passwords | argon2id (bcrypt where unavailable) over a SHA-256 pre-hash; 10+ characters, common ones refused |
| Brute force | 5 failures lock the user and the address for 15 minutes, doubling up to 24 h; the lock applies even to the right password |
| 2FA | TOTP (RFC 6238, tested with the RFC vectors); a code can be used once |
| Sessions | random id stored hashed, HttpOnly, SameSite=Strict, Secure on HTTPS, 2 h idle / 12 h absolute, CSRF token and Origin check on every POST |
| Transport | Login, setup and API require HTTPS; HTTP is allowed only from loopback, or when the owner ticks an explicit risk box at setup |
| Studio requests | HMAC-SHA256 over time, nonce, key, method, route and body hash (same layout as the WordPress bridge); 5-minute window; each nonce usable once (atomic file creation); replies are signed so the Studio detects an impostor; repeated bad signatures lock the address |
| Scopes | Connections are `read`, `deploy` or `admin`; creating or deleting sites needs `admin`; a pairing code is single use and expires in 10 minutes; connections can be revoked |
| Files | Every path from outside is validated (no `..`, absolute, drive, backslash, control characters, symlink escape); sites live only in allowed roots and never inside the agent or its data folder |
| Archives | Zip-slip, zip bombs (size, ratio and entry limits while inflating), CRC, links and special files refused; static and SPA sites reject executable and server-config files (`.php`, `.phtml`, `.htaccess`, `web.config`, `.env`, `.git`) |
| Commands | The agent never builds a shell command from input. The only command it can run is a fixed `node -v` to report capabilities |
| Data at rest | JSON files with a PHP guard line, in a folder outside the web root when the host allows it, with deny rules otherwise; files are mode 0600 |
| Audit | Append-only log of logins, failures, pairings, site changes, deploys and rollbacks (visible on the Security page and to `admin` connections) |

Honest limits: the signing secret must be stored on the host to verify requests, so someone who can read the agent's data folder can impersonate the Studio (revoke and re-pair). An `admin` connection that creates a site of a server-side type in later milestones can run code on the host by design; static and SPA sites cannot. The agent cannot protect a host that is already compromised.

## What it detects about the host

`Hosts` shows PHP version and extensions, upload and memory limits and the chunk size derived from them, web server (Apache/LiteSpeed/nginx/…), hosting panel (cPanel, DirectAdmin, Plesk, CyberPanel, CloudPanel, Hestia), symlink support, free disk, whether the data folder is outside the web root, and whether Node is present. Later milestones use this to choose how to create databases and run server-side apps.

## New WordPress site (M2)

**Hosts → New WordPress site.** The Studio creates the site slot, then the agent: (1) makes the database, (2) downloads the official `latest.zip` and verifies it against wordpress.org's published SHA-1, (3) unpacks it, writes `wp-config.php` with fresh salts and a random table prefix, (4) copies the bridge plugin. The Studio then runs WordPress's own web installer over HTTP, the agent activates the bridge and issues it a pairing code, and the Studio pairs automatically. You get the admin address, username and a generated password once; the Studio never stores that password.

Database, in order of preference (you pick in the dialog):

| Method | How |
|---|---|
| cPanel | UAPI `Mysql/create_database`, `create_user`, `set_privileges_on_database` with a cPanel API token (Security → Manage API Tokens), port 2083 |
| DirectAdmin | `CMD_API_DATABASES` with a Login Key, port 2222 |
| MySQL admin (VPS) | the agent connects with root/admin credentials and creates database, user and grants itself (generated identifiers, bound password) |
| Details given | you type name, user, password; connection is tested before anything is written |

Panel tokens and database passwords travel once over the signed channel and are not stored. New database passwords are generated on the host and only written to `wp-config.php` (mode 0640). If the database step fails, nothing is downloaded or written; a bad checksum installs nothing.

Not done yet: Plesk API, SQLite for WordPress, installing MySQL on a bare VPS (an approved, allow-listed path is planned for M4), and `localhost`-less setups where the web installer cannot be reached from your computer (you are told to open `wp-admin/install.php` yourself; files and database are ready).

## Frameworks and local builds (M3)

**Projects → New project** offers templates for React, Vue and Svelte (Vite), Astro and Next.js (static export), next to plain HTML. Nothing is installed at creation. **Build now** runs `npm install` and `npm run build` in the project folder on your computer (Node.js required; the Studio finds npm next to its own Node, no shell involved), shows the live log, and checks that the output has an `index.html`. **Publish** then sends only the output folder (`dist/` or `out/`) as a release. All five templates were built for real with npm while developing.

Notes: Vite templates use relative asset paths, so they work in a sub-folder. Astro needs `base` and Next needs `basePath` for a sub-folder. Next.js is static export only; server rendering arrives with Node targets in M4. The only commands the Studio ever runs are those two npm calls, started by a click; the project's own scripts and dependencies do execute during a build, so build only projects you trust.

## Status

Milestone M1 (this document): installer, auth, signed API, chunked upload, releases, atomic switch, rollback, static and SPA deploy. Symlink mode is covered by unit tests only on hosts that allow symlinks (not on the Windows development machine); sync mode is covered end to end. Next: WordPress provisioning (database creation through cPanel/DirectAdmin/Plesk APIs or the agent itself), see [v2-plan.md](v2-plan.md).
