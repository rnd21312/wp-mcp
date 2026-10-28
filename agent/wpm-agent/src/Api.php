<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

/**
 * Signed JSON API for the Studio. Every call is POST /index.php?r=/api/v1/<op>.
 * Headers: X-Wpm-Key, X-Wpm-Time, X-Wpm-Nonce, X-Wpm-Signature (HMAC-SHA256 over time, nonce, key, method, route and body hash).
 * Replies carry X-Wpm-Signature so the Studio can tell a real agent from an impostor.
 */
final class Api
{
    private const PREFIX = '/api/v1/';

    public function __construct(private Agent $agent, private Auth $auth, private Sites $sites, private ?Wp $wp = null)
    {
    }

    public function handle(Request $req): Response
    {
        $op = substr($req->route, strlen(self::PREFIX));
        try {
            if (!$this->agent->installed()) {
                throw new ApiError('not_installed', 'The agent is not set up yet. Open it in a browser and finish the setup wizard.', 503);
            }
            if (!$req->isSecure() && !$req->isLoopback() && empty($this->agent->config()['allow_http'])) {
                throw new ApiError('https_required', 'This agent only accepts HTTPS requests.', 403);
            }
            if ($req->method !== 'POST') {
                throw new ApiError('method', 'Use POST.', 405);
            }
            if ($op === 'pair') {
                $in = $req->json();
                $out = $this->auth->pair($req, (string) ($in['code'] ?? ''), (string) ($in['name'] ?? 'Studio'));

                return Response::json(200, ['ok' => true, 'data' => $out + ['agent_version' => Agent::VERSION]]);
            }
            $conn = $this->authenticate($req);
        } catch (ApiError $e) {
            return $this->error($e);
        }

        try {
            $data = $this->dispatch($op, $conn, $req);
            $res = Response::json(200, ['ok' => true, 'data' => $data]);
        } catch (ApiError $e) {
            $res = $this->error($e);
        } catch (\Throwable $e) {
            $this->agent->audit('system', 'error', get_class($e) . ': ' . $e->getMessage());
            $res = $this->error(new ApiError('internal', 'The agent hit an unexpected error. See the audit log on the host.', 500));
        }
        $res->headers['X-Wpm-Signature'] = Security::responseSignature($conn['secret'], $req->header('x-wpm-nonce'), $res->body);

        return $res;
    }

    private function error(ApiError $e): Response
    {
        return Response::json($e->status, ['ok' => false, 'error' => ['code' => $e->errorCode, 'message' => $e->getMessage(), 'data' => $e->data]]);
    }

    /** @return array<string,mixed> */
    private function authenticate(Request $req): array
    {
        $store = $this->agent->store;
        $ipKey = 'sig:' . $req->ip();
        if (Security::lockedFor($store, $ipKey) > 0) {
            throw new ApiError('locked', 'Too many bad requests from this address. Try again later.', 429);
        }
        $keyId = $req->header('x-wpm-key');
        $ts = $req->header('x-wpm-time');
        $nonce = $req->header('x-wpm-nonce');
        $given = $req->header('x-wpm-signature');
        $conn = $keyId !== '' ? $this->auth->connection($keyId) : null;
        if (!$conn) {
            Security::fail($store, $ipKey);
            throw new ApiError('unknown_key', 'Unknown or revoked connection key. Pair the Studio again.', 401);
        }
        $err = Security::verify((string) $conn['secret'], $ts, $nonce, $keyId, $req->method, $req->route, $req->body, $given, Util::now());
        if ($err !== null) {
            Security::fail($store, $ipKey);
            throw new ApiError($err, $err === 'stale_request' ? 'The request is too old. Check the clock on your computer and on the host.' : 'The request signature is wrong.', 401);
        }
        if (!Security::claimNonce($this->agent->dataDir . '/nonces', $keyId, $nonce)) {
            throw new ApiError('replay', 'This request was already used.', 401);
        }
        $this->auth->touch($keyId);

        return $conn;
    }

    private function need(array $conn, string $level): void
    {
        if (Auth::LEVELS[$conn['level']] < Auth::LEVELS[$level]) {
            throw new ApiError('level_too_low', 'This connection may not do that (needs "' . $level . '", has "' . $conn['level'] . '").', 403);
        }
    }

    private function allowedSite(array $conn, string $id): void
    {
        if ($conn['sites'] !== '*' && !in_array($id, (array) $conn['sites'], true)) {
            throw new ApiError('site_not_allowed', 'This connection has no access to that site.', 403);
        }
    }

