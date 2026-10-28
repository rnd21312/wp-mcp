<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

/** Small shared helpers. Time is injectable so tests can move the clock. */
final class Util
{
    public static ?int $now = null;

    public static function now(): int
    {
        return self::$now ?? time();
    }

    public static function random(int $bytes = 16): string
    {
        return bin2hex(random_bytes($bytes));
    }

    private const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    public static function base32Encode(string $bin): string
    {
        $bits = '';
        foreach (str_split($bin) as $c) {
            $bits .= str_pad(decbin(ord($c)), 8, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 5) as $chunk) {
            $out .= self::B32[bindec(str_pad($chunk, 5, '0'))];
        }
        return $out;
    }

    public static function base32Decode(string $text): string
    {
        $text = strtoupper(preg_replace('/[\s=-]+/', '', $text) ?? '');
        $bits = '';
        foreach (str_split($text) as $c) {
            $pos = strpos(self::B32, $c);
            if ($pos === false) {
                return '';
            }
            $bits .= str_pad(decbin($pos), 5, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 8) as $byte) {
            if (strlen($byte) === 8) {
                $out .= chr(bindec($byte));
            }
        }
        return $out;
    }

    /** Human friendly one-time code, e.g. WPMA-K3J9-XQ2M-7TVA. Ambiguous characters are left out. */
    public static function friendlyCode(string $prefix, int $groups = 3): string
    {
        $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        $parts = [$prefix];
        for ($g = 0; $g < $groups; $g++) {
            $part = '';
            for ($i = 0; $i < 4; $i++) {
                $part .= $alphabet[random_int(0, strlen($alphabet) - 1)];
            }
            $parts[] = $part;
        }
        return implode('-', $parts);
    }

    public static function slug(string $text): string
    {
        $slug = strtolower(trim((string) preg_replace('/[^a-zA-Z0-9]+/', '-', $text), '-'));
        return substr($slug, 0, 40);
    }

    public static function bytes(string $ini): int
    {
        $ini = trim($ini);
        if ($ini === '' || $ini === '-1') {
            return PHP_INT_MAX;
        }
        $n = (int) $ini;
        return match (strtolower(substr($ini, -1))) {
            'g' => $n * 1073741824,
            'm' => $n * 1048576,
            'k' => $n * 1024,
            default => $n,
        };
    }

    public static function h(string $s): string
    {
        return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }
}
