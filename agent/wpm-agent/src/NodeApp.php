<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

/**
 * Node.js sites. The agent cannot (and does not try to) start processes. It makes the files land atomically, keeps the
 * environment variables in a private file, writes the Passenger configuration, and signals a restart by touching files:
 *  - tmp/restart.txt in the app folder (Phusion Passenger: cPanel / Plesk / DirectAdmin Node apps)
 *  - restart.txt in the site's data folder (the systemd path unit made by the generated VPS script)
 */
final class NodeApp
{
    /** Variables that change how code is loaded or executed; never settable through the API. */
    private const FORBIDDEN_ENV = '/^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|LD_[A-Z_]+|DYLD_[A-Z_]+|PATH|HOME|SHELL|IFS|BASH_ENV|ENV|PYTHONPATH|PHP_INI_SCAN_DIR|PHPRC)$/i';

    /** @param array<string,mixed> $env @return array<string,string> */
    public static function cleanEnv(array $env): array
    {
        if (count($env) > 100) {
            throw new ApiError('env_too_many', 'At most 100 environment variables.');
        }
        $out = [];
        foreach ($env as $k => $v) {
            $k = (string) $k;
            $v = is_scalar($v) ? (string) $v : '';
            if (!preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,63}$/', $k)) {
                throw new ApiError('env_bad_name', 'Invalid variable name: ' . substr($k, 0, 40));
            }
            if (preg_match(self::FORBIDDEN_ENV, $k)) {
                throw new ApiError('env_forbidden', $k . ' changes how programs are loaded and cannot be set here.');
            }
            if (strlen($v) > 4000 || preg_match('/[\x00\r\n]/', $v)) {
                throw new ApiError('env_bad_value', 'Invalid value for ' . $k . ' (no line breaks, up to 4000 characters).');
            }
            $out[$k] = $v;
        }
        ksort($out);

