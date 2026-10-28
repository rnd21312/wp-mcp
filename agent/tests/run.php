<?php
/**
 * Host Agent tests. No web server, no framework: php agent/tests/run.php
 * (The HTTP end-to-end test lives in gateway/test/agent.e2e.test.ts and drives a real `php -S`.)
 */
declare(strict_types=1);

error_reporting(E_ALL);
define('WPM_AGENT', true);
$src = dirname(__DIR__) . '/wpm-agent/src/';
foreach (['Util', 'ApiError', 'Store', 'Fs', 'Zip', 'Security', 'Http', 'Caps', 'Agent', 'Auth', 'Sites', 'Api', 'Panel'] as $f) {
    require $src . $f . '.php';
}

use WPM\Agent\Agent;
use WPM\Agent\Api;
use WPM\Agent\ApiError;
use WPM\Agent\Auth;
use WPM\Agent\Fs;
use WPM\Agent\Panel;
use WPM\Agent\Request;
use WPM\Agent\Security;
use WPM\Agent\Sites;
use WPM\Agent\Store;
use WPM\Agent\Util;
use WPM\Agent\Zip;

$GLOBALS['t'] = ['pass' => 0, 'fail' => 0, 'names' => []];

function check(bool $ok, string $label): void
{
    $GLOBALS['t'][$ok ? 'pass' : 'fail']++;
    if (!$ok) {
        echo "  FAIL: $label\n";
    }
}

function same(mixed $a, mixed $b, string $label): void
{
    check($a === $b, $label . ' (got ' . json_encode($a) . ', expected ' . json_encode($b) . ')');
}

function throwsCode(callable $fn, string $code, string $label): void
{
    try {
        $fn();
        check(false, $label . ' (no error, expected ' . $code . ')');
    } catch (ApiError $e) {
        check($e->errorCode === $code, $label . ' (got ' . $e->errorCode . ', expected ' . $code . ')');
    }
}

function section(string $name, callable $fn): void
{
    echo $name . "\n";
    try {
        $fn();
    } catch (Throwable $e) {
        check(false, $name . ' threw ' . get_class($e) . ': ' . $e->getMessage() . ' @' . basename($e->getFile()) . ':' . $e->getLine());
    }
}

function tmp(): string
{
    $d = sys_get_temp_dir() . '/wpm-test-' . bin2hex(random_bytes(5));
    mkdir($d, 0777, true);

    return realpath($d);
}

/** Builds a zip with raw control: [name => content], options per name via $opts[name]. */
function makeZip(array $files, array $opts = []): string
{
    $out = '';
    $central = '';
    $n = 0;
    foreach ($files as $name => $data) {
        $o = $opts[$name] ?? [];
        $method = $o['method'] ?? 8;
        $usize = $o['usize'] ?? strlen($data);
        $crc = $o['crc'] ?? crc32($data);
        $body = $method === 8 ? gzdeflate($data) : $data;
        $off = strlen($out);
        $out .= pack('VvvvvvVVVvv', 0x04034b50, 20, 0, $method, 0, 0, $crc, strlen($body), $usize, strlen($name), 0) . $name . $body;
        $made = $o['made'] ?? 20;
        $central .= pack('VvvvvvvVVVvvvvvVV', 0x02014b50, $made, 20, 0, $method, 0, 0, $crc, strlen($body), $usize, strlen($name), 0, 0, 0, 0, $o['eattr'] ?? 0, $off) . $name;
        $n++;
    }

    return $out . $central . pack('VvvvvVVv', 0x06054b50, 0, 0, $n, $n, strlen($central), strlen($out), 0);
}

function newAgent(): array
{
    $root = tmp();
    mkdir($root . '/public_html/wpm-agent', 0777, true);
    $agent = new Agent($root . '/public_html/wpm-agent', $root . '/wpm-data', $root . '/public_html');

    return [$agent, $root, $root . '/public_html'];
}