    /** @return array<string,mixed> */
    private function dispatch(string $op, array $conn, Request $req): array
    {
        $actor = 'studio:' . $conn['name'];
        $keyId = (string) $conn['key_id'];
        if (str_starts_with($op, 'upload/chunk/')) {
            $this->need($conn, 'deploy');
            [, , $uid, $n] = array_pad(explode('/', $op), 4, '');
            if (!ctype_digit($n)) {
                throw new ApiError('bad_chunk', 'Bad chunk number.');
            }
            return ['received' => $this->sites->uploadChunk($uid, (int) $n, $req->body, $keyId)];
        }
        $in = $req->json();
        switch ($op) {
            case 'hello':
                $this->need($conn, 'read');
                return ['agent' => 'wpm-host-agent', 'version' => Agent::VERSION, 'time' => Util::now(), 'level' => $conn['level'], 'sites' => count($this->sites->all()), 'name' => $conn['name']];
            case 'host.info':
                $this->need($conn, 'read');
                return $this->agent->caps() + ['roots' => $this->agent->roots(), 'max_upload_bytes' => $this->agent->maxUploadBytes(), 'kinds' => Sites::KINDS, 'script_dir' => rtrim(str_replace('\\', '/', dirname($req->server['SCRIPT_NAME'] ?? '/index.php')), '/')];
            case 'sites.list':
                $this->need($conn, 'read');
                return ['sites' => array_values(array_map(fn ($s) => $this->sites->view($s), array_filter($this->sites->all(), fn ($s) => $conn['sites'] === '*' || in_array($s['id'], (array) $conn['sites'], true))))];
            case 'sites.get':
                $this->need($conn, 'read');
                $this->allowedSite($conn, (string) ($in['site'] ?? ''));
                return ['site' => $this->sites->view($this->sites->get((string) $in['site']))];
            case 'sites.create':
                $this->need($conn, 'admin');
                return ['site' => $this->sites->view($this->sites->create($in, $actor))];
            case 'sites.delete':
                $this->need($conn, 'admin');
                $this->sites->delete((string) ($in['site'] ?? ''), !empty($in['purge']), $actor);
                return ['deleted' => $in['site']];
            case 'releases.list':
                $this->need($conn, 'read');
                $this->allowedSite($conn, (string) ($in['site'] ?? ''));
                return $this->sites->releases((string) $in['site']);
            case 'upload.begin':
                $this->need($conn, 'deploy');
                return $this->sites->uploadBegin((int) ($in['size'] ?? 0), (string) ($in['sha256'] ?? ''), $keyId);
            case 'upload.finish':
                $this->need($conn, 'deploy');
                return $this->sites->uploadFinish((string) ($in['upload_id'] ?? ''), (int) ($in['chunks'] ?? 0), $keyId);
            case 'deploy':
                $this->need($conn, 'deploy');
                $this->allowedSite($conn, (string) ($in['site'] ?? ''));
                return ['release' => $this->sites->deploy((string) $in['site'], (string) ($in['upload_id'] ?? ''), (string) ($in['note'] ?? ''), $actor, $keyId)];
            case 'rollback':
                $this->need($conn, 'deploy');
                $this->allowedSite($conn, (string) ($in['site'] ?? ''));
                return $this->sites->rollback((string) $in['site'], isset($in['release']) ? (string) $in['release'] : null, $actor);
            case 'db.test':
                $this->need($conn, 'admin');
                $db = Db::provision(['method' => 'manual'] + $in);
                return ['ok' => true, 'host' => $db['host'], 'name' => $db['name']];
            case 'wp.install':
                $this->need($conn, 'admin');
                $this->allowedSite($conn, (string) ($in['site'] ?? ''));
                $bridge = !empty($in['bridge_upload']) ? $this->sites->uploadBlob((string) $in['bridge_upload'], $keyId) : null;
                $out = ($this->wp ?? new Wp($this->agent, $this->sites))->install($this->sites->get((string) $in['site']), (array) ($in['db'] ?? []), $bridge, $actor);
                if ($bridge !== null) {
                    Fs::rrmdir(dirname($bridge));
                }
                return $out;
            case 'wp.finish':
                $this->need($conn, 'admin');
                $this->allowedSite($conn, (string) ($in['site'] ?? ''));
                return ($this->wp ?? new Wp($this->agent, $this->sites))->finish($this->sites->get((string) $in['site']), (string) ($in['admin_user'] ?? ''), (string) ($in['ceiling'] ?? 'admin'), $actor);
            case 'audit':
                $this->need($conn, 'admin');
                return ['entries' => $this->agent->store->tail('audit', min(500, max(1, (int) ($in['limit'] ?? 100))))];
            case 'connections.list':
                $this->need($conn, 'admin');
                return ['connections' => $this->auth->connections()];
        }
        throw new ApiError('unknown_op', 'Unknown operation "' . $op . '".', 404);
    }
}
