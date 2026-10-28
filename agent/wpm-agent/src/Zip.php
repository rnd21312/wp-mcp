<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

/**
 * Minimal zip reader (stored + deflate). No ZipArchive needed. Every entry name is validated (zip-slip),
 * sizes are capped while inflating (zip bombs), CRCs are checked, and links/special entries are refused.
 */
final class Zip
{
    /** @return list<array<string,mixed>> */
    public static function entries(string $file, int $maxEntries = 60000): array
    {
        $size = @filesize($file);
        if ($size === false || $size < 22) {
            throw new ApiError('bad_zip', 'The upload is not a zip file.');
        }
        $fp = fopen($file, 'rb');
        $tailLen = (int) min($size, 65557);
        fseek($fp, $size - $tailLen);
        $tail = (string) fread($fp, $tailLen);
        $pos = strrpos($tail, "PK\x05\x06");
        if ($pos === false) {
            fclose($fp);
            throw new ApiError('bad_zip', 'The upload is not a zip file.');
        }
        $eocd = unpack('vdisk/vcdisk/vcount/vtotal/Vcdsize/Vcdoff', substr($tail, $pos + 4, 16));
        if ($eocd['total'] === 0xFFFF || $eocd['cdoff'] === 0xFFFFFFFF) {
            fclose($fp);
            throw new ApiError('zip64', 'Zip64 archives are not supported. Use a smaller archive.');
        }
        if ($eocd['total'] > $maxEntries) {
            fclose($fp);
            throw new ApiError('zip_too_many', 'The archive has too many files.');
        }
        fseek($fp, $eocd['cdoff']);
        $central = (string) fread($fp, max(1, $eocd['cdsize']));
        fclose($fp);
        $entries = [];
        $p = 0;
        for ($i = 0; $i < $eocd['total']; $i++) {
            if ($p + 46 > strlen($central) || substr($central, $p, 4) !== "PK\x01\x02") {
                throw new ApiError('bad_zip', 'The zip directory is damaged.');
            }
            $h = unpack('vmade/vneed/vflags/vmethod/vtime/vdate/Vcrc/Vcsize/Vusize/vnlen/velen/vclen/vdisk/viattr/Veattr/Voffset', substr($central, $p + 4, 42));
            $name = substr($central, $p + 46, $h['nlen']);
            $p += 46 + $h['nlen'] + $h['elen'] + $h['clen'];
            if ($h['flags'] & 1) {
                throw new ApiError('zip_encrypted', 'Encrypted zip files are not supported.');
            }
            $entries[] = ['name' => $name, 'method' => $h['method'], 'csize' => $h['csize'], 'usize' => $h['usize'], 'crc' => $h['crc'], 'offset' => $h['offset'], 'dir' => str_ends_with($name, '/'), 'eattr' => $h['eattr'], 'made' => $h['made']];
        }
        return $entries;
    }

