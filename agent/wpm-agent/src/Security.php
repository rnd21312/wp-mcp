<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

/** TOTP (RFC 6238), request signatures (same scheme as the WordPress bridge) and attempt throttling. */
final class Security
{
    public const WINDOW = 300;

    // ---- TOTP ---------------------------------------------------------------------------------------------------

    public static function totpSecret(): string
    {
        return Util::base32Encode(random_bytes(20));
    }

    public static function totpCode(string $secretBase32, int $step): string
    {
        $key = Util::base32Decode($secretBase32);
        $hash = hash_hmac('sha1', pack('J', $step), $key, true);
        $offset = ord($hash[19]) & 0xf;
        $num = ((ord($hash[$offset]) & 0x7f) << 24) | (ord($hash[$offset + 1]) << 16) | (ord($hash[$offset + 2]) << 8) | ord($hash[$offset + 3]);

        return str_pad((string) ($num % 1000000), 6, '0', STR_PAD_LEFT);
    }

    /** Returns the matched time step (to store and refuse reuse), or null. Accepts one step either side for clock drift. */
    public static function totpVerify(string $secretBase32, string $code, int $lastStep = 0): ?int
    {
        $code = preg_replace('/\s+/', '', $code) ?? '';
        if (!preg_match('/^\d{6}$/', $code)) {
            return null;
        }
        $now = intdiv(Util::now(), 30);
        for ($step = $now - 1; $step <= $now + 1; $step++) {
            if ($step > $lastStep && hash_equals(self::totpCode($secretBase32, $step), $code)) {
                return $step;
            }
        }
        return null;
    }

    public static function totpUri(string $secret, string $account, string $issuer = 'WPM Host Agent'): string
    {
        return 'otpauth://totp/' . rawurlencode($issuer . ':' . $account) . '?secret=' . $secret . '&issuer=' . rawurlencode($issuer) . '&algorithm=SHA1&digits=6&period=30';
    }

    // ---- Signatures ---------------------------------------------------------------------------------------------

    public static function signingString(string $ts, string $nonce, string $keyId, string $method, string $route, string $body): string
    {
        return implode("\n", [$ts, $nonce, $keyId, strtoupper($method), $route, hash('sha256', $body)]);
    }

    public static function sign(string $secret, string $ts, string $nonce, string $keyId, string $method, string $route, string $body): string
    {
        return hash_hmac('sha256', self::signingString($ts, $nonce, $keyId, $method, $route, $body), $secret);
    }

    /** @return string|null error code, or null when authentic and fresh */
    public static function verify(string $secret, string $ts, string $nonce, string $keyId, string $method, string $route, string $body, string $given, int $now): ?string
    {
        if (!ctype_digit($ts) || abs($now - (int) $ts) > self::WINDOW) {
            return 'stale_request';
        }
        if (!preg_match('/^[a-f0-9]{16,64}$/', $nonce)) {
            return 'bad_nonce';
        }
        return hash_equals(self::sign($secret, $ts, $nonce, $keyId, $method, $route, $body), $given) ? null : 'bad_signature';
    }

    public static function responseSignature(string $secret, string $nonce, string $body): string
    {
        return hash_hmac('sha256', $nonce . "\n" . hash('sha256', $body), $secret);
    }

    /** Each nonce may be used once. Exclusive file creation is atomic, so two parallel replays cannot both win. */
    public static function claimNonce(string $dir, string $keyId, string $nonce): bool
    {
        Fs::mkdir($dir, 0700);
        $file = $dir . '/' . hash('sha256', $keyId . ':' . $nonce);
        $fp = @fopen($file, 'x');
        if ($fp === false) {
            return false;
        }
        fclose($fp);
        if (random_int(1, 25) === 1) {
            self::pruneNonces($dir);
        }
        return true;
    }

    public static function pruneNonces(string $dir): void
    {
        $cut = Util::now() - 2 * self::WINDOW;
        foreach (glob($dir . '/*') ?: [] as $f) {
            if (@filemtime($f) < $cut) {
                @unlink($f);
            }
        }
    }

    // ---- Throttle -----------------------------------------------------------------------------------------------

    /** Seconds the key is still locked (0 = free). */
    public static function lockedFor(Store $store, string $key): int
    {
        $row = $store->read('throttle')[$key] ?? null;

        return $row && ($row['until'] ?? 0) > Util::now() ? (int) $row['until'] - Util::now() : 0;
    }

    /** Records a failure. From the 5th in a row the key is locked, for longer each time (15 min doubling, max 24 h). */
    public static function fail(Store $store, string $key): void
    {
        $store->update('throttle', static function (array $all) use ($key): array {
            $row = $all[$key] ?? ['fails' => 0, 'until' => 0, 'last' => 0];
            if ($row['last'] < Util::now() - 3600 && $row['until'] < Util::now()) {
                $row['fails'] = 0;
            }
            $row['fails']++;
            $row['last'] = Util::now();
            if ($row['fails'] >= 5) {
                $row['until'] = Util::now() + min(86400, 900 * (2 ** intdiv($row['fails'] - 5, 5)));
            }
            $all[$key] = $row;
            foreach ($all as $k => $r) {
                if (($r['last'] ?? 0) < Util::now() - 172800) {
                    unset($all[$k]);
                }
            }
            return $all;
        });
    }

    public static function clear(Store $store, string $key): void
    {
        $store->update('throttle', static function (array $all) use ($key): ?array {
            if (!isset($all[$key])) {
                return null;
            }
            unset($all[$key]);
            return $all;
        });
    }
}