function req(string $method, string $route, string $body = '', array $headers = [], array $server = [], array $post = [], array $cookies = []): Request
{
    return new Request($method, $route, [], $post, $headers, $body, $server + ['REMOTE_ADDR' => '203.0.113.9', 'HTTPS' => 'on', 'HTTP_HOST' => 'host.test', 'SCRIPT_NAME' => '/wpm-agent/index.php'], [], $cookies);
}

function signed(string $secret, string $keyId, string $route, array|string $payload, ?int $ts = null, ?string $nonce = null): Request
{
    $body = is_array($payload) ? json_encode($payload) : $payload;
    $ts ??= Util::now();
    $nonce ??= bin2hex(random_bytes(16));
    $sig = Security::sign($secret, (string) $ts, $nonce, $keyId, 'POST', $route, $body);

    return req('POST', $route, $body, ['x-wpm-key' => $keyId, 'x-wpm-time' => (string) $ts, 'x-wpm-nonce' => $nonce, 'x-wpm-signature' => $sig]);
}

function installAgent(Agent $agent): Auth
{
    $auth = new Auth($agent);
    $token = $auth->setupToken();
    $err = $auth->install(req('POST', '/setup'), 'owner', 'correct horse battery', 'correct horse battery', $token, false);
    same($err, null, 'install succeeds');

    return $auth;
}

// ------------------------------------------------------------------------------------------------------------

section('base32 + TOTP (RFC 6238 vector)', function () {
    $secret = Util::base32Encode('12345678901234567890');
    same($secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'base32 encode');
    same(Util::base32Decode($secret), '12345678901234567890', 'base32 decode');
    same(Security::totpCode($secret, intdiv(59, 30)), '287082', 'RFC vector t=59');
    same(Security::totpCode($secret, intdiv(1111111109, 30)), '081804', 'RFC vector t=1111111109');
    Util::$now = 59;
    same(Security::totpVerify($secret, '287082'), 1, 'verify returns step');
    same(Security::totpVerify($secret, '287082', 1), null, 'same step cannot be reused');
    same(Security::totpVerify($secret, '000000'), null, 'wrong code');
    Util::$now = null;
});

section('signatures', function () {
    $s = 'secret';
    $sig = Security::sign($s, '1000', 'aaaaaaaaaaaaaaaa', 'k1', 'POST', '/api/v1/hello', '{}');
    same(Security::verify($s, '1000', 'aaaaaaaaaaaaaaaa', 'k1', 'POST', '/api/v1/hello', '{}', $sig, 1100), null, 'valid');
    same(Security::verify($s, '1000', 'aaaaaaaaaaaaaaaa', 'k1', 'POST', '/api/v1/hello', '{"x":1}', $sig, 1100), 'bad_signature', 'body tampering');
    same(Security::verify($s, '1000', 'aaaaaaaaaaaaaaaa', 'k1', 'POST', '/api/v1/deploy', '{}', $sig, 1100), 'bad_signature', 'route tampering');
    same(Security::verify($s, '1000', 'aaaaaaaaaaaaaaaa', 'k2', 'POST', '/api/v1/hello', '{}', $sig, 1100), 'bad_signature', 'key tampering');
    same(Security::verify($s, '1000', 'aaaaaaaaaaaaaaaa', 'k1', 'POST', '/api/v1/hello', '{}', $sig, 1400), 'stale_request', 'stale');
    same(Security::verify($s, '1000', 'zz', 'k1', 'POST', '/api/v1/hello', '{}', $sig, 1000), 'bad_nonce', 'bad nonce');
    // Must match what the gateway (Node) and the WordPress bridge compute.
    same(Security::sign('s3', '1700000000', 'abcdef0123456789', 'kid', 'POST', '/api/v1/hello', '{"a":1}'), hash_hmac('sha256', "1700000000\nabcdef0123456789\nkid\nPOST\n/api/v1/hello\n" . hash('sha256', '{"a":1}'), 's3'), 'signing string layout');
    $d = tmp() . '/n';
    check(Security::claimNonce($d, 'k', 'abc'), 'first nonce use');
    check(!Security::claimNonce($d, 'k', 'abc'), 'replay refused');
    check(Security::claimNonce($d, 'k2', 'abc'), 'nonce is per key');
});