    /**
     * Extracts into an existing folder.
     *
     * @param callable(string):?string|null $accept returns an error message to reject a path (policy per site kind)
     * @return array{files:int,bytes:int,manifest:array<string,array{sha256:string,size:int}>}
     */
    public static function extract(string $file, string $dest, int $maxBytes, ?callable $accept = null, int $maxEntries = 60000): array
    {
        $entries = self::entries($file, $maxEntries);
        $names = [];
        foreach ($entries as $e) {
            if (!$e['dir']) {
                $names[] = $e['name'];
            }
        }
        $strip = self::commonRoot($names);
        $total = 0;
        $files = 0;
        $manifest = [];
        $fp = fopen($file, 'rb');
        try {
            foreach ($entries as $e) {
                if ($e['dir']) {
                    continue;
                }
                // Unix file type lives in the high 16 bits of the external attributes (host system 3).
                $type = ($e['eattr'] >> 16) & 0170000;
                if (($e['made'] >> 8) === 3 && $type !== 0 && $type !== 0100000) {
                    throw new ApiError('zip_special', 'The archive contains a link or special file: ' . substr($e['name'], 0, 80));
                }
                $name = $strip !== '' ? substr($e['name'], strlen($strip)) : $e['name'];
                $rel = Fs::cleanRel($name);
                if ($rel === null) {
                    throw new ApiError('zip_unsafe_path', 'Unsafe path in the archive: ' . substr($e['name'], 0, 80));
                }
                if ($accept !== null && ($why = $accept($rel)) !== null) {
                    throw new ApiError('zip_rejected', $why);
                }
                $total += $e['usize'];
                if ($total > $maxBytes) {
                    throw new ApiError('zip_too_big', 'The archive expands beyond the allowed size.');
                }
                if ($e['csize'] > 0 && $e['usize'] > 5_000_000 && $e['usize'] / $e['csize'] > 2000) {
                    throw new ApiError('zip_ratio', 'Suspicious compression ratio in: ' . $rel);
                }
                $target = $dest . '/' . $rel;
                if (!Fs::within($dest, $target)) {
                    throw new ApiError('zip_unsafe_path', 'Unsafe path in the archive.');
                }
                Fs::mkdir(dirname($target));
                self::writeEntry($fp, $e, $target);
                $manifest[$rel] = ['sha256' => hash_file('sha256', $target), 'size' => $e['usize']];
                $files++;
            }
        } finally {
            fclose($fp);
        }
        ksort($manifest);
        return ['files' => $files, 'bytes' => $total, 'manifest' => $manifest];
    }

    /** If every file sits under one top-level folder, that folder name (with slash); else ''. */
    private static function commonRoot(array $names): string
    {
        if (!$names) {
            return '';
        }
        $first = explode('/', $names[0], 2);
        if (count($first) < 2) {
            return '';
        }
        $prefix = $first[0] . '/';
        foreach ($names as $n) {
            if (!str_starts_with($n, $prefix)) {
                return '';
            }
        }
        return $prefix;
    }

    private static function writeEntry($fp, array $e, string $target): void
    {
        if ($e['method'] !== 0 && $e['method'] !== 8) {
            throw new ApiError('zip_method', 'Unsupported compression method in the archive.');
        }
        fseek($fp, $e['offset']);
        $lh = (string) fread($fp, 30);
        if (strlen($lh) < 30 || substr($lh, 0, 4) !== "PK\x03\x04") {
            throw new ApiError('bad_zip', 'The zip entry header is damaged.');
        }
        $l = unpack('vnlen/velen', substr($lh, 26, 4));
        fseek($fp, $e['offset'] + 30 + $l['nlen'] + $l['elen']);
        $out = fopen($target, 'wb');
        $crc = hash_init('crc32b');
        $written = 0;
        $remaining = $e['csize'];
        $inflate = $e['method'] === 8 ? inflate_init(ZLIB_ENCODING_RAW) : null;
        $fail = static function (string $code, string $msg) use ($out): never {
            fclose($out);
            throw new ApiError($code, $msg);
        };
        while ($remaining > 0) {
            $chunk = (string) fread($fp, (int) min(65536, $remaining));
            if ($chunk === '') {
                $fail('bad_zip', 'The archive is truncated.');
            }
            $remaining -= strlen($chunk);
            $data = $inflate ? @inflate_add($inflate, $chunk) : $chunk;
            if ($data === false) {
                $fail('bad_zip', 'The archive is corrupted.');
            }
            $written += strlen($data);
            if ($written > $e['usize']) {
                $fail('zip_bomb', 'An entry is larger than it declares.');
            }
            hash_update($crc, $data);
            fwrite($out, $data);
        }
        fclose($out);
        if ($written !== $e['usize'] || hexdec(hash_final($crc)) !== $e['crc']) {
            throw new ApiError('zip_crc', 'Checksum mismatch inside the archive: ' . basename($target));
        }
    }
}
