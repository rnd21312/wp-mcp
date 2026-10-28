<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

/**
 * WordPress provisioning: official core download (checksum verified), database, wp-config.php with fresh salts, the bridge
 * plugin, and — after the Studio has run the web installer — activation of the bridge and a pairing code for it.
 */
final class Wp
{
    public const CORE_URL = 'https://wordpress.org/latest.zip';
    public const CORE_SHA1 = 'https://wordpress.org/latest.zip.sha1';
    public const BRIDGE = 'wp-mcp-bridge/wp-mcp-bridge.php';

    public function __construct(private Agent $agent, private Sites $sites)
    {
    }

    /**
     * @param array<string,mixed> $site a site record of kind wordpress
     * @param array<string,mixed> $dbSpec see Db::provision
     * @return array<string,mixed>
     */
    public function install(array $site, array $dbSpec, ?string $bridgeZip, string $actor): array
    {
        if ($site['kind'] !== 'wordpress') {
            throw new ApiError('not_wordpress', 'This site is not a WordPress site.');
        }
        $target = $site['target'];
        if (is_file($target . '/wp-config.php') || is_file($target . '/wp-includes/version.php')) {
            throw new ApiError('already_installed', 'WordPress files already exist in that folder.', 409);
        }
        if (is_dir($target) && !Fs::isEmptyDir($target) && Fs::norm($target) !== Fs::norm($site['root'])) {
            throw new ApiError('target_not_empty', 'The folder is not empty. Choose an empty folder for a new WordPress site.', 409);
        }
        if (Fs::norm($target) === Fs::norm($site['root']) && count(array_diff(scandir($target) ?: [], ['.', '..', basename($this->agent->agentDir), 'wpm-agent', 'cgi-bin', '.well-known', 'index.html', 'default.html', '.htaccess', '.ftpquota'])) > 0) {
            throw new ApiError('target_not_empty', 'The web root already holds other files. Install WordPress in a sub-folder, or empty the web root first.', 409);
        }

        // 1. database first: if it cannot be made, no file is written.
        $db = Db::provision($dbSpec);
        $this->agent->audit($actor, 'db.provision', ($dbSpec['method'] ?? 'manual') . ' -> ' . $db['name']);

        // 2. core
        $work = $this->agent->dataDir . '/work-' . Util::random(4);
        Fs::mkdir($work, 0700);
        $created = [];
        try {
            $zip = $work . '/core.zip';
            $this->fetchCore($zip);
            Fs::mkdir($target);
            $info = Zip::extract($zip, $target, 400 * 1048576);
            $created[] = $target;
            $prefix = 'wp' . bin2hex(random_bytes(2)) . '_';
            file_put_contents($target . '/wp-config.php', self::configText($db, $prefix));
            @chmod($target . '/wp-config.php', 0640);
            if ($bridgeZip !== null) {
                $dest = $target . '/wp-content/plugins/wp-mcp-bridge';
                Fs::mkdir($dest);
                Zip::extract($bridgeZip, $dest, 20 * 1048576);
            }
        } catch (\Throwable $e) {
            $this->clear($target, (string) $site['root']);
            throw $e;
        } finally {
            Fs::rrmdir($work);
        }
        $version = preg_match("/\\\$wp_version\s*=\s*'([^']+)'/", (string) @file_get_contents($target . '/wp-includes/version.php'), $m) ? $m[1] : '';
        $this->agent->store->update('sites', static function (array $all) use ($site, $prefix) {
            if (isset($all[$site['id']])) {
                $all[$site['id']]['wp'] = ['prefix' => $prefix, 'installed' => false, 'created' => Util::now()];
            }
            return $all;
        });
        $this->agent->audit($actor, 'wp.install', $site['id'] . ' WordPress ' . $version . ($bridgeZip ? ' + bridge' : ''));

        return ['wp_version' => $version, 'files' => $info['files'], 'db' => ['host' => $db['host'], 'name' => $db['name'], 'user' => $db['user']], 'bridge' => $bridgeZip !== null, 'next' => 'Run the WordPress installer (admin user, password, title), then call wp.finish.'];
    }

    private function clear(string $target, string $root): void
    {
        if (Fs::norm($target) === Fs::norm($root)) {
            return; // never wipe a web root; the person can clean it by hand
        }
        Fs::rrmdir($target);
    }

    public function fetchCore(string $to): void
    {
        $sums = Net::request('GET', self::CORE_SHA1);
        $want = strtolower(trim(explode(' ', $sums[1])[0]));
        if ($sums[0] !== 200 || !preg_match('/^[a-f0-9]{40}$/', $want)) {
            throw new ApiError('core_checksum', 'Could not read the official checksum of the WordPress download.', 502);
        }
        Net::download(self::CORE_URL, $to);
        if (!hash_equals($want, sha1_file($to) ?: '')) {
            @unlink($to);
            throw new ApiError('core_corrupt', 'The WordPress download does not match its official checksum. Nothing was installed.', 502);
        }
    }