section('path confinement', function () {
    foreach (['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', "a\0b", '', '..', 'a/./..', 'x/.. /y', '.../x', 'a/b:c', 'trailing.'] as $bad) {
        same(Fs::cleanRel($bad), null, 'rejects ' . json_encode($bad));
    }
    same(Fs::cleanRel('a/./b//c.txt'), 'a/b/c.txt', 'normalises');
    same(Fs::cleanRel('.well-known/x'), '.well-known/x', 'dot folders are fine');
    $root = tmp();
    mkdir($root . '/site');
    $outside = tmp();
    check(Fs::within($root . '/site', $root . '/site/a/b'), 'inside, not existing');
    check(!Fs::within($root . '/site', $root . '/other'), 'sibling');
    check(!Fs::within($root . '/site', $root . '/site/../other'), 'dot dot');
    if (@symlink($outside, $root . '/site/link')) {
        check(!Fs::within($root . '/site', $root . '/site/link/evil.txt'), 'symlink escape');
    }
});

section('zip extraction safety', function () {
    $d = tmp();
    $zip = $d . '/a.zip';
    file_put_contents($zip, makeZip(['index.html' => '<h1>hi</h1>', 'css/app.css' => 'a{}', 'big.txt' => str_repeat('x', 100000)]));
    mkdir($d . '/out');
    $r = Zip::extract($zip, $d . '/out', 10_000_000);
    same($r['files'], 3, 'three files');
    same(file_get_contents($d . '/out/css/app.css'), 'a{}', 'content');
    same($r['manifest']['index.html']['sha256'], hash('sha256', '<h1>hi</h1>'), 'manifest hash');

    file_put_contents($zip, makeZip(['site/index.html' => 'a', 'site/x.js' => 'b']));
    mkdir($d . '/out2');
    $r = Zip::extract($zip, $d . '/out2', 1_000_000);
    check(isset($r['manifest']['index.html']), 'single top folder is stripped');

    foreach (['../evil.txt', 'a/../../evil.txt', '/abs.txt', 'C:/x.txt'] as $i => $name) {
        file_put_contents($zip, makeZip([$name => 'x', 'ok.txt' => 'y']));
        mkdir($d . '/s' . $i);
        throwsCode(fn () => Zip::extract($zip, $d . '/s' . $i, 1_000_000), 'zip_unsafe_path', 'zip-slip ' . $name);
    }
    check(!file_exists($d . '/evil.txt'), 'nothing written outside');

    file_put_contents($zip, makeZip(['a.txt' => 'hello'], ['a.txt' => ['crc' => 123]]));
    mkdir($d . '/c1');
    throwsCode(fn () => Zip::extract($zip, $d . '/c1', 1_000_000), 'zip_crc', 'bad crc');

    file_put_contents($zip, makeZip(['a.txt' => str_repeat('A', 5000)], ['a.txt' => ['usize' => 10]]));
    mkdir($d . '/c2');
    throwsCode(fn () => Zip::extract($zip, $d . '/c2', 1_000_000), 'zip_bomb', 'entry larger than declared');

    file_put_contents($zip, makeZip(['a.txt' => str_repeat('A', 5000)]));
    mkdir($d . '/c3');
    throwsCode(fn () => Zip::extract($zip, $d . '/c3', 1000), 'zip_too_big', 'total size cap');

    file_put_contents($zip, makeZip(['ln' => '/etc/passwd'], ['ln' => ['made' => 3 << 8 | 20, 'eattr' => 0120777 << 16, 'method' => 0]]));
    mkdir($d . '/c4');
    throwsCode(fn () => Zip::extract($zip, $d . '/c4', 1000), 'zip_special', 'symlink entry');

    file_put_contents($zip, 'not a zip at all, definitely not');
    throwsCode(fn () => Zip::entries($zip), 'bad_zip', 'garbage');
});

