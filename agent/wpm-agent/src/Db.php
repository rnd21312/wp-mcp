<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

/**
 * Database provisioning. Order of preference, chosen by the Studio from what the host offers:
 *  1. hosting-panel API (cPanel UAPI, DirectAdmin): creates database + user and grants access
 *  2. MySQL/MariaDB administrator credentials (VPS, bare server): the agent creates them itself
 *  3. ready-made credentials from the person (always possible)
 * Passwords for new users are generated here and only ever written to wp-config.php.
 */
final class Db
{
    /** Test seam: replaces provisioning. */
    public static $override = null;

    public static function ident(string $s): bool
    {
        return (bool) preg_match('/^[A-Za-z0-9_]{1,64}$/', $s);
    }

    public static function randomPassword(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(24)), '+/', 'Aa'), '=');
    }

    /** @param array<string,mixed> $c host, port, user, pass, name, driver (mysql|sqlite) */
    public static function pdo(array $c): \PDO
    {
        $driver = (string) ($c['driver'] ?? 'mysql');
        try {
            if ($driver === 'sqlite') {
                return new \PDO('sqlite:' . $c['path'], null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
            }
            if (!extension_loaded('pdo_mysql')) {
                throw new ApiError('no_pdo_mysql', 'This PHP has no pdo_mysql extension. Enable it in the hosting panel (PHP extensions).');
            }
            $host = (string) ($c['host'] ?? 'localhost');
            $port = (int) ($c['port'] ?? 3306);
            $dsn = 'mysql:host=' . $host . ';port=' . $port . (isset($c['name']) && $c['name'] !== '' ? ';dbname=' . $c['name'] : '') . ';charset=utf8mb4';

            return new \PDO($dsn, (string) $c['user'], (string) $c['pass'], [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION, \PDO::ATTR_TIMEOUT => 10]);
        } catch (\PDOException $e) {
            throw new ApiError('db_connect', 'Cannot connect to the database: ' . preg_replace('/SQLSTATE\[[^\]]*\]\s*/', '', $e->getMessage()), 422);
        }
    }

    /** @return array{host:string,name:string,user:string,pass:string} */
    public static function provision(array $spec): array
    {
        if (self::$override !== null) {
            return (self::$override)($spec);
        }
        $method = (string) ($spec['method'] ?? 'manual');

        return match ($method) {
            'manual' => self::manual($spec),
            'mysql_root' => self::viaRoot($spec),
            'cpanel' => self::viaCpanel($spec),
            'directadmin' => self::viaDirectAdmin($spec),
            default => throw new ApiError('db_method', 'Unknown database method "' . $method . '". Use manual, mysql_root, cpanel or directadmin.'),
        };
    }

    private static function manual(array $s): array
    {
        $c = ['host' => (string) ($s['host'] ?? 'localhost'), 'name' => (string) ($s['name'] ?? ''), 'user' => (string) ($s['user'] ?? ''), 'pass' => (string) ($s['pass'] ?? '')];
        if ($c['name'] === '' || $c['user'] === '') {
            throw new ApiError('db_missing', 'Database name and user are required.');
        }
        self::pdo($c); // fail early, before any file is written

        return $c;
    }

    private static function viaRoot(array $s): array
    {
        $host = (string) ($s['host'] ?? 'localhost');
        $admin = self::pdo(['host' => $host, 'user' => (string) ($s['root_user'] ?? 'root'), 'pass' => (string) ($s['root_pass'] ?? '')]);
        $suffix = bin2hex(random_bytes(3));
        $name = 'wp_' . $suffix;
        $user = 'wp_' . $suffix;
        $pass = self::randomPassword();
        $from = in_array($host, ['localhost', '127.0.0.1', '::1'], true) ? 'localhost' : '%';
        // Identifiers are generated here (hex), the password is bound as a literal through quote(): nothing user-controlled reaches the SQL.
        $admin->exec('CREATE DATABASE `' . $name . '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        $admin->exec('CREATE USER ' . $admin->quote($user) . '@' . $admin->quote($from) . ' IDENTIFIED BY ' . $admin->quote($pass));
        $admin->exec('GRANT ALL PRIVILEGES ON `' . $name . '`.* TO ' . $admin->quote($user) . '@' . $admin->quote($from));
        $admin->exec('FLUSH PRIVILEGES');

        return ['host' => $host, 'name' => $name, 'user' => $user, 'pass' => $pass];
    }

    private static function panelBase(array $s, array $ports): string
    {
        $url = (string) ($s['url'] ?? '');
        $p = parse_url($url);
        if (!$p || ($p['scheme'] ?? '') !== 'https' || empty($p['host']) || !in_array((int) ($p['port'] ?? 443), $ports, true)) {
            throw new ApiError('panel_url', 'The panel address must be https://host:' . $ports[0] . ' (the port of your hosting panel).');
        }

        return 'https://' . $p['host'] . ':' . ($p['port'] ?? 443);
    }

    private static function viaCpanel(array $s): array
    {
        $base = self::panelBase($s, [2083]);
        $cp = (string) ($s['user'] ?? '');
        if (!preg_match('/^[a-z0-9]{1,16}$/i', $cp) || ($s['token'] ?? '') === '') {
            throw new ApiError('cpanel_creds', 'Give the cPanel username and an API token (cPanel → Security → Manage API Tokens).');
        }
        $suffix = bin2hex(random_bytes(2));
        $name = $cp . '_wp' . $suffix;
        $user = substr($cp . '_u' . $suffix, 0, 16);
        $pass = self::randomPassword();
        $headers = ['Authorization' => 'cpanel ' . $cp . ':' . $s['token']];
        $verify = ($s['verify_tls'] ?? true) !== false;
        $call = static function (string $fn, array $q) use ($base, $headers, $verify): void {
            [$status, $body] = Net::request('GET', $base . '/execute/Mysql/' . $fn . '?' . http_build_query($q), $headers, '', $verify);
            $j = json_decode($body, true);
            if ($status !== 200 || !is_array($j) || ($j['status'] ?? 0) != 1) {
                $msg = is_array($j) ? implode(' ', array_map('strval', (array) ($j['errors'] ?? []))) : 'HTTP ' . $status;
                throw new ApiError('cpanel_failed', 'cPanel refused "' . $fn . '": ' . ($msg ?: 'unknown error'), 502);
            }
        };
        $call('create_database', ['name' => $name]);
        $call('create_user', ['name' => $user, 'password' => $pass]);
        $call('set_privileges_on_database', ['user' => $user, 'database' => $name, 'privileges' => 'ALL PRIVILEGES']);

        return ['host' => 'localhost', 'name' => $name, 'user' => $user, 'pass' => $pass];
    }

    private static function viaDirectAdmin(array $s): array
    {
        $base = self::panelBase($s, [2222]);
        $da = (string) ($s['user'] ?? '');
        if (!preg_match('/^[a-z0-9_]{1,16}$/i', $da) || ($s['key'] ?? '') === '') {
            throw new ApiError('da_creds', 'Give the DirectAdmin username and a Login Key (Account Manager → Login Keys).');
        }
        $suffix = bin2hex(random_bytes(2));
        $short = 'wp' . $suffix;
        $pass = self::randomPassword();
        $body = http_build_query(['action' => 'create', 'name' => $short, 'user' => $short, 'passwd' => $pass, 'passwd2' => $pass, 'json' => 'yes']);
        [$status, $out] = Net::request('POST', $base . '/CMD_API_DATABASES', ['Authorization' => 'Basic ' . base64_encode($da . ':' . $s['key']), 'Content-Type' => 'application/x-www-form-urlencoded'], $body, ($s['verify_tls'] ?? true) !== false);
        parse_str($out, $r);
        $j = json_decode($out, true);
        $error = is_array($j) ? (string) ($j['error'] ?? '0') : (string) ($r['error'] ?? '0');
        if ($status !== 200 || $error !== '0') {
            $msg = is_array($j) ? (string) ($j['text'] ?? $j['details'] ?? '') : (string) ($r['text'] ?? $r['details'] ?? '');
            throw new ApiError('da_failed', 'DirectAdmin refused to create the database: ' . ($msg ?: 'HTTP ' . $status), 502);
        }

        return ['host' => 'localhost', 'name' => $da . '_' . $short, 'user' => $da . '_' . $short, 'pass' => $pass];
    }
}
