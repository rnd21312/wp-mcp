# Roadmap: WP MCP Studio (version 2)

Goal: **build any kind of website from zero, with AI or by hand, from one simple setup.** The user uploads one zip to ordinary web hosting, opens it in a browser, sets a username and password, and from then on creates and manages sites from a panel on their own computer.

This is a plan, not code. Everything below is open to change after the questions at the end are answered.

## What exists today (version 1)

* A gateway (Node) with an MCP server and a local panel, and a WordPress plugin ("bridge") with 123 actions. It manages **existing** WordPress sites: content, design, SEO, maintenance, plugins, shop, files, copy between sites, visual editor, URL inspector.
* Missing for the goal: creating the site (hosting setup, WordPress install, non-WordPress stacks), building and deploying code projects, and a generic host-side component that is not tied to WordPress.

## Shape of version 2

```
 Your computer                                  Your hosting (shared, VPS, anything with PHP)
┌───────────────────────────────┐   HTTPS      ┌────────────────────────────────────┐
│ Studio (local panel + MCP)    │  signed      │ Host Agent (one zip, PHP 8.1+)     │
│  workspace of projects (git)  │ ───────────► │  installer · login (+2FA) · API    │
│  AI builder, editors, preview │  uploads     │  releases/ + current  · rollback   │
│  local builds (npm, vite,…)   │ ◄─────────── │  site types: WordPress · static ·  │
└───────────────────────────────┘  status      │  Node app (when the host allows)   │
                                               └────────────────────────────────────┘
```

* **Host Agent**: a small PHP application, because PHP is the one thing every shared host has. First run is a wizard (requirements check, admin username and password, optional TOTP). It exposes the same style of signed API as the bridge, but for *projects* instead of WordPress internals.
* **Studio** (the current panel, extended): runs on the user's computer, where Node, npm and AI keys can live. It keeps each project as a local folder under git, previews it, builds it, and **pushes** the result to the Host Agent. All connections are outbound from the computer, so no router or firewall changes are needed.
* **Releases**: every deploy is an immutable release folder plus an atomic switch, with automatic backup and one-click rollback.

## Site types and how each is delivered

| Type | Built where | Delivered as | Notes |
|---|---|---|---|
| WordPress | Host Agent provisions it (download core, config, install, activate the bridge, pair automatically) | live install | needs a database; the agent asks for credentials or uses the host's API when one exists (cPanel UAPI) |
| Static (HTML/CSS/JS, Astro, Eleventy) | locally | files | works on any host |
| React / Vue / Svelte (Vite) | locally (`npm run build`) | static files + SPA rewrite rules | works on any host |
| Next.js / Nuxt | locally | **static export** by default; SSR only if the host runs Node (cPanel Node app, Passenger) or a VPS | the agent reports what the host supports and the Studio picks the target |
| PHP apps, Laravel | locally | files + composer on host when allowed | later |

## The AI builder

New MCP tools and panel flows on top of the current ones:

1. `project.create {type, brief}`, `project.list`, `project.open`.
2. `workspace.*`: read, write, list, search, run commands inside the project folder only.
3. `build.run`, `preview.start/stop` (local dev server shown in the panel's visual editor).
4. `deploy.push {host, project}`, `deploy.releases`, `deploy.rollback`, `host.status`.
5. A guided pipeline with **checkpoints the human approves**: brief → sitemap and pages → design system (tokens, components) → page build → content and images → SEO → performance and accessibility audit → deploy. At each step the AI proposes, the user approves or edits in the panel, then it continues.
6. The existing visual editor and URL inspector work on any project type, not only WordPress.

## Security model for the Host Agent

* Username and password (scrypt), optional TOTP, brute-force lockout, setup token on first run, HTTPS required.
* Signed requests with per-connection secrets (same HMAC scheme as the bridge), replay protection, scopes per project.
* File operations confined to the project folder; uploads are zip + hash, verified, unpacked into a new release; no arbitrary command execution on the host; PHP files in a release only from the user's own pushed artifact.
* Audit log, backup before each deploy, rollback.
* Signed self-updates of the agent.

## Milestones

| | Deliverable | Result |
|---|---|---|
| M1 | Host Agent MVP (installer, auth, upload, releases, rollback) + Studio projects and static deploy | a static site goes live from the panel |
| M2 | WordPress provisioning and automatic pairing | a new WordPress site from nothing in minutes |
| M3 | Project templates and local builds: React, Vue, Astro, Next static export | any front-end stack deploys |
| M4 | Node targets (cPanel Node, Passenger, VPS over SSH) and Next SSR | server-rendered apps |
| M5 | The AI site-builder pipeline with checkpoints, design systems, component library, image generation hooks | "describe the business, get the site" |
| M6 | Teams and optional hosted Studio, template marketplace | beyond a single user |

## Main risks

* Shared hosting varies a lot (disabled functions, old PHP, permissions, cPanel vs DirectAdmin). Needs a test matrix with real hosts early.
* "Any stack" is wide; each template is real maintenance work. Start with four and make adding one cheap.
* An agent that accepts deployments is a high-value target; the security model above must be built first, not later.
* Next.js/Nuxt server rendering is not possible on plain shared hosting; users must be told clearly.

## Questions that decide the plan

1. Which hosts do your users have: cPanel, DirectAdmin, Plesk, Iranian hosting providers, VPS? Is Node available on them?
2. Is Next.js SSR a must, or is static export enough for the first version?
3. Who uses it: agencies building for clients, or end users building their own site?
4. Should the Studio stay a local app, or also be offered as a hosted service later?
5. Open source, paid, or both? This affects the template marketplace and updates.
