<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

/** What this host can do. Every probe is read-only (or cleans up after itself) and individually guarded. */
final class Caps
{
    /** @return array<string,mixed> */
    public static function detect(string $dataDir, string $agentDir, ?string $docRoot = null, array $server = []): array
    {
        $disabled = array_filter(array_map('trim', explode(',', (string) ini_get('disable_functions'))));
        $fnOk = static fn (string $f): bool => function_exists($f) && !in_array($f, $disabled, true);
        $ext = static fn (string $e): bool => extension_loaded($e);
        $software = (string) ($server['SERVER_SOFTWARE'] ?? ($_SERVER['SERVER_SOFTWARE'] ?? ''));
        $docRoot ??= (string) ($server['DOCUMENT_ROOT'] ?? ($_SERVER['DOCUMENT_ROOT'] ?? ''));
        $post = Util::bytes((string) ini_get('post_max_size'));
        $upload = Util::bytes((string) ini_get('upload_max_filesize'));

        $web = 'unknown';
        foreach (['litespeed' => 'litespeed', 'apache' => 'apache', 'nginx' => 'nginx', 'caddy' => 'caddy', 'iis' => 'iis', 'development server' => 'php-builtin'] as $needle => $name) {
            if (stripos($software, $needle) !== false || ($needle === 'development server' && PHP_SAPI === 'cli-server')) {
                $web = $name;
                break;
            }
        }

        return [
            'php' => ['version' => PHP_VERSION, 'ok' => PHP_VERSION_ID >= 80100, 'sapi' => PHP_SAPI, 'os' => PHP_OS_FAMILY],
            'extensions' => [
                'zlib' => $ext('zlib'), 'openssl' => $ext('openssl'), 'curl' => $ext('curl'), 'mbstring' => $ext('mbstring'), 'json' => $ext('json'),
                'zip' => $ext('zip'), 'pdo_mysql' => $ext('pdo_mysql'), 'mysqli' => $ext('mysqli'), 'pdo_sqlite' => $ext('pdo_sqlite'), 'sodium' => $ext('sodium'), 'gd' => $ext('gd'), 'intl' => $ext('intl'),
            ],
            'limits' => [
                'memory_limit' => (string) ini_get('memory_limit'),
                'max_execution_time' => (int) ini_get('max_execution_time'),
                'post_max_size' => $post === PHP_INT_MAX ? 0 : $post,
                'upload_max_filesize' => $upload === PHP_INT_MAX ? 0 : $upload,
                'chunk_bytes' => self::chunkBytes($post),
                'open_basedir' => (string) ini_get('open_basedir'),
            ],
            'functions' => ['exec' => $fnOk('exec') || $fnOk('proc_open'), 'symlink' => $fnOk('symlink'), 'disabled_count' => count($disabled)],
            'symlink_works' => self::symlinkWorks($dataDir),
            'server' => ['software' => $software, 'web' => $web, 'htaccess' => in_array($web, ['apache', 'litespeed'], true), 'document_root' => $docRoot, 'agent_dir' => $agentDir],
            'panel' => self::panel(),
            'disk_free' => (int) (@disk_free_space($dataDir) ?: 0),
            'data_dir_outside_web_root' => $docRoot !== '' && !Fs::within($docRoot, $dataDir),
            'node' => self::node($fnOk('exec')),
        ];
    }

    /** Largest request body worth sending: stay under post_max_size with headroom, between 256 KiB and 8 MiB. */
    public static function chunkBytes(int $postMax): int
    {
        $limit = $postMax === PHP_INT_MAX || $postMax <= 0 ? 8 * 1048576 : $postMax - 65536;

        return (int) max(262144, min(8 * 1048576, $limit));
    }

    private static function symlinkWorks(string $dir): bool
    {
        if (!function_exists('symlink') || !is_dir($dir) || !is_writable($dir)) {
            return false;
        }
        $link = $dir . '/.probe-' . Util::random(3);
        $ok = false;
        try {
            $ok = @symlink($dir, $link) && is_link($link) && is_dir($link);
        } catch (\Throwable) {
            $ok = false;
        }
        if (is_link($link)) {
            @unlink($link);
        }
        return $ok;
    }

    /** @return array<string,mixed> */
    private static function panel(): array
    {
        $found = 'none';
        $probes = ['cpanel' => ['/usr/local/cpanel', '/var/cpanel'], 'directadmin' => ['/usr/local/directadmin'], 'plesk' => ['/usr/local/psa', '/opt/psa'], 'cyberpanel' => ['/usr/local/CyberCP'], 'cloudpanel' => ['/home/clp'], 'hestia' => ['/usr/local/hestia']];
        foreach ($probes as $name => $paths) {
            foreach ($paths as $p) {
                if (@is_dir($p)) {
                    $found = $name;
                    break 2;
                }
            }
        }
        if ($found === 'none') {
            $home = (string) (getenv('HOME') ?: ($_SERVER['HOME'] ?? ''));
            if ($home !== '' && @is_dir($home . '/.cpanel')) {
                $found = 'cpanel';
            } elseif ($home !== '' && @is_dir($home . '/domains')) {
                $found = 'directadmin';
            }
        }
        return ['name' => $found];
    }

    /** @return array{available:bool,version:string} */
    private static function node(bool $canExec): array
    {
        if (!$canExec) {
            return ['available' => false, 'version' => '', 'checked' => false];
        }
        $out = [];
        $code = 1;
        @exec('node -v 2>&1', $out, $code);
        $v = trim((string) ($out[0] ?? ''));

        return ['available' => $code === 0 && preg_match('/^v\d+/', $v) === 1, 'version' => preg_match('/^v\d+/', $v) ? $v : '', 'checked' => true];
    }

    /** Requirements the wizard blocks on. @return list<array{id:string,ok:bool,msg:string,blocker:bool}> */
    public static function requirements(array $caps, bool $https, bool $loopback): array
    {
        $rows = [];
        $rows[] = ['id' => 'php', 'ok' => $caps['php']['ok'], 'msg' => 'PHP 8.1+ (found ' . $caps['php']['version'] . ')', 'blocker' => true];
        foreach (['zlib', 'json', 'openssl'] as $e) {
            $rows[] = ['id' => $e, 'ok' => $caps['extensions'][$e] ?? false, 'msg' => 'PHP extension ' . $e, 'blocker' => $e !== 'openssl'];
        }
        $rows[] = ['id' => 'https', 'ok' => $https || $loopback, 'msg' => 'HTTPS (required for login and uploads)', 'blocker' => false];
        $rows[] = ['id' => 'outside', 'ok' => (bool) $caps['data_dir_outside_web_root'], 'msg' => 'Data folder outside the web root', 'blocker' => false];

        return $rows;
    }
}