        return $out;
    }

    /** systemd EnvironmentFile syntax: KEY="value" with backslash and quote escaped. */
    public static function envFile(array $env): string
    {
        $lines = [];
        foreach ($env as $k => $v) {
            $lines[] = $k . '="' . strtr($v, ['\\' => '\\\\', '"' => '\\"', '$' => '\\$']) . '"';
        }

        return implode("\n", $lines) . ($lines ? "\n" : '');
    }

    /** The Phusion Passenger block written into the document root of the site (Apache / LiteSpeed). */
    public static function htaccess(array $site, array $env): string
    {
        $n = $site['node'];
        $lines = ["# Managed by the WPM Host Agent. Changes are overwritten on the next deploy.", 'PassengerEnabled on', 'PassengerAppType node', 'PassengerAppRoot "' . $site['target'] . '"', 'PassengerStartupFile "' . $n['startup'] . '"', 'PassengerAppEnv production'];
        foreach ($env as $k => $v) {
            $lines[] = 'SetEnv ' . $k . ' "' . strtr($v, ['\\' => '\\\\', '"' => '\\"']) . '"';
        }

        return implode("\n", $lines) . "\n";
    }

    /** Touches the restart markers. Failures are not fatal: the files are in place either way. */
    public static function restart(array $site, string $siteDir, ?string $appDir = null): void
    {
        @file_put_contents($siteDir . '/restart.txt', (string) Util::now());
        $app = $appDir ?? $site['target'];
        if (is_dir($app)) {
            @mkdir($app . '/tmp', 0755, true);
            @file_put_contents($app . '/tmp/restart.txt', (string) Util::now());
        }
    }

    /** A script for the person to read and run as root on their own server. The agent never runs it. */
    public static function vpsScript(array $site, string $domain, string $runUser, string $siteDir, bool $installDb): string
    {
        $domain = strtolower(trim($domain));
        if (!preg_match('/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/', $domain)) {
            throw new ApiError('bad_domain', 'Enter a domain name such as example.com.');
        }
        if (!preg_match('/^[a-z_][a-z0-9_-]{0,31}$/', $runUser)) {
            throw new ApiError('bad_user', 'The account the app should run as is not a valid system user name.');
        }
        $n = $site['node'];
        $id = $site['id'];
        $port = (int) $n['port'];
        foreach ([$site['target'], $siteDir, $n['startup']] as $path) {
            if (!preg_match('#^[A-Za-z0-9._/-]+$#', (string) $path)) {
                throw new ApiError('bad_path', 'A path contains characters that cannot be used safely in a generated script (allowed: letters, digits, . _ - /). Rename the folder.');
            }
        }
        $site['name'] = trim((string) preg_replace('/[^A-Za-z0-9 ._-]/', '', (string) $site['name']));
        $q = static fn (string $s): string => "'" . str_replace("'", "'\\''", $s) . "'";
        $unit = 'wpm-' . $id;
        $db = $installDb ? "\n# --- database (optional) ---\ninstall_pkg mariadb-server\nsystemctl enable --now mariadb || systemctl enable --now mysql || true\necho 'MariaDB installed. Run mysql_secure_installation, then create a database and user for the app.'\n" : '';

        return <<<SH
#!/usr/bin/env bash
# Server setup for the Node.js site "{$site['name']}" ({$id}), generated by the WPM Host Agent.
# READ IT FIRST, then run it as root:  sudo bash setup-{$id}.sh
# It installs Node.js and nginx from your distribution, makes a systemd service that runs the app as "{$runUser}"
# on 127.0.0.1:{$port}, an nginx reverse proxy for {$domain}, and a path unit that restarts the app when the agent
# deploys a new release. Nothing here is executed by the agent itself.
set -euo pipefail
[ "\$(id -u)" -eq 0 ] || { echo 'Run this script as root.' >&2; exit 1; }

install_pkg() {
  if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y "\$@";
  elif command -v dnf >/dev/null 2>&1; then dnf install -y "\$@";
  elif command -v yum >/dev/null 2>&1; then yum install -y "\$@";
  else echo 'No supported package manager (apt, dnf, yum). Install Node.js 20+ and nginx yourself.' >&2; exit 1; fi
}

command -v apt-get >/dev/null 2>&1 && apt-get update -y
command -v node >/dev/null 2>&1 || install_pkg nodejs
command -v nginx >/dev/null 2>&1 || install_pkg nginx
node -v | grep -qE '^v(2[0-9]|[3-9][0-9])' || echo 'WARNING: Node.js older than 20 detected; install a current LTS (nodejs.org) if the app needs it.'
{$db}
# --- the app as a service ---
cat > /etc/systemd/system/{$unit}.service <<'UNIT'
[Unit]
Description=Node.js site {$site['name']}
After=network.target

[Service]
User={$runUser}
WorkingDirectory={$site['target']}
Environment=NODE_ENV=production
Environment=PORT={$port}
Environment=HOSTNAME=127.0.0.1
EnvironmentFile=-{$siteDir}/env
ExecStart=/usr/bin/env node {$n['startup']}
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

# --- restart when the agent deploys ---
cat > /etc/systemd/system/{$unit}-restart.service <<'UNIT'
[Unit]
Description=Restart {$unit}

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl restart {$unit}.service
UNIT

cat > /etc/systemd/system/{$unit}-restart.path <<'UNIT'
[Unit]
Description=Watch deploys of {$unit}

[Path]
PathChanged={$siteDir}/restart.txt
Unit={$unit}-restart.service

[Install]
WantedBy=multi-user.target
UNIT

# --- nginx reverse proxy ---
cat > /etc/nginx/conf.d/{$unit}.conf <<'NGINX'
server {
    listen 80;
    server_name {$domain};
    client_max_body_size 25m;
    location / {
        proxy_pass http://127.0.0.1:{$port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX

systemctl daemon-reload
nginx -t
systemctl enable --now {$unit}.service {$unit}-restart.path
systemctl reload nginx
echo
echo 'Done. For HTTPS run:  apt install certbot python3-certbot-nginx && certbot --nginx -d {$domain}'
echo 'App folder: '{$q($site['target'])}
SH;
    }
}
