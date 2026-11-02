# Releases, signed updates and the test matrix (M6)

## Signed agent updates

Agents update themselves only from a zip signed with **your** release key. The Studio never needs the private key; it ships the signed zip and sends exactly those bytes.

```
npm run release:keygen -- <folder outside the repo>   # once: private key there, public key into agent/.../UpdateKey.php
WPM_RELEASE_KEY=<folder>/wpm-release-private.pem npm run release
```

`npm run release` builds `dist/wpm-agent.zip`, signs it (`dist/wpm-agent.zip.sig`, Ed25519 over `"wpm-agent-update\n" + sha256`), writes `dist/wpm-agent.version`, `dist/wp-mcp-bridge.zip` and `dist/SHA256SUMS`, and copies the signed agent next to the Studio build (`gateway/dist/agent-release/`). Publish the files in `dist/` as the GitHub release.

On the Hosts page an agent older than the Studio's release shows **Update agent**. The agent then: verifies the signature with the public key built into it, refuses anything not newer (so an old signed release cannot be replayed), accepts only its own files (`index.php`, `.htaccess`, `src/*.php`), keeps the old version in `backups/`, swaps file by file (`index.php` last), and puts the old version back if anything fails. `data-location.php`, the setup code and your data are never touched.

* An agent built **without** a public key (the default in this repository) refuses updates and says so; update it by uploading the new zip by hand.
* Hosts without the `sodium` PHP extension cannot verify signatures and refuse updates (the host check tells you).
* **Whoever holds the private key can run code on every agent that trusts it.** Keep it offline, back it up, never commit it. To rotate, ship a signed release that contains the new public key.

## Bridge updates (plugin 2.3+)

Installed bridges update through WordPress's own update system, from a signed release.

```
WPM_RELEASE_KEY=<folder>/wpm-release-private.pem npm run release
gh release create v<version> dist/wp-mcp-bridge.zip dist/bridge-latest.json dist/wpm-agent.zip dist/wpm-agent.zip.sig dist/SHA256SUMS
```

`dist/bridge-latest.json` is `{version, package, sha256, signature}`; the signature is Ed25519 over `"wpm-bridge-update
<version>
<sha256>"` (so an old signed release cannot be replayed under a newer version number). Each bridge polls `releases/latest/download/bridge-latest.json` (cached six hours), and the site then shows "update available" in **Plugins**. Nothing installs by itself.

* A person updates from **Plugins**, or the panel's **Sites → Update** button, or an AI with `maintain.update {type: plugin, slug: wp-mcp-bridge/wp-mcp-bridge.php}` (admin level, two-step confirmation).
* Before WordPress touches any file the bridge downloads the zip itself and checks the SHA-256, the signature against the public key in `includes/UpdateKey.php`, that the version is newer, and that the zip only contains `wp-mcp-bridge/…`. Any failure stops the update with a reason and changes nothing.
* The bridge loads all of its own classes first, so the file swap cannot mix two versions in one request. WordPress keeps the active state and rolls back a failed copy.
* The same key as for agent updates is used (`npm run release:keygen -- <folder outside the repo>` writes the public key into both places). **Whoever holds the private key can run code on every site that trusts it.** Keep it offline and backed up.
* Bridges older than 2.3 have no updater: install the 2.3 zip once by hand (**Plugins → Add New → Upload → Replace current**); updates are one click after that.
* For a fork or a private mirror define `WPMCP_UPDATE_URL` in `wp-config.php` (https; http only when `WP_ENVIRONMENT_TYPE` is `local`).

## Check this host

**Hosts → Check this host** runs the agent's self-test (writable data folder, atomic rename, locks, symlinks, zip unpacking, limits, sodium, database drivers, Node, outbound HTTPS to wordpress.org, each site's folder) and probes from outside whether the web can read `src/*.php`, `data-location.php`, `.htaccess` and the data folder. Each line is ok / warning / fail with a plain sentence. Run it on every new host and after changing PHP version.

## MCP: the `studio` tool

AI clients connected over MCP get one extra tool, **studio**, for plain static projects: list hosts and projects, create a project from the blank/landing template, read/write/delete project files, list releases, and (level *live*, two-step confirmation) publish and roll back. By design it cannot run builds (a build runs project scripts on your computer), touch Node or framework projects, create WordPress sites, see credentials, set environment variables, or administer a host. It is offered only to connections that are not limited to specific WordPress sites.

## Test matrix

What was verified here, and what needs a real host. Please record results per host when you try it (a short list is enough).

| Area | Automated here | Needs a real host |
|---|---|---|
| Setup wizard, login, lockout, 2FA, CSRF | PHP unit + `php -S` end to end | HTTPS behind real proxies (`X-Forwarded-Proto`), LiteSpeed/nginx |
| Signed API, replay, scopes | unit + end to end | clock skew between the host and your computer |
| Chunked upload, deploy, rollback (sync mode) | end to end, 10 MB multi-chunk | very small `post_max_size`, slow links, `open_basedir` |
| Symlink mode | unit tests exist; skipped on this Windows machine | any Linux host: run `php agent/tests/run.php` there |
| SPA rewrite rules | generated `.htaccess` checked as text | Apache/LiteSpeed (AllowOverride FileInfo), nginx `try_files` |
| WordPress install | mocked download, config, bridge activation, pairing | real wordpress.org download, real cPanel/DirectAdmin API, real MySQL |
| Node apps | files, env, Passenger config, restart markers, script (`bash -n`) | Passenger on cPanel/Plesk/DirectAdmin, systemd on a VPS, Next standalone under Passenger |
| Signed update | end to end with a live agent (needs `sodium`) | a shared host's PHP build |
| Frameworks | all five templates built with npm | publishing their output to a host |
| AI builder | scripted model | each AI provider (quality, JSON reliability) |

Suggested first run on a new host: upload the zip, set up, **Check this host**, publish the landing template, roll back, create a WordPress site, publish a React project.