section('store + guard', function () {
    $d = tmp();
    $s = new Store($d);
    $s->write('x', ['a' => 1]);
    same($s->read('x'), ['a' => 1], 'roundtrip');
    check(str_starts_with(file_get_contents($s->path('x')), Store::GUARD), 'guard line present');
    $s->update('x', function (array $v) {
        $v['a']++;
        return $v;
    });
    same($s->read('x')['a'], 2, 'update');
    $s->log('l', ['n' => 1]);
    $s->log('l', ['n' => 2]);
    same($s->tail('l', 1)[0]['n'], 2, 'tail newest first');
    same($s->read('missing', ['d' => 1]), ['d' => 1], 'default');
});

section('setup, login, lockout, 2FA', function () {
    [$agent] = newAgent();
    $auth = new Auth($agent);
    $token = $auth->setupToken();
    check(strlen($token) > 12, 'setup token generated');
    same($auth->install(req('POST', '/setup'), 'owner', 'correct horse battery', 'correct horse battery', 'WRONG', false), 'bad_setup_code', 'wrong setup code');
    same($auth->install(req('POST', '/setup'), 'owner', 'short', 'short', $token, false), 'weak_password', 'weak password');
    same($auth->install(req('POST', '/setup'), 'owner', 'correct horse battery', 'different horse battery', $token, false), 'password_mismatch', 'mismatch');
    same($auth->install(req('POST', '/setup', '', [], ['HTTPS' => '']), 'owner', 'correct horse battery', 'correct horse battery', $token, false), 'https_required', 'http refused');
    check(!$agent->installed(), 'still not installed after failures');
    same($auth->install(req('POST', '/setup'), 'owner', 'correct horse battery', 'correct horse battery', $token, false), null, 'install ok');
    check($agent->installed(), 'installed');
    same($auth->install(req('POST', '/setup'), 'x', 'correct horse battery', 'correct horse battery', $token, false), 'already_installed', 'no second install');
    check(!str_contains(file_get_contents($agent->store->path('config')), 'correct horse'), 'password is not stored');

    $ok = $auth->login(req('POST', '/login'), 'owner', 'correct horse battery');
    same($ok['error'], null, 'login ok');
    same($ok['stage'], 'ok', 'no 2fa yet');

    for ($i = 0; $i < 5; $i++) {
        $r = $auth->login(req('POST', '/login'), 'owner', 'wrong' . $i);
        same($r['error'], 'bad_login', 'bad login ' . $i);
    }
    $r = $auth->login(req('POST', '/login'), 'owner', 'correct horse battery');
    same($r['error'], 'locked', 'locked even with the right password');
    check($r['wait'] > 0, 'wait reported');
    Util::$now = time() + 1000;
    $r = $auth->login(req('POST', '/login'), 'owner', 'correct horse battery');
    same($r['error'], null, 'lock expires');
    Util::$now = null;
    $agent->store->write('throttle', []);

    // 2FA
    $secret = $auth->totpBegin();
    check(!$auth->totpConfirm('owner', '000000'), 'wrong code does not enable');
    $step = intdiv(Util::now(), 30);
    check($auth->totpConfirm('owner', Security::totpCode($secret, $step)), '2fa enabled');
    $r = $auth->login(req('POST', '/login'), 'owner', 'correct horse battery');
    same($r['stage'], 'totp', 'needs second step');
    $cookie = explode(';', $r['cookie'])[0];
    [$name, $val] = explode('=', $cookie, 2);
    $withCookie = req('POST', '/login', '', [], [], [], [$name => $val]);
    check($auth->session($withCookie) === null, 'partial session is not a session');
    same($auth->verifyTotp($withCookie, Security::totpCode($secret, $step)), 'bad_code', 'code reuse refused (same step as setup)');
    same($auth->verifyTotp($withCookie, Security::totpCode($secret, $step + 1)), null, 'next step accepted');
    check($auth->session($withCookie) !== null, 'full session after 2fa');
    check($auth->csrfOk(req('POST', '/x', '', [], [], ['csrf' => $auth->session($withCookie)['csrf']]), $auth->session($withCookie)), 'csrf ok');
    check(!$auth->csrfOk(req('POST', '/x', '', [], [], ['csrf' => 'nope']), $auth->session($withCookie)), 'csrf bad');
    check(!$auth->csrfOk(req('POST', '/x', '', ['origin' => 'https://evil.test'], [], ['csrf' => $auth->session($withCookie)['csrf']]), $auth->session($withCookie)), 'cross-origin post refused');
});

