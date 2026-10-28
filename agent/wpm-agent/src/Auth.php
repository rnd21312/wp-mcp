<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

/** Admin account, login sessions, CSRF, and Studio connections (pairing + signed-request lookup). */
final class Auth
{
    public const LEVELS = ['read' => 1, 'deploy' => 2, 'admin' => 3];
    private const IDLE = 7200;
    private const ABSOLUTE = 43200;

    public function __construct(private Agent $agent)
    {
    }

    // ---- passwords ----------------------------------------------------------------------------------------------

    public static function hash(string $password): string
    {
        // Pre-hash so long passphrases survive bcrypt's 72-byte limit and NUL bytes are harmless.
        $pre = base64_encode(hash('sha256', $password, true));
        $algo = defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_BCRYPT;

        return password_hash($pre, $algo);
    }

    public static function verify(string $password, string $hash): bool
    {
        return password_verify(base64_encode(hash('sha256', $password, true)), $hash);
    }

    public static function passwordProblem(string $user, string $password): ?string
    {
        if (strlen($password) < 10) {
            return 'weak_password';
        }
        if (strcasecmp($password, $user) === 0 || preg_match('/^(.)\1+$/', $password) || in_array(strtolower($password), ['password123', '1234567890', 'qwertyuiop', 'password12', 'admin12345'], true)) {
            return 'weak_password';
        }
        return null;
    }

    // ---- setup --------------------------------------------------------------------------------------------------

    /** The setup code: baked into the zip by the Studio (wpm-setup.php), or generated into the data folder. */
    public function setupToken(): string
    {
        $file = $this->agent->agentDir . '/wpm-setup.php';
        if (is_file($file)) {
            $v = include $file;
            if (is_string($v) && strlen($v) >= 12) {
                return $v;
            }
        }
        $row = $this->agent->store->read('setup');
        if (empty($row['token'])) {
            $row = ['token' => Util::friendlyCode('WPMS', 4), 'created' => Util::now()];
            $this->agent->store->write('setup', $row);
        }
        return $row['token'];
    }

    public function setupTokenPath(): string
    {
        return is_file($this->agent->agentDir . '/wpm-setup.php') ? $this->agent->agentDir . '/wpm-setup.php' : $this->agent->store->path('setup');
    }

    /** @return string|null error code */
    public function install(Request $req, string $user, string $password, string $confirm, string $token, bool $allowHttp): ?string
    {
        if ($this->agent->installed()) {
            return 'already_installed';
        }
        $key = 'setup:' . $req->ip();
        if (Security::lockedFor($this->agent->store, $key) > 0) {
            return 'locked';
        }
        if (!hash_equals($this->setupToken(), strtoupper(trim($token)))) {
            Security::fail($this->agent->store, $key);
            return 'bad_setup_code';
        }
        if (!preg_match('/^[a-zA-Z0-9._-]{3,32}$/', $user)) {
            return 'bad_username';
        }
        if ($password !== $confirm) {
            return 'password_mismatch';
        }
        if (self::passwordProblem($user, $password) !== null) {
            return 'weak_password';
        }
        if (!$req->isSecure() && !$req->isLoopback() && !$allowHttp) {
            return 'https_required';
        }
        $config = [
            'version' => 1, 'installed_at' => Util::now(), 'allow_http' => $allowHttp && !$req->isSecure(), 'roots' => [], 'keep_releases' => 5, 'max_upload_mb' => 256,
            'admin' => ['user' => $user, 'hash' => self::hash($password), 'totp' => null, 'last_totp_step' => 0],
        ];
        $won = $this->agent->store->update('config', static function (array $c, &$out) use ($config) {
            if (!empty($c['admin']['user'])) {
                $out = false;
                return null;
            }
            $out = true;
            return $config;
        });
        if (!$won) {
            return 'already_installed';
        }
        $this->agent->setConfig($this->agent->store->read('config'));
        @unlink($this->agent->agentDir . '/wpm-setup.php');
        @unlink($this->agent->store->path('setup'));
        $this->agent->audit($user, 'setup', 'agent installed', $req->ip());

        return null;
    }

    /**
     * True on a fresh agent, and also on an installed one when a zip with a NEW setup code was uploaded over it
     * (only someone who can write files on the host can do that, so it counts as proof of ownership).
     */
    public function setupPending(): bool
    {
        if (!$this->agent->installed()) {
            return true;
        }
        $file = $this->agent->agentDir . '/wpm-setup.php';
        if (!is_file($file)) {
            return false;
        }
        $v = include $file;
        if (!is_string($v) || strlen($v) < 12) {
            return false;
        }

        return !hash_equals((string) ($this->agent->config()['setup_used'] ?? ''), hash('sha256', $v));
    }