    /** @param array{host:string,name:string,user:string,pass:string} $db */
    public static function configText(array $db, string $prefix): string
    {
        $host = $db['host'];
        $salts = '';
        foreach (['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'] as $k) {
            $salts .= "define('" . $k . "', " . var_export(bin2hex(random_bytes(32)), true) . ");\n";
        }

        return "<?php\n// Written by the WPM Host Agent.\n"
            . "define('DB_NAME', " . var_export($db['name'], true) . ");\ndefine('DB_USER', " . var_export($db['user'], true) . ");\ndefine('DB_PASSWORD', " . var_export($db['pass'], true) . ");\ndefine('DB_HOST', " . var_export($host, true) . ");\n"
            . "define('DB_CHARSET', 'utf8mb4');\ndefine('DB_COLLATE', '');\n" . $salts
            . '$table_prefix = ' . var_export($prefix, true) . ";\ndefine('WP_DEBUG', false);\nif (!defined('ABSPATH')) {\n\tdefine('ABSPATH', __DIR__ . '/');\n}\nrequire_once ABSPATH . 'wp-settings.php';\n";
    }

    /** @return array{host:string,port:int,name:string,user:string,pass:string,prefix:string} */
    public static function parseConfig(string $php): array
    {
        $get = static function (string $k) use ($php): string {
            if (!preg_match("/define\(\s*'" . $k . "'\s*,\s*'((?:[^'\\\\]|\\\\.)*)'\s*\)/", $php, $m)) {
                throw new ApiError('bad_config', 'wp-config.php was not written by the agent (missing ' . $k . ').', 409);
            }
            return strtr($m[1], ['\\\\' => '\\', "\\'" => "'"]);
        };
        if (!preg_match('/\$table_prefix\s*=\s*\'([A-Za-z0-9_]+)\'/', $php, $p)) {
            throw new ApiError('bad_config', 'wp-config.php has no table prefix.', 409);
        }
        $host = $get('DB_HOST');
        $port = 3306;
        if (preg_match('/^(.*):(\d+)$/', $host, $hp)) {
            [$host, $port] = [$hp[1], (int) $hp[2]];
        }

        return ['host' => $host, 'port' => $port, 'name' => $get('DB_NAME'), 'user' => $get('DB_USER'), 'pass' => $get('DB_PASSWORD'), 'prefix' => $p[1]];
    }

    // ---- after the web installer ----------------------------------------------------------------------------------

    /** @return array<string,mixed> */
    public function finish(array $site, string $adminUser, string $ceiling, string $actor, ?\PDO $pdo = null, ?string $prefix = null): array
    {
        if ($pdo === null) {
            $cfgFile = $site['target'] . '/wp-config.php';
            $cfg = self::parseConfig((string) @file_get_contents($cfgFile));
            $pdo = Db::pdo($cfg);
            $prefix = $cfg['prefix'];
        }
        if (!Db::ident((string) $prefix)) {
            throw new ApiError('bad_config', 'Unexpected table prefix.', 409);
        }
        $st = $pdo->prepare('SELECT ID FROM ' . $prefix . 'users WHERE user_login = ?');
        try {
            $st->execute([$adminUser]);
        } catch (\PDOException) {
            throw new ApiError('not_installed', 'WordPress is not installed yet. Run its web installer first.', 409);
        }
        $uid = $st->fetchColumn();
        if ($uid === false) {
            throw new ApiError('no_admin', 'That administrator does not exist yet. Run the WordPress installer first.', 409);
        }
        $active = self::option($pdo, $prefix, 'active_plugins');
        $list = is_string($active) ? @unserialize($active, ['allowed_classes' => false]) : [];
        $list = is_array($list) ? $list : [];
        if (!in_array(self::BRIDGE, $list, true)) {
            if (!is_file($site['target'] . '/wp-content/plugins/' . self::BRIDGE)) {
                throw new ApiError('no_bridge', 'The bridge plugin was not installed with this site.', 409);
            }
            $list[] = self::BRIDGE;
            self::setOption($pdo, $prefix, 'active_plugins', serialize(array_values($list)));
        }
        $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        $raw = '';
        for ($i = 0; $i < 16; $i++) {
            $raw .= $alphabet[random_int(0, 31)];
        }
        if (!in_array($ceiling, ['read', 'draft', 'live', 'admin'], true)) {
            $ceiling = 'admin';
        }
        self::setOption($pdo, $prefix, 'wpm_bridge_pairing', serialize(['hash' => hash('sha256', 'WPMP' . $raw), 'user' => (int) $uid, 'ceiling' => $ceiling, 'expires' => Util::now() + 900, 'attempts' => 0]));
        $this->agent->store->update('sites', static function (array $all) use ($site) {
            if (isset($all[$site['id']])) {
                $all[$site['id']]['wp']['installed'] = true;
            }
            return $all;
        });
        $this->agent->audit($actor, 'wp.finish', $site['id'] . ': bridge active, pairing code issued');

        return ['pairing_code' => 'WPMP-' . implode('-', str_split($raw, 4)), 'expires' => Util::now() + 900, 'bridge_active' => true];
    }

    public static function option(\PDO $pdo, string $prefix, string $name): ?string
    {
        $st = $pdo->prepare('SELECT option_value FROM ' . $prefix . 'options WHERE option_name = ?');
        $st->execute([$name]);
        $v = $st->fetchColumn();

        return $v === false ? null : (string) $v;
    }

    public static function setOption(\PDO $pdo, string $prefix, string $name, string $value): void
    {
        $up = $pdo->prepare('UPDATE ' . $prefix . 'options SET option_value = ? WHERE option_name = ?');
        $up->execute([$value, $name]);
        if ($up->rowCount() === 0 && self::option($pdo, $prefix, $name) === null) {
            $pdo->prepare('INSERT INTO ' . $prefix . "options (option_name, option_value, autoload) VALUES (?, ?, 'no')")->execute([$name, $value]);
        }
    }
}