section('pairing + signed API', function () {
    [$agent] = newAgent();
    $auth = installAgent($agent);
    $sites = new Sites($agent);
    $api = new Api($agent, $auth, $sites);

    $p = $auth->createPairing('admin', 'owner');
    $res = $api->handle(req('POST', '/api/v1/pair', json_encode(['code' => 'WPMA-WRONG-WRONG-WRONG', 'name' => 'T'])));
    same($res->status, 403, 'wrong pairing code');
    $res = $api->handle(req('POST', '/api/v1/pair', json_encode(['code' => $p['code'], 'name' => 'Studio'])));
    same($res->status, 200, 'pairing works');
    $cred = json_decode($res->body, true)['data'];
    $res2 = $api->handle(req('POST', '/api/v1/pair', json_encode(['code' => $p['code'], 'name' => 'Again'])));
    same($res2->status, 403, 'pairing code is single use');

    $r = signed($cred['secret'], $cred['key_id'], '/api/v1/hello', []);
    $res = $api->handle($r);
    same($res->status, 200, 'signed hello');
    same($res->headers['X-Wpm-Signature'], Security::responseSignature($cred['secret'], $r->header('x-wpm-nonce'), $res->body), 'reply is signed');
    same($api->handle($r)->status, 401, 'replay of the same request');
    same(json_decode($api->handle($r)->body, true)['error']['code'], 'replay', 'replay code');

    $bad = signed('wrong-secret', $cred['key_id'], '/api/v1/hello', []);
    same(json_decode($api->handle($bad)->body, true)['error']['code'], 'bad_signature', 'wrong secret');
    $old = signed($cred['secret'], $cred['key_id'], '/api/v1/hello', [], Util::now() - 1000);
    same(json_decode($api->handle($old)->body, true)['error']['code'], 'stale_request', 'stale timestamp');
    $unk = signed($cred['secret'], 'knope', '/api/v1/hello', []);
    same(json_decode($api->handle($unk)->body, true)['error']['code'], 'unknown_key', 'unknown key');
    same($api->handle(req('POST', '/api/v1/hello', '{}', [], ['HTTPS' => '', 'REMOTE_ADDR' => '198.51.100.7']))->status, 403, 'plain http refused for remote clients');

    // Read-only connection cannot create sites.
    $p2 = $auth->createPairing('read', 'owner');
    $c2 = json_decode($api->handle(req('POST', '/api/v1/pair', json_encode(['code' => $p2['code']])))->body, true)['data'];
    $res = $api->handle(signed($c2['secret'], $c2['key_id'], '/api/v1/sites.create', ['name' => 'x']));
    same(json_decode($res->body, true)['error']['code'], 'level_too_low', 'level enforced');
    $auth->revoke($c2['key_id'], 'owner');
    same(json_decode($api->handle(signed($c2['secret'], $c2['key_id'], '/api/v1/hello', []))->body, true)['error']['code'], 'unknown_key', 'revoked key');

    // Brute-forcing signatures locks the address.
    for ($i = 0; $i < 6; $i++) {
        $api->handle(signed('nope', 'k-nope', '/api/v1/hello', []));
    }
    same($api->handle(signed($cred['secret'], $cred['key_id'], '/api/v1/hello', []))->status, 429, 'address locked after repeated bad signatures');
});

function deployZip(Sites $sites, string $siteId, array $files, string $keyId = 'k', string $note = ''): array
{
    $zip = tmp() . '/r.zip';
    file_put_contents($zip, makeZip($files));
    $uid = $sites->uploadFromFile($zip, $keyId);

    return $sites->deploy($siteId, $uid, $note, 'test', $keyId);
}

