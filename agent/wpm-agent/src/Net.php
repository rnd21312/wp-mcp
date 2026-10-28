<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

/** Outbound HTTPS from the host (WordPress downloads, hosting-panel APIs). The transport can be replaced in tests. */
final class Net
{
    /** @var (callable(string,string,array<string,string>,string,bool):array{0:int,1:string})|null */
    public static $transport = null;

    /** @return array{0:int,1:string} status, body */
    public static function request(string $method, string $url, array $headers = [], string $body = '', bool $verifyTls = true, int $timeout = 60): array
    {
        if (!str_starts_with($url, 'https://')) {
            throw new ApiError('https_only', 'Only https:// addresses are used for outbound requests.');
        }
        if (self::$transport !== null) {
            return (self::$transport)($method, $url, $headers, $body, $verifyTls);
        }
        $lines = [];
        foreach ($headers as $k => $v) {
            $lines[] = $k . ': ' . $v;
        }
        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $lines, CURLOPT_TIMEOUT => $timeout, CURLOPT_SSL_VERIFYPEER => $verifyTls, CURLOPT_SSL_VERIFYHOST => $verifyTls ? 2 : 0, CURLOPT_FOLLOWLOCATION => false, CURLOPT_USERAGENT => 'wpm-host-agent/' . Agent::VERSION]);
            if ($body !== '') {
                curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
            }
            $out = curl_exec($ch);
            if ($out === false) {
                $err = curl_error($ch);
                curl_close($ch);
                throw new ApiError('net_failed', 'Could not reach ' . (parse_url($url, PHP_URL_HOST) ?: 'the server') . ': ' . $err, 502);
            }
            $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            return [$status, (string) $out];
        }
        $ctx = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $lines), 'content' => $body, 'timeout' => $timeout, 'ignore_errors' => true, 'follow_location' => 0], 'ssl' => ['verify_peer' => $verifyTls, 'verify_peer_name' => $verifyTls]]);
        $out = @file_get_contents($url, false, $ctx);
        if ($out === false) {
            throw new ApiError('net_failed', 'Could not reach ' . (parse_url($url, PHP_URL_HOST) ?: 'the server') . ' (enable the curl extension or allow_url_fopen).', 502);
        }
        $status = 0;
        foreach ($http_response_header ?? [] as $h) {
            if (preg_match('#^HTTP/\S+\s+(\d+)#', $h, $m)) {
                $status = (int) $m[1];
            }
        }

        return [$status, $out];
    }

    /** Downloads a file to disk. Only a fixed allow-list of hosts is ever used for core downloads. */
    public static function download(string $url, string $to): void
    {
        [$status, $body] = self::request('GET', $url, [], '', true, 300);
        if ($status !== 200) {
            throw new ApiError('download_failed', 'Download failed (HTTP ' . $status . ') from ' . (parse_url($url, PHP_URL_HOST) ?: '?') . '.', 502);
        }
        file_put_contents($to, $body);
    }
}
