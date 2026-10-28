<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

/** Confined file operations: nothing here touches a path outside the root it was given. */
final class Fs
{
    /** Validates a relative path from outside (zip entry, API argument). Returns it normalised, or null when unsafe. */
    public static function cleanRel(string $rel): ?string
    {
        if ($rel === '' || strlen($rel) > 400 || str_contains($rel, "\0") || str_contains($rel, '\\')) {
            return null;
        }
        if ($rel[0] === '/' || preg_match('/^[a-zA-Z]:/', $rel) || preg_match('/[\x00-\x1f]/', $rel)) {
            return null;
        }
        $parts = [];
        foreach (explode('/', $rel) as $seg) {
            if ($seg === '' || $seg === '.') {
                continue;
            }
            if ($seg === '..' || preg_match('/^\.+$/', $seg) || preg_match('/[<>:"|?*]/', $seg) || rtrim($seg, ' .') !== $seg) {
                return null;
            }
            $parts[] = $seg;
        }
        return $parts ? implode('/', $parts) : null;
    }

    /** True when $path (which may not exist yet) is $root or lies below it, following symlinks of existing parts. */
    public static function within(string $root, string $path): bool
    {
        $rootReal = realpath($root);
        if ($rootReal === false) {
            return false;
        }
        $probe = $path;
        $tail = [];
        while ($probe !== '' && $probe !== dirname($probe) && realpath($probe) === false) {
            array_unshift($tail, basename($probe));
            $probe = dirname($probe);
        }
        $real = realpath($probe);
        if ($real === false) {
            return false;
        }
        $full = rtrim(str_replace('\\', '/', $real), '/') . ($tail ? '/' . implode('/', $tail) : '');
        $rootN = rtrim(str_replace('\\', '/', $rootReal), '/');
        $cmp = DIRECTORY_SEPARATOR === '\\' ? 'strcasecmp' : 'strcmp';

        return $cmp($full, $rootN) === 0 || $cmp(substr($full, 0, strlen($rootN) + 1), $rootN . '/') === 0;
    }

    public static function norm(string $path): string
    {
        $real = realpath($path);
        return rtrim(str_replace('\\', '/', $real !== false ? $real : $path), '/');
    }

    public static function mkdir(string $dir, int $mode = 0755): void
    {
        if (!is_dir($dir) && !@mkdir($dir, $mode, true) && !is_dir($dir)) {
            throw new ApiError('fs_mkdir', 'Cannot create a folder: ' . basename($dir), 500);
        }
    }

    /** Deletes a tree without following symlinks. */
    public static function rrmdir(string $dir): void
    {
        if (is_link($dir) || is_file($dir)) {
            @unlink($dir);
            return;
        }
        if (!is_dir($dir)) {
            return;
        }
        foreach (scandir($dir) ?: [] as $name) {
            if ($name !== '.' && $name !== '..') {
                self::rrmdir($dir . '/' . $name);
            }
        }
        @rmdir($dir);
    }

    public static function copyTree(string $from, string $to): int
    {
        self::mkdir($to);
        $n = 0;
        foreach (scandir($from) ?: [] as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            $src = $from . '/' . $name;
            if (is_link($src)) {
                continue;
            }
            if (is_dir($src)) {
                $n += self::copyTree($src, $to . '/' . $name);
            } else {
                copy($src, $to . '/' . $name);
                $n++;
            }
        }
        return $n;
    }

    /** @return array<string,array{sha256:string,size:int}> relative path => info */
    public static function manifest(string $dir): array
    {
        $out = [];
        $base = rtrim(str_replace('\\', '/', $dir), '/');
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS));
        foreach ($it as $file) {
            if ($file->isLink() || !$file->isFile()) {
                continue;
            }
            $rel = ltrim(substr(str_replace('\\', '/', $file->getPathname()), strlen($base)), '/');
            $out[$rel] = ['sha256' => hash_file('sha256', $file->getPathname()), 'size' => $file->getSize()];
        }
        ksort($out);
        return $out;
    }

    public static function isEmptyDir(string $dir): bool
    {
        return is_dir($dir) && !is_link($dir) && count(array_diff(scandir($dir) ?: [], ['.', '..'])) === 0;
    }

    /** Removes empty parent folders up to (not including) $stop. */
    public static function pruneEmpty(string $dir, string $stop): void
    {
        $stop = rtrim(str_replace('\\', '/', $stop), '/');
        while (true) {
            $d = rtrim(str_replace('\\', '/', $dir), '/');
            if (strlen($d) <= strlen($stop) || !str_starts_with($d, $stop . '/') || !self::isEmptyDir($d)) {
                return;
            }
            @rmdir($d);
            $dir = dirname($d);
        }
    }
}