section('deploy: sync mode keeps foreign files, backs up, rolls back', function () {
    [$agent, $root, $web] = newAgent();
    installAgent($agent);
    $sites = new Sites($agent);
    mkdir($web . '/demo');
    file_put_contents($web . '/demo/keep.txt', 'mine');
    file_put_contents($web . '/demo/index.html', 'OLD HAND MADE');
    $site = $sites->create(['name' => 'Demo', 'kind' => 'static', 'folder' => 'demo', 'mode' => 'sync'], 'test');
    same($site['mode'], 'sync', 'sync mode');
    $r1 = deployZip($sites, 'demo', ['index.html' => 'v1', 'a.css' => 'a1', 'old.js' => 'x']);
    same(file_get_contents($web . '/demo/index.html'), 'v1', 'index deployed');
    same(file_get_contents($web . '/demo/keep.txt'), 'mine', 'foreign file kept');
    check(is_file($agent->dataDir . '/sites/demo/backups/' . $r1['id'] . '/index.html'), 'overwritten foreign file was backed up');
    same(file_get_contents($agent->dataDir . '/sites/demo/backups/' . $r1['id'] . '/index.html'), 'OLD HAND MADE', 'backup content');
    $r2 = deployZip($sites, 'demo', ['index.html' => 'v2', 'a.css' => 'a2', 'sub/new.js' => 'n']);
    same(file_get_contents($web . '/demo/index.html'), 'v2', 'v2 live');
    check(!file_exists($web . '/demo/old.js'), 'file removed by the new release is gone');
    check(is_file($web . '/demo/sub/new.js'), 'new nested file');
    same(file_get_contents($web . '/demo/keep.txt'), 'mine', 'foreign file still kept');
    $back = $sites->rollback('demo', null, 'test');
    same($back['current'], $r1['id'], 'rolled back to v1');
    same(file_get_contents($web . '/demo/index.html'), 'v1', 'v1 live again');
    check(is_file($web . '/demo/old.js') && !file_exists($web . '/demo/sub'), 'v1 file set restored, v2-only folder removed');
    $sites->rollback('demo', $r2['id'], 'test');
    same(file_get_contents($web . '/demo/index.html'), 'v2', 'forward to v2');
    throwsCode(fn () => $sites->rollback('demo', $r2['id'], 'test'), 'already_current', 'cannot roll back to current');
    check(count(glob($web . '/demo/*.wpm-tmp')) === 0, 'no temp files left');
    $list = $sites->releases('demo');
    same(count($list['releases']), 2, 'two releases listed');
    same($list['current'], $r2['id'], 'current tracked');
});

section('deploy: symlink mode is atomic and prunes', function () {
    [$agent, $root, $web] = newAgent();
    installAgent($agent);
    $sites = new Sites($agent);
    $site = $sites->create(['name' => 'Link', 'kind' => 'spa', 'folder' => 'link', 'mode' => 'auto'], 'test');
    if ($site['mode'] !== 'symlink') {
        echo "  (symlinks unavailable here, skipped)\n";
        return;
    }
    $agent->updateConfig(function (array $c) {
        $c['keep_releases'] = 3;
        return $c;
    });
    $ids = [];
    for ($i = 1; $i <= 5; $i++) {
        $ids[] = deployZip($sites, 'link', ['index.html' => "v$i"], 'k', "n$i")['id'];
        usleep(1100000 / 5);
    }
    check(is_link($web . '/link'), 'live folder is a symlink');
    same(file_get_contents($web . '/link/index.html'), 'v5', 'v5 live');
    check(str_contains(file_get_contents($web . '/link/.htaccess'), 'RewriteRule . index.html'), 'spa fallback written');
    same(count($sites->releases('link')['releases']), 3, 'old releases pruned');
    $sites->rollback('link', null, 'test');
    same(file_get_contents($web . '/link/index.html'), 'v4', 'rolled back');
    check(count(glob($web . '/link.wpm-*')) === 0, 'no leftover temp links');
    // existing non-empty folder cannot be symlinked
    mkdir($web . '/full');
    file_put_contents($web . '/full/x.txt', 'x');
    throwsCode(fn () => $sites->create(['name' => 'Full', 'folder' => 'full', 'mode' => 'symlink'], 't'), 'mode_unavailable', 'symlink refused on non-empty folder');
    $auto = $sites->create(['name' => 'Full', 'folder' => 'full', 'mode' => 'auto'], 't');
    same($auto['mode'], 'sync', 'auto falls back to sync');
});

