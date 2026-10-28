<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

final class Request
{
    /**
     * @param array<string,string> $query
     * @param array<string,mixed> $post
     * @param array<string,string> $headers lower-case names
     * @param array<string,string> $server
     * @param array<string,mixed> $files
     * @param array<string,string> $cookies
     */
    public function __construct(
        public readonly string $method,
        public readonly string $route,
        public readonly array $query,
        public readonly array $post,
        public readonly array $headers,
        public readonly string $body,
        public readonly array $server,
        public readonly array $files = [],
        public readonly array $cookies = [],
    ) {
    }

    public static function fromGlobals(int $maxBody): self
    {
        $headers = [];
        foreach ($_SERVER as $k => $v) {
            if (str_starts_with((string) $k, 'HTTP_')) {
                $headers[strtolower(str_replace('_', '-', substr((string) $k, 5)))] = (string) $v;
            }
        }
        foreach (['CONTENT_TYPE' => 'content-type', 'CONTENT_LENGTH' => 'content-length'] as $k => $name) {
            if (isset($_SERVER[$k])) {
                $headers[$name] = (string) $_SERVER[$k];
            }
        }
        $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
        $declared = (int) ($headers['content-length'] ?? 0);
        if ($declared > $maxBody) {
            throw new ApiError('too_large', 'The request body is larger than this host accepts.', 413);
        }
        $body = '';
        $ctype = $headers['content-type'] ?? '';
        if ($method !== 'GET' && !str_starts_with($ctype, 'multipart/form-data')) {
            $body = (string) file_get_contents('php://input', false, null, 0, $maxBody + 1);
            if (strlen($body) > $maxBody) {
                throw new ApiError('too_large', 'The request body is larger than this host accepts.', 413);
            }
        }
        $post = str_starts_with($ctype, 'application/x-www-form-urlencoded') ? $_POST : (str_starts_with($ctype, 'multipart/form-data') ? $_POST : []);
        $route = (string) ($_GET['r'] ?? '/');
        $query = array_map(static fn ($v) => is_array($v) ? '' : (string) $v, $_GET);

        return new self($method, $route === '' ? '/' : $route, $query, $post, $headers, $body, array_map('strval', array_filter($_SERVER, 'is_scalar')), $_FILES, array_map('strval', array_filter($_COOKIE, 'is_scalar')));
    }

    /** @param array<string,string> $query */
    public function withQuery(array $query): self
    {
        return new self($this->method, $this->route, $query + $this->query, $this->post, $this->headers, $this->body, $this->server, $this->files, $this->cookies);
    }

    public function header(string $name): string
    {
        return $this->headers[strtolower($name)] ?? '';
    }

    public function ip(): string
    {
        return $this->server['REMOTE_ADDR'] ?? '0.0.0.0';
    }

    public function host(): string
    {
        return strtolower($this->server['HTTP_HOST'] ?? ($this->server['SERVER_NAME'] ?? ''));
    }

    public function isSecure(): bool
    {
        $https = strtolower($this->server['HTTPS'] ?? '');

        return ($https !== '' && $https !== 'off') || ($this->server['SERVER_PORT'] ?? '') === '443';
    }

    public function isLoopback(): bool
    {
        return in_array($this->ip(), ['127.0.0.1', '::1'], true);
    }

    public function post(string $key, string $default = ''): string
    {
        $v = $this->post[$key] ?? $default;

        return is_string($v) ? $v : $default;
    }

    public function json(): array
    {
        if ($this->body === '') {
            return [];
        }
        $data = json_decode($this->body, true);
        if (!is_array($data)) {
            throw new ApiError('bad_json', 'The request body is not valid JSON.');
        }
        return $data;
    }
}

final class Response
{
    /** @param array<string,string> $headers @param list<string> $cookies */
    public function __construct(public int $status = 200, public string $body = '', public array $headers = [], public array $cookies = [])
    {
    }

    public static function json(int $status, array $data, array $headers = []): self
    {
        return new self($status, (string) json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR), ['Content-Type' => 'application/json; charset=utf-8', 'Cache-Control' => 'no-store'] + $headers);
    }

    public static function html(string $html, int $status = 200): self
    {
        return new self($status, $html, [
            'Content-Type' => 'text/html; charset=utf-8',
            'Cache-Control' => 'no-store',
            'X-Frame-Options' => 'DENY',
            'X-Content-Type-Options' => 'nosniff',
            'Referrer-Policy' => 'no-referrer',
            'Content-Security-Policy' => "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        ]);
    }

    public static function redirect(string $to): self
    {
        return new self(303, '', ['Location' => $to, 'Cache-Control' => 'no-store']);
    }

    public function send(): void
    {
        http_response_code($this->status);
        foreach ($this->headers as $k => $v) {
            header($k . ': ' . $v);
        }
        foreach ($this->cookies as $c) {
            header('Set-Cookie: ' . $c, false);
        }
        echo $this->body;
    }
}
