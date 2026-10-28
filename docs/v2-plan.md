# Version 2: implementation plan

Decisions fixed by the owner: all host kinds (cPanel, DirectAdmin, Plesk, shared, VPS, any server; detect and adapt) · any site type · simple for everyone, powerful for developers · local Studio + one-zip hosted Host Agent (PHP 8.1+) · MIT · the agent creates databases (hosting-panel API when it exists, own provisioning on a bare server, credentials prompt as the last fallback).

## Principles

1. **Detect, don't assume.** `host.info` reports PHP, extensions, limits, disabled functions, web server, hosting panel, symlink support, Node. Every feature picks a strategy from it and says why.
2. **One agent, no shell.** The agent never runs a command built from user input. Provisioning that needs a binary uses a fixed allow-list of argv arrays and only after an explicit approval in the panel.
3. **Outbound only.** Studio calls the agent; the agent never calls the Studio.
4. **Everything is a release.** Deploys are immutable folders, switched atomically (symlink) or synchronised by manifest (shared hosts that cannot symlink a docroot), always with a backup and a rollback.

## Host Agent layout (`agent/wpm-agent/`, zipped as `wpm-agent.zip`)

| File | Role |
|---|---|
| `index.php` | single entry; routes `?r=/…` (works without URL rewriting) |
| `src/Store.php` | JSON files with flock, each prefixed by a PHP guard line so the web server never serves them |
| `src/Auth.php` | scrypt/argon2id hashing, lockout, sessions, CSRF, TOTP |
| `src/Signature.php` | same HMAC scheme as the bridge + replay protection |
| `src/Fs.php`, `src/Zip.php` | confined paths, zip-slip safe reader with size/ratio limits |
| `src/Caps.php` | capability detection |
| `src/Sites.php`, `src/Releases.php` | site records, upload assembly, deploy, switch, rollback, backup |
| `src/Api.php`, `src/Panel.php` | signed JSON API; hosted setup + site panel (fa/en) |

First run: wizard (requirements → setup code → username/password → optional TOTP). The setup code is baked in by the Studio when it builds the zip (`Download agent` button), or generated into a guarded file when the generic zip is used.

## Studio additions (`gateway/`, `panel/`)

`hosts` (paired agents, secret encrypted) · `agentclient.ts` (signed calls, chunked upload, response verification) · `projects.ts` (project folders, starter templates, zip) · panel pages **Hosts** and **Projects** (create, edit, deploy, releases, rollback).

## Milestones

* **M1 Host Agent MVP** (DONE, see [agent.md](agent.md)): everything above, static and SPA deploys, tests (PHP unit, `php -S` end-to-end through the real Studio client).
* **M2 WordPress provisioning** (DONE except Plesk, SQLite, VPS installs; see agent.md): DB creation via cPanel UAPI / DirectAdmin / Plesk, else the agent's own MySQL/MariaDB/SQLite provisioning, else credentials prompt; download core, config, install, activate and auto-pair the bridge.
* **M3 Templates + local builds** (DONE) (Vite React/Vue/Svelte, Astro, Next/Nuxt static export).
* **M4 Node targets / SSR** (DONE for Passenger-style hosts and VPS via a user-run script; not tested on real hosts) (cPanel Node app, Passenger, VPS with systemd through an approved allow-listed path).
* **M5 AI builder pipeline** with human checkpoints (DONE, see [builder.md](builder.md); not tried with a real AI provider yet).
* **M6 Polish**: signed self-update, docs, packaging, test matrix.

## Threat notes for M1

Stolen Studio key → can only act inside its scope and sites, cannot read credentials, static sites refuse executable extensions. Replay → timestamp window + nonce store. Brute force → lockout per user and per IP. Zip bombs/slip → entry, size and ratio limits, names validated. Plain HTTP → refused except loopback unless the owner explicitly allows it at setup.