section('deploy: policy and validation', function () {
    [$agent, $root, $web] = newAgent();
    installAgent($agent);
    $sites = new Sites($agent);
    $sites->create(['name' => 'S', 'folder' => 's', 'mode' => 'sync'], 't');
    foreach (['shell.php', 'a/b/x.phtml', '.htaccess', 'web.config', '.env', 'x/.git/config', 'backdoor.PHP'] as $bad) {
        throwsCode(fn () => deployZip($sites, 's', ['index.html' => 'ok', $bad => 'bad']), 'zip_rejected', 'rejects ' . $bad);
    }
    check(!file_exists($web . '/s/index.html'), 'a rejected release changes nothing');
    check(!is_dir($agent->dataDir . '/sites/s/releases') || count(glob($agent->dataDir . '/sites/s/releases/*')) === 0, 'rejected release is cleaned up');
    $sites->create(['name' => 'App', 'kind' => 'spa', 'folder' => 'app', 'mode' => 'sync'], 't');
    throwsCode(fn () => deployZip($sites, 'app', ['other.html' => 'x']), 'no_index', 'spa needs index.html');

    // site locations
    foreach (['../x', '/abs', 'wpm-agent', 'wpm-agent/inner', 'a/../..'] as $bad) {
        try {
            $sites->create(['name' => 'Bad', 'id' => 'bad' . substr(md5($bad), 0, 4), 'folder' => $bad, 'mode' => 'sync'], 't');
            check(false, 'folder ' . $bad . ' must be refused');
        } catch (ApiError $e) {
            check(in_array($e->errorCode, ['bad_folder', 'overlap'], true), 'folder ' . $bad . ' refused (' . $e->errorCode . ')');
        }
    }
    throwsCode(fn () => $sites->create(['name' => 'S', 'folder' => 'other'], 't'), 'exists', 'duplicate id');
    throwsCode(fn () => $sites->create(['name' => 'Z', 'folder' => 's'], 't'), 'overlap', 'same folder twice');
    throwsCode(fn () => $sites->create(['name' => 'K', 'kind' => 'php', 'folder' => 'k'], 't'), 'bad_kind', 'unsupported kind');
    throwsCode(fn () => $sites->create(['name' => 'R', 'folder' => 'r', 'root' => '/etc'], 't'), 'bad_root', 'root must be allowed');

    // uploads
    throwsCode(fn () => $sites->uploadBegin(0, str_repeat('a', 64), 'k'), 'upload_size', 'empty upload');
    throwsCode(fn () => $sites->uploadBegin(10, 'zz', 'k'), 'bad_hash', 'bad hash');
    $b = $sites->uploadBegin(5, hash('sha256', 'hello'), 'k1');
    $sites->uploadChunk($b['upload_id'], 0, 'hel', 'k1');
    $sites->uploadChunk($b['upload_id'], 1, 'lo', 'k1');
    throwsCode(fn () => $sites->uploadChunk($b['upload_id'], 2, 'x', 'other-key'), 'no_upload', 'another key cannot touch an upload');
    $f = $sites->uploadFinish($b['upload_id'], 2, 'k1');
    same($f['size'], 5, 'assembled');
    $b = $sites->uploadBegin(5, hash('sha256', 'hello'), 'k1');
    $sites->uploadChunk($b['upload_id'], 0, 'HELLO', 'k1');
    throwsCode(fn () => $sites->uploadFinish($b['upload_id'], 1, 'k1'), 'upload_corrupt', 'checksum mismatch');
    $b = $sites->uploadBegin(5, hash('sha256', 'hello'), 'k1');
    throwsCode(fn () => $sites->uploadFinish($b['upload_id'], 2, 'k1'), 'missing_chunk', 'missing chunk');
    throwsCode(fn () => $sites->uploadChunk('../../etc', 0, 'x', 'k1'), 'no_upload', 'upload id is validated');

    // delete keeps the site online unless purged
    deployZip($sites, 's', ['index.html' => 'live']);
    $sites->delete('s', false, 'test');
    same(file_get_contents($web . '/s/index.html'), 'live', 'delete without purge leaves files');
    check(!isset($sites->all()['s']), 'record removed');
});

