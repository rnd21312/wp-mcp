<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

/**
 * "Does this host really work?" Exercises what deploys depend on, in a scratch folder inside the data folder, and reports
 * each check as ok / warn / fail with a plain sentence. Nothing outside the data folder is touched.
 */
final class Selftest
{
    /** @return list<array{id:string,status:string,msg:string}> */
    public static function run(Agent $agent, bool $https, bool $online): array
    {
        $out = [];
        $add = static function (string $id, string $status, string $msg) use (&$out): void {
            $out[] = ['id' => $id, 'status' => $status, 'msg' => $msg];
        };
        $caps = $agent->caps();

        $add('php', $caps['php']['ok'] ? 'ok' : 'fail', 'PHP ' . PHP_VERSION . ($caps['php']['ok'] ? '' : ' (8.1 or newer is required)'));
        $add('https', $https ? 'ok' : 'warn', $https ? 'This request arrived over HTTPS.' : 'This request did not arrive over HTTPS. Logins and uploads should only travel over HTTPS.');

        $scratch = $agent->dataDir . '/selftest-' . Util::random(3);
        try {
            Fs::mkdir($scratch, 0700);
            file_put_contents($scratch . '/a', 'one');
            file_put_contents($scratch . '/b', 'two');
            $renamed = @rename($scratch . '/b', $scratch . '/a') && file_get_contents($scratch . '/a') === 'two';
            $add('data_dir', 'ok', 'The data folder is writable (' . ($agent->insideWebRoot() ? 'inside the web root, protected by deny rules' : 'outside the web root') . ').');
            if ($agent->insideWebRoot()) {
                $add('data_outside_web_root', 'warn', 'The data folder is inside the web root. On servers that ignore .htaccess (nginx) it must be blocked in the server configuration, or moved above the web root.');
            }
            $add('atomic_rename', $renamed ? 'ok' : 'fail', $renamed ? 'Files can be replaced atomically (needed for safe deploys).' : 'Replacing a file with rename() failed.');
            $fp = fopen($scratch . '/lock', 'c');
            $locked = $fp !== false && flock($fp, LOCK_EX | LOCK_NB);
            $add('locking', $locked ? 'ok' : 'warn', $locked ? 'File locks work.' : 'File locks are not available; two deploys at once may collide.');
            if ($fp) {
                fclose($fp);
            }
            $link = $scratch . '/link';
            $symlink = function_exists('symlink') && @symlink($scratch, $link) && is_dir($link);
            $add('symlink', $symlink ? 'ok' : 'warn', $symlink ? 'Symlinks work: atomic switch mode is available.' : 'Symlinks are not available: sites use file-sync mode (still safe, slightly less atomic).');
            $packed = function_exists('gzdeflate') ? gzdeflate(str_repeat('x', 5000)) : false;
            $ctx = $packed !== false && function_exists('inflate_init') ? inflate_init(ZLIB_ENCODING_RAW) : false;
            $ok = $ctx !== false && strlen((string) inflate_add($ctx, $packed)) === 5000;
            $add('zlib', $ok ? 'ok' : 'fail', $ok ? 'Zip archives can be unpacked.' : 'zlib is missing or broken: archives cannot be unpacked.');
        } catch (\Throwable $e) {
            $add('data_dir', 'fail', 'The data folder is not usable: ' . $e->getMessage());
        } finally {
            Fs::rrmdir($scratch);
        }

        $post = $caps['limits']['post_max_size'];
        $add('upload_limit', $post !== 0 && $post < 1048576 ? 'warn' : 'ok', 'Uploads are sent in chunks of ' . round($caps['limits']['chunk_bytes'] / 1048576, 1) . ' MB (post_max_size ' . ($post === 0 ? 'unlimited' : round($post / 1048576, 1) . ' MB') . ').');
        $mem = Util::bytes((string) ini_get('memory_limit'));
        $add('memory', $mem !== PHP_INT_MAX && $mem < 128 * 1048576 ? 'warn' : 'ok', 'memory_limit ' . ini_get('memory_limit') . ($mem !== PHP_INT_MAX && $mem < 128 * 1048576 ? ' (128M or more is recommended)' : ''));
        $time = (int) ini_get('max_execution_time');
        $add('time_limit', $time !== 0 && $time < 30 ? 'warn' : 'ok', 'max_execution_time ' . ($time === 0 ? 'unlimited' : $time . 's') . ($time !== 0 && $time < 30 ? ' (large unpacks or WordPress downloads may time out)' : ''));
        $free = (int) $caps['disk_free'];
        $add('disk', $free > 0 && $free < 200 * 1048576 ? 'warn' : 'ok', 'Free disk space: ' . ($free > 0 ? round($free / 1048576) . ' MB' : 'unknown'));
        $add('sodium', $caps['extensions']['sodium'] ? 'ok' : 'warn', $caps['extensions']['sodium'] ? 'Signed agent updates are possible (sodium).' : 'The sodium extension is missing: the agent cannot verify signed updates; update by uploading the zip by hand.');
        $add('database', ($caps['extensions']['pdo_mysql'] || $caps['extensions']['mysqli']) ? 'ok' : 'warn', ($caps['extensions']['pdo_mysql'] || $caps['extensions']['mysqli']) ? 'A MySQL driver is available (WordPress can be installed).' : 'No MySQL driver (pdo_mysql / mysqli): WordPress cannot be installed here.');
        $add('hashing', 'ok', 'Passwords use ' . (defined('PASSWORD_ARGON2ID') ? 'argon2id' : 'bcrypt') . '.');
        $add('exec', 'ok', $caps['functions']['exec'] ? 'Command functions are enabled (the agent still never runs commands built from input).' : 'Command functions are disabled (fine: the agent does not need them).');
        $add('node', $caps['node']['available'] ? 'ok' : 'warn', $caps['node']['available'] ? 'Node.js ' . $caps['node']['version'] . ' is available to this PHP.' : 'Node.js was not detected from PHP. Node apps on shared hosting run through the hosting panel (Passenger); on a VPS use the generated setup script.');
        $add('panel', 'ok', 'Hosting panel: ' . $caps['panel']['name'] . '; web server: ' . $caps['server']['web'] . '.');
        if (($caps['limits']['open_basedir'] ?? '') !== '') {
            $add('open_basedir', 'ok', 'open_basedir is set (' . $caps['limits']['open_basedir'] . '); sites must live inside it.');
        }

        foreach ((new Sites($agent))->all() as $site) {
            $dir = is_dir($site['target']) ? $site['target'] : dirname($site['target']);
            $add('site_' . $site['id'], is_writable($dir) ? 'ok' : 'fail', 'Site "' . $site['name'] . '": ' . (is_writable($dir) ? 'its folder is writable.' : 'its folder is NOT writable by the agent.'));
        }

        if ($online) {
            try {
                [$status] = Net::request('GET', Wp::CORE_SHA1, [], '', true, 10);
                $add('outbound', $status === 200 ? 'ok' : 'warn', $status === 200 ? 'This host can reach wordpress.org over HTTPS (WordPress install works).' : 'wordpress.org answered HTTP ' . $status . '.');
            } catch (ApiError $e) {
                $add('outbound', 'warn', 'This host cannot make outbound HTTPS requests: ' . $e->getMessage() . ' WordPress cannot be downloaded here.');
            }
        }

        return $out;
    }
}