    /**
     * One-field setup: the setup code alone. Creates the agent (no password to remember, the Studio is the way in),
     * drops every old session and connection when it replaces an earlier install, and returns a one-time pairing code.
     *
     * @return array{error:?string,code?:string,expires?:int}
     */
    public function quickInstall(Request $req, string $token, bool $allowHttp): array
    {
        $key = 'setup:' . $req->ip();
        if (Security::lockedFor($this->agent->store, $key) > 0) {
            return ['error' => 'locked'];
        }
        if (!$this->setupPending()) {
            return ['error' => 'already_installed'];
        }
        $expected = $this->setupToken();
        if (!hash_equals($expected, strtoupper(trim($token)))) {
            Security::fail($this->agent->store, $key);
            return ['error' => 'bad_setup_code'];
        }
        if (!$req->isSecure() && !$req->isLoopback() && !$allowHttp) {
            return ['error' => 'https_required'];
        }
        $used = hash('sha256', $expected);
        $allow = $allowHttp && !$req->isSecure();
        $this->agent->store->update('config', static function (array $c) use ($used, $allow) {
            $base = ['version' => 1, 'roots' => [], 'keep_releases' => 5, 'max_upload_mb' => 256];

            return array_merge($base, $c, [
                'installed_at' => Util::now(), 'allow_http' => $allow, 'setup_used' => $used,
                'admin' => ['user' => 'studio', 'hash' => self::hash(Util::random(24)), 'totp' => null, 'last_totp_step' => 0],
            ]);
        });
        foreach (['sessions', 'connections', 'pairing'] as $name) {
            $this->agent->store->write($name, []);
        }
        $this->agent->setConfig($this->agent->store->read('config'));
        @unlink($this->agent->agentDir . '/wpm-setup.php');
        @unlink($this->agent->store->path('setup'));
        $this->agent->audit('studio', 'setup', 'agent installed', $req->ip());
        $p = $this->createPairing('admin', 'setup', 1800);

        return ['error' => null, 'code' => $p['code'], 'expires' => $p['expires']];
    }

    // ---- login / sessions ---------------------------------------------------------------------------------------

    /** @return array{error:?string,cookie:?string,stage:?string,wait:int} */
    public function login(Request $req, string $user, string $password): array
    {
        $store = $this->agent->store;
        $uKey = 'u:' . strtolower($user);
        $ipKey = 'ip:' . $req->ip();
        $wait = max(Security::lockedFor($store, $uKey), Security::lockedFor($store, $ipKey));
        if ($wait > 0) {
            return ['error' => 'locked', 'cookie' => null, 'stage' => null, 'wait' => $wait];
        }
        $admin = $this->agent->config()['admin'] ?? [];
        $known = isset($admin['user']) && strcasecmp((string) $admin['user'], $user) === 0;
        $dummy = '$2y$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
        $ok = self::verify($password, $known ? (string) $admin['hash'] : $dummy) && $known;
        if (!$ok) {
            Security::fail($store, $uKey);
            Security::fail($store, $ipKey);
            $this->agent->audit($user, 'login.fail', '', $req->ip());
            return ['error' => 'bad_login', 'cookie' => null, 'stage' => null, 'wait' => 0];
        }
        Security::clear($store, $uKey);
        $stage = empty($admin['totp']) ? 'ok' : 'totp';
        $cookie = $this->startSession($req, (string) $admin['user'], $stage);
        if ($stage === 'ok') {
            $this->agent->audit((string) $admin['user'], 'login', '', $req->ip());
        }

        return ['error' => null, 'cookie' => $cookie, 'stage' => $stage, 'wait' => 0];
    }

    public function verifyTotp(Request $req, string $code): ?string
    {
        $session = $this->session($req, true);
        if (!$session || $session['stage'] !== 'totp') {
            return 'no_session';
        }
        $key = 't:' . strtolower($session['user']);
        $wait = Security::lockedFor($this->agent->store, $key);
        if ($wait > 0) {
            return 'locked';
        }
        $admin = $this->agent->config()['admin'];
        $step = Security::totpVerify((string) $admin['totp'], $code, (int) ($admin['last_totp_step'] ?? 0));
        if ($step === null) {
            Security::fail($this->agent->store, $key);
            Security::fail($this->agent->store, 'ip:' . $req->ip());
            $this->agent->audit($session['user'], 'totp.fail', '', $req->ip());
            return 'bad_code';
        }
        Security::clear($this->agent->store, $key);
        $this->agent->updateConfig(static function (array $c) use ($step) {
            $c['admin']['last_totp_step'] = $step;
            return $c;
        });
        $sid = $this->sid($req);
        $this->agent->store->update('sessions', static function (array $all) use ($sid) {
            $h = hash('sha256', $sid);
            if (isset($all[$h])) {
                $all[$h]['stage'] = 'ok';
                $all[$h]['last'] = Util::now();
            }
            return $all;
        });
        $this->agent->audit($session['user'], 'login', '2fa', $req->ip());

        return null;
    }