section('panel pages render and enforce login', function () {
    [$agent] = newAgent();
    $auth = new Auth($agent);
    $sites = new Sites($agent);
    $panel = new Panel($agent, $auth, $sites);
    $res = $panel->handle(req('GET', '/'));
    same($res->status, 303, 'uninstalled agent sends you to setup');
    $res = $panel->handle(req('GET', '/setup'));
    check($res->status === 200 && str_contains($res->body, 'name="setup_code"'), 'setup page');
    check(!str_contains($res->body, $auth->setupToken()), 'setup page does not print the code');
    check(str_contains($res->headers['Content-Security-Policy'] ?? '', "default-src 'none'"), 'CSP on panel pages');
    installAgent($agent);
    $res = $panel->handle(req('GET', '/'));
    check($res->status === 303 && str_contains($res->headers['Location'], 'login'), 'dashboard needs login');
    $login = $auth->login(req('POST', '/login'), 'owner', 'correct horse battery');
    [$n, $v] = explode('=', explode(';', $login['cookie'])[0], 2);
    $res = $panel->handle(req('GET', '/', '', [], [], [], [$n => $v]));
    check($res->status === 200 && str_contains($res->body, 'Create site'), 'dashboard for a signed-in owner');
    $res = $panel->handle(req('POST', '/sites/create', '', [], [], ['name' => 'x', 'csrf' => 'bad'], [$n => $v]));
    same($res->status, 403, 'POST without CSRF token refused');
    $csrf = $auth->session(req('GET', '/', '', [], [], [], [$n => $v]))['csrf'];
    $res = $panel->handle(req('POST', '/sites/create', '', [], [], ['name' => 'My Site', 'kind' => 'static', 'folder' => 'my', 'csrf' => $csrf], [$n => $v]));
    same($res->status, 303, 'site created from the panel');
    $res = $panel->handle(req('GET', '/host', '', [], [], [], [$n => $v]));
    check($res->status === 200 && str_contains($res->body, 'php.version'), 'host page lists capabilities');
    $res = $panel->handle(req('GET', '/', '', ['accept-language' => 'fa-IR'], [], [], [$n => $v]));
    check(str_contains($res->body, 'dir="rtl"') && str_contains($res->body, 'سایت'), 'Persian + RTL by Accept-Language');
    // XSS: names are escaped
    $sites->create(['name' => '<script>alert(1)</script>', 'id' => 'xss', 'folder' => 'xss'], 't');
    $res = $panel->handle(req('GET', '/', '', [], [], [], [$n => $v]));
    check(!str_contains($res->body, '<script>alert(1)'), 'site names are escaped');
});

section('capabilities', function () {
    [$agent, , $web] = newAgent();
    $caps = $agent->caps();
    check($caps['php']['ok'], 'php ok');
    check($caps['extensions']['zlib'], 'zlib present');
    check($caps['limits']['chunk_bytes'] >= 262144, 'chunk size sane');
    same(\WPM\Agent\Caps::chunkBytes(8388608), 8388608 - 65536, 'chunk under post_max_size');
    same(\WPM\Agent\Caps::chunkBytes(1048576), 1048576 - 65536, 'small post_max_size');
    same(\WPM\Agent\Caps::chunkBytes(PHP_INT_MAX), 8388608, 'unlimited');
    check($caps['data_dir_outside_web_root'], 'data folder outside web root');
});

$t = $GLOBALS['t'];
echo "\n{$t['pass']} passed, {$t['fail']} failed\n";
exit($t['fail'] === 0 ? 0 : 1);
