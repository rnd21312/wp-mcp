<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

/**
 * Tiny JSON database: one file per collection, written atomically under a lock.
 * Every file starts with a PHP guard line, so even a mis-configured web server executes (and ends) it instead of
 * serving its content.
 */
final class Store
{
    public const GUARD = "<?php http_response_code(404); exit; ?>\n";

    public function __construct(public readonly string $dir)
    {
    }

    private function safe(string $name): string
    {
        return (string) preg_replace('/[^a-zA-Z0-9._-]/', '_', $name);
    }

    public function path(string $name): string
    {
        return $this->dir . '/' . $this->safe($name) . '.json.php';
    }

    public function read(string $name, array $default = []): array
    {
        $raw = @file_get_contents($this->path($name));
        if ($raw === false || !str_starts_with($raw, self::GUARD)) {
            return $default;
        }
        $data = json_decode(substr($raw, strlen(self::GUARD)), true);
        return is_array($data) ? $data : $default;
    }

    public function write(string $name, array $data): void
    {
        $file = $this->path($name);
        $tmp = $file . '.' . Util::random(4) . '.tmp';
        $json = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT | JSON_INVALID_UTF8_SUBSTITUTE);
        if (file_put_contents($tmp, self::GUARD . $json) === false) {
            throw new ApiError('store_write', 'Cannot write to the data folder.', 500);
        }
        @chmod($tmp, 0600);
        if (!@rename($tmp, $file)) {
            @unlink($tmp);
            throw new ApiError('store_write', 'Cannot replace a data file.', 500);
        }
    }

    /** Read-modify-write under an exclusive lock. The callback receives the data and returns the new data (or null to keep). */
    public function update(string $name, callable $fn, array $default = []): mixed
    {
        $lock = fopen($this->dir . '/' . $this->safe($name) . '.lock', 'c');
        if ($lock === false) {
            throw new ApiError('store_lock', 'Cannot lock the data folder.', 500);
        }
        flock($lock, LOCK_EX);
        try {
            $data = $this->read($name, $default);
            $result = null;
            $new = $fn($data, $result);
            if (is_array($new)) {
                $this->write($name, $new);
            }
            return $result;
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    /** Append-only log: one JSON object per line after the guard. */
    public function log(string $name, array $entry): void
    {
        $file = $this->path($name);
        $fresh = !is_file($file);
        $fp = @fopen($file, 'ab');
        if ($fp === false) {
            return;
        }
        flock($fp, LOCK_EX);
        if ($fresh) {
            fwrite($fp, self::GUARD);
            @chmod($file, 0600);
        }
        fwrite($fp, json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) . "\n");
        flock($fp, LOCK_UN);
        fclose($fp);
    }

    /** Newest entries first. */
    public function tail(string $name, int $limit = 100): array
    {
        $raw = @file_get_contents($this->path($name));
        if ($raw === false) {
            return [];
        }
        $lines = array_values(array_filter(explode("\n", substr($raw, strlen(self::GUARD))), static fn ($l) => $l !== ''));
        $out = [];
        foreach (array_slice(array_reverse($lines), 0, $limit) as $line) {
            $row = json_decode($line, true);
            if (is_array($row)) {
                $out[] = $row;
            }
        }
        return $out;
    }
}
