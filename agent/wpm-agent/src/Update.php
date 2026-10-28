<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

/**
 * Signed self-update. The Studio uploads a release zip; the agent applies it only if the Ed25519 signature over the zip's
 * SHA-256 verifies against the public key built into this installation, the version is newer, and the zip contains only
 * the agent's own files. The old files are kept in the data folder and restored automatically if the swap fails.
 */
final class Update
{
    public const CONTEXT = "wpm-agent-update\n";
    /** Test seam: base64 public key used instead of src/UpdateKey.php. */
    public static ?string $publicKey = null;

    public static function publicKey(): string
    {
        if (self::$publicKey !== null) {
            return self::$publicKey;
        }
        $file = __DIR__ . '/UpdateKey.php';

        return is_file($file) ? (string) (include $file) : '';
    }

    /** @return array{from:string,to:string,files:int,backup:string} */
    public static function apply(Agent $agent, string $zipPath, string $signatureB64): array
    {
        if (!function_exists('sodium_crypto_sign_verify_detached')) {
            throw new ApiError('no_sodium', 'This PHP has no sodium extension, so updates cannot be verified. Upload the new agent zip by hand instead.', 501);
        }
        $key = base64_decode(self::publicKey(), true);
        if ($key === false || strlen($key) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES) {
            throw new ApiError('no_update_key', 'This agent has no release key, so it will not accept updates. Update it by uploading the new zip by hand.', 409);
        }
        $sig = base64_decode(trim($signatureB64), true);
        if ($sig === false || strlen($sig) !== SODIUM_CRYPTO_SIGN_BYTES || !sodium_crypto_sign_verify_detached($sig, self::CONTEXT . hash_file('sha256', $zipPath), $key)) {
            $agent->audit('system', 'update.refused', 'bad signature');
            throw new ApiError('bad_signature', 'The update is not signed by the release key. Nothing was changed.', 403);
        }

        $stage = $agent->dataDir . '/update-' . Util::random(3);
        Fs::mkdir($stage, 0700);
        try {
            $info = Zip::extract($zipPath, $stage, 30 * 1048576, static function (string $rel): ?string {
                $ok = $rel === 'index.php' || $rel === '.htaccess' || $rel === 'README.txt' || (bool) preg_match('#^src/[A-Za-z0-9]+\.php$#', $rel) || (bool) preg_match('#^bridge/wp-mcp-bridge/[A-Za-z0-9._/-]+$#', $rel);

                return $ok ? null : 'The update contains a file that is not part of the agent: ' . $rel;
            }, 600);
            foreach (['index.php', 'src/Agent.php', 'src/Update.php'] as $must) {
                if (!isset($info['manifest'][$must])) {
                    throw new ApiError('bad_update', 'The update is incomplete (' . $must . ' is missing).', 422);
                }
            }
            $new = preg_match("/const VERSION = '([^']+)'/", (string) file_get_contents($stage . '/src/Agent.php'), $m) ? $m[1] : '';
            if ($new === '' || !version_compare($new, Agent::VERSION, '>')) {
                throw new ApiError('not_newer', 'The update (' . ($new ?: '?') . ') is not newer than this agent (' . Agent::VERSION . '). Downgrades are refused.', 409);
            }

            $backup = $agent->dataDir . '/backups/agent-' . Agent::VERSION . '-' . Util::now();
            Fs::mkdir($backup, 0700);
            $current = self::ownFiles($agent->agentDir);
            foreach ($current as $rel) {
                Fs::mkdir(dirname($backup . '/' . $rel), 0700);
                copy($agent->agentDir . '/' . $rel, $backup . '/' . $rel);
            }
            try {
                self::swap($agent->agentDir, $stage, array_keys($info['manifest']), $current);
            } catch (\Throwable $e) {
                try {
                    self::swap($agent->agentDir, $backup, $current, array_keys($info['manifest']));
                    $restored = 'the previous version was restored';
                } catch (\Throwable) {
                    $restored = 'restoring the previous version also failed; copy it back from ' . $backup;
                }
                throw new ApiError('update_failed', 'The update could not be applied (' . $e->getMessage() . '); ' . $restored . '.', 500);
            }
            $agent->audit('studio', 'update', Agent::VERSION . ' -> ' . $new);

            return ['from' => Agent::VERSION, 'to' => $new, 'files' => count($info['manifest']), 'backup' => basename($backup)];
        } finally {
            Fs::rrmdir($stage);
        }
    }

    /** The agent's own files (never data-location.php, the setup code or anything the owner added). @return list<string> */
    private static function ownFiles(string $dir): array
    {
        $out = [];
        foreach (['index.php', '.htaccess', 'README.txt'] as $f) {
            if (is_file($dir . '/' . $f)) {
                $out[] = $f;
            }
        }
        foreach (glob($dir . '/src/*.php') ?: [] as $f) {
            $out[] = 'src/' . basename($f);
        }
        if (is_dir($dir . '/bridge/wp-mcp-bridge')) {
            foreach (array_keys(Fs::manifest($dir . '/bridge/wp-mcp-bridge')) as $rel) {
                $out[] = 'bridge/wp-mcp-bridge/' . $rel;
            }
        }

        return $out;
    }

    /** Puts `$files` from `$from` into `$to` (each by temp file + rename, index.php last) and removes `$remove`d leftovers. */
    private static function swap(string $to, string $from, array $files, array $previous): void
    {
        usort($files, static fn ($a, $b) => (int) ($a === 'index.php') <=> (int) ($b === 'index.php'));
        Fs::mkdir($to . '/src');
        foreach ($files as $rel) {
            Fs::mkdir(dirname($to . '/' . $rel));
            $tmp = $to . '/' . $rel . '.wpm-new';
            if (!copy($from . '/' . $rel, $tmp)) {
                throw new \RuntimeException('cannot write ' . $rel);
            }
            if (!@rename($tmp, $to . '/' . $rel)) {
                // Windows cannot replace the script that is running; overwrite its contents in place instead.
                $ok = @file_put_contents($to . '/' . $rel, (string) file_get_contents($tmp)) !== false;
                @unlink($tmp);
                if (!$ok) {
                    throw new \RuntimeException('cannot write ' . $rel);
                }
            }
            if (function_exists('opcache_invalidate')) {
                @opcache_invalidate($to . '/' . $rel, true);
            }
        }
        foreach (array_diff($previous, $files) as $rel) {
            if (str_starts_with($rel, 'src/') || str_starts_with($rel, 'bridge/')) {
                @unlink($to . '/' . $rel);
            }
        }
    }
}