    private function sid(Request $req): string
    {
        $sid = $req->cookies['wpm_sid'] ?? '';

        return preg_match('/^[a-f0-9]{48}$/', $sid) ? $sid : '';
    }

    private function cookiePath(Request $req): string
    {
        $dir = rtrim(str_replace('\\', '/', dirname($req->server['SCRIPT_NAME'] ?? '/index.php')), '/');

        return $dir === '' ? '/' : $dir . '/';
    }

    private function startSession(Request $req, string $user, string $stage): string
    {
        $sid = Util::random(24);
        $this->agent->store->update('sessions', static function (array $all) use ($sid, $user, $stage) {
            foreach ($all as $h => $s) {
                if ($s['created'] < Util::now() - self::ABSOLUTE || $s['last'] < Util::now() - self::IDLE) {
                    unset($all[$h]);
                }
            }
            $all[hash('sha256', $sid)] = ['user' => $user, 'stage' => $stage, 'csrf' => Util::random(16), 'created' => Util::now(), 'last' => Util::now()];
            return $all;
        });

        return $this->cookieHeader($req, 'wpm_sid', $sid, 0);
    }

    public function cookieHeader(Request $req, string $name, string $value, int $maxAge): string
    {
        return $name . '=' . $value . '; Path=' . $this->cookiePath($req) . '; HttpOnly; SameSite=Strict' . ($req->isSecure() ? '; Secure' : '') . ($maxAge > 0 ? '; Max-Age=' . $maxAge : '');
    }

    /** @return array{user:string,stage:string,csrf:string}|null */
    public function session(Request $req, bool $allowPartial = false): ?array
    {
        $sid = $this->sid($req);
        if ($sid === '') {
            return null;
        }
        $s = $this->agent->store->read('sessions')[hash('sha256', $sid)] ?? null;
        if (!$s || $s['created'] < Util::now() - self::ABSOLUTE || $s['last'] < Util::now() - ($s['stage'] === 'totp' ? 300 : self::IDLE)) {
            return null;
        }
        if ($s['stage'] !== 'ok' && !$allowPartial) {
            return null;
        }
        return $s;
    }

    public function logout(Request $req): string
    {
        $sid = $this->sid($req);
        if ($sid !== '') {
            $this->agent->store->update('sessions', static function (array $all) use ($sid) {
                unset($all[hash('sha256', $sid)]);
                return $all;
            });
        }
        return $this->cookieHeader($req, 'wpm_sid', 'x', 0) . '; Max-Age=0';
    }

    /** Same-site POST with the session's token. */
    public function csrfOk(Request $req, ?array $session): bool
    {
        if (!$session || !hash_equals($session['csrf'], $req->post('csrf'))) {
            return false;
        }
        $origin = $req->header('origin');
        if ($origin !== '' && strcasecmp((string) parse_url($origin, PHP_URL_HOST) . (parse_url($origin, PHP_URL_PORT) ? ':' . parse_url($origin, PHP_URL_PORT) : ''), $req->host()) !== 0) {
            return false;
        }
        return true;
    }

    public function changePassword(string $user, string $current, string $new, string $confirm): ?string
    {
        $admin = $this->agent->config()['admin'];
        if (!self::verify($current, (string) $admin['hash'])) {
            return 'bad_login';
        }
        if ($new !== $confirm) {
            return 'password_mismatch';
        }
        if (self::passwordProblem($user, $new) !== null) {
            return 'weak_password';
        }
        $this->agent->updateConfig(static function (array $c) use ($new) {
            $c['admin']['hash'] = self::hash($new);
            return $c;
        });
        $this->agent->store->write('sessions', []);
        $this->agent->audit($user, 'password.change');

        return null;
    }

    // ---- connections (Studio) -----------------------------------------------------------------------------------

    /** One-time pairing code, valid ten minutes. */
    public function createPairing(string $level, string $actor, int $ttl = 600): array
    {
        if (!isset(self::LEVELS[$level])) {
            $level = 'admin';
        }
        $code = Util::friendlyCode('WPMA');
        $this->agent->store->update('pairing', static function (array $all) use ($code, $level, $ttl) {
            $all = array_values(array_filter($all, static fn ($r) => $r['expires'] > Util::now()));
            $all[] = ['hash' => hash('sha256', $code), 'level' => $level, 'expires' => Util::now() + $ttl];
            return $all;
        });
        $this->agent->audit($actor, 'pairing.code', 'level ' . $level);

        return ['code' => $code, 'expires' => Util::now() + $ttl, 'level' => $level];
    }

    /** @return array{key_id:string,secret:string,level:string} */
    public function pair(Request $req, string $code, string $name): array
    {
        $key = 'pair:' . $req->ip();
        if (Security::lockedFor($this->agent->store, $key) > 0) {
            throw new ApiError('locked', 'Too many wrong codes. Try again later.', 429);
        }
        $hash = hash('sha256', strtoupper(trim($code)));
        $level = $this->agent->store->update('pairing', static function (array $all, &$out) use ($hash) {
            $keep = [];
            foreach ($all as $r) {
                if ($r['expires'] > Util::now() && hash_equals($r['hash'], $hash)) {
                    $out = $r['level'];
                    continue;
                }
                if ($r['expires'] > Util::now()) {
                    $keep[] = $r;
                }
            }
            return $keep;
        });
        if (!is_string($level)) {
            Security::fail($this->agent->store, $key);
            throw new ApiError('bad_code', 'The pairing code is wrong or expired. Make a new one in the agent panel.', 403);
        }
        $keyId = 'k' . Util::random(6);
        $secret = Util::random(32);
        $this->agent->store->update('connections', static function (array $all) use ($keyId, $secret, $level, $name) {
            $all[$keyId] = ['name' => substr($name !== '' ? $name : 'Studio', 0, 60), 'secret' => $secret, 'level' => $level, 'sites' => '*', 'created' => Util::now(), 'last_used' => 0, 'revoked' => false];
            return $all;
        });
        $this->agent->audit($name ?: 'studio', 'pair', $keyId . ' level ' . $level, $req->ip());

        return ['key_id' => $keyId, 'secret' => $secret, 'level' => $level];
    }

    /** @return array<string,mixed>|null */
    public function connection(string $keyId): ?array
    {
        $c = $this->agent->store->read('connections')[$keyId] ?? null;

        return $c && empty($c['revoked']) ? $c + ['key_id' => $keyId] : null;
    }

    public function touch(string $keyId): void
    {
        $c = $this->agent->store->read('connections')[$keyId] ?? null;
        if ($c && $c['last_used'] < Util::now() - 60) {
            $this->agent->store->update('connections', static function (array $all) use ($keyId) {
                if (isset($all[$keyId])) {
                    $all[$keyId]['last_used'] = Util::now();
                }
                return $all;
            });
        }
    }

    public function revoke(string $keyId, string $actor): void
    {
        $this->agent->store->update('connections', static function (array $all) use ($keyId) {
            if (isset($all[$keyId])) {
                $all[$keyId]['revoked'] = true;
                $all[$keyId]['secret'] = '';
            }
            return $all;
        });
        $this->agent->audit($actor, 'connection.revoke', $keyId);
    }

    /** @return list<array<string,mixed>> without secrets */
    public function connections(): array
    {
        $out = [];
        foreach ($this->agent->store->read('connections') as $id => $c) {
            $out[] = ['key_id' => $id, 'name' => $c['name'], 'level' => $c['level'], 'created' => $c['created'], 'last_used' => $c['last_used'], 'revoked' => !empty($c['revoked'])];
        }
        return $out;
    }

    // ---- 2FA management -----------------------------------------------------------------------------------------

    public function totpBegin(): string
    {
        $secret = Security::totpSecret();
        $this->agent->store->write('totp-pending', ['secret' => $secret, 'created' => Util::now()]);

        return $secret;
    }

    public function totpConfirm(string $user, string $code): bool
    {
        $pending = $this->agent->store->read('totp-pending');
        if (empty($pending['secret']) || ($pending['created'] ?? 0) < Util::now() - 900) {
            return false;
        }
        $step = Security::totpVerify($pending['secret'], $code);
        if ($step === null) {
            return false;
        }
        $this->agent->updateConfig(static function (array $c) use ($pending, $step) {
            $c['admin']['totp'] = $pending['secret'];
            $c['admin']['last_totp_step'] = $step;
            return $c;
        });
        @unlink($this->agent->store->path('totp-pending'));
        $this->agent->audit($user, '2fa.enable');

        return true;
    }

    public function totpDisable(string $user): void
    {
        $this->agent->updateConfig(static function (array $c) {
            $c['admin']['totp'] = null;
            return $c;
        });
        $this->agent->audit($user, '2fa.disable');
    }
}
