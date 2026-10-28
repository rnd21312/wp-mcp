<?php
/**
 * Host Agent tests. No web server, no framework: php agent/tests/run.php
 * (The HTTP end-to-end test lives in gateway/test/agent.e2e.test.ts and drives a real `php -S`.)
 */
declare(strict_types=1);

error_reporting(E_ALL);
define('WPM_AGENT', true);
$src = dirname(__DIR__) . '/wpm-agent/src/';
foreach (['Util', 'ApiError', 'Store', 'Fs', 'Zip', 'Security', 'Http', 'Caps', 'Agent', 'Auth', 'Net', 'Db', 'NodeApp', 'Sites', 'Wp', 'Selftest', 'Update', 'Api', 'Panel'] as $f) {
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

use WPM\Agent\Db;
use WPM\Agent\Net;
use WPM\Agent\NodeApp;
use WPM\Agent\Update;
use WPM\Agent\Wp;

section('database provisioning through hosting-panel APIs (mocked transport)', function () {
    check(Db::ident('wp_ab12') && !Db::ident('a;drop') && !Db::ident('') && !Db::ident('a b'), 'identifier check');
    check(strlen(Db::randomPassword()) >= 30, 'generated password is long');
    $calls = [];
    Net::$transport = function (string $m, string $url, array $h, string $body, bool $verify) use (&$calls) {
        $calls[] = [$m, $url, $h, $body];
        return [200, json_encode(['status' => 1, 'errors' => null])];
    };
    $db = Db::provision(['method' => 'cpanel', 'url' => 'https://panel.test:2083', 'user' => 'alice', 'token' => 'TOK']);
    same(count($calls), 3, 'three UAPI calls');
    check(str_contains($calls[0][1], '/execute/Mysql/create_database?name=' . $db['name']), 'create_database');
    check(str_contains($calls[1][1], 'create_user') && str_contains($calls[1][1], 'password='), 'create_user');
    check(str_contains($calls[2][1], 'set_privileges_on_database') && str_contains($calls[2][1], 'ALL+PRIVILEGES'), 'privileges');
    same($calls[0][2]['Authorization'], 'cpanel alice:TOK', 'token header');
    check(str_starts_with($db['name'], 'alice_') && str_starts_with($db['user'], 'alice_') && strlen($db['user']) <= 16, 'cPanel prefixes and length');
    foreach ([['url' => 'http://panel.test:2083'], ['url' => 'https://panel.test:22'], ['url' => 'https://panel.test:2083', 'user' => 'bad user!']] as $bad) {
        throwsCode(fn () => Db::provision(array_merge(['method' => 'cpanel', 'user' => 'alice', 'token' => 'T'], $bad)), count($bad) === 1 ? 'panel_url' : 'cpanel_creds', 'bad cPanel input ' . json_encode($bad));
    }
    Net::$transport = fn () => [200, json_encode(['status' => 0, 'errors' => ['Database name too long']])];
    throwsCode(fn () => Db::provision(['method' => 'cpanel', 'url' => 'https://panel.test:2083', 'user' => 'alice', 'token' => 'T']), 'cpanel_failed', 'panel error is surfaced');

    $calls = [];
    Net::$transport = function ($m, $url, $h, $body) use (&$calls) {
        $calls[] = [$m, $url, $h, $body];
        return [200, 'error=0&text=Database+Created'];
    };
    $db = Db::provision(['method' => 'directadmin', 'url' => 'https://da.test:2222', 'user' => 'bob', 'key' => 'KEY']);
    same($calls[0][1], 'https://da.test:2222/CMD_API_DATABASES', 'DirectAdmin endpoint');
    same($calls[0][2]['Authorization'], 'Basic ' . base64_encode('bob:KEY'), 'DirectAdmin login key');
    check(str_contains($calls[0][3], 'action=create') && str_starts_with($db['name'], 'bob_'), 'DirectAdmin create + prefix');
    Net::$transport = fn () => [200, 'error=1&text=Quota+exceeded'];
    throwsCode(fn () => Db::provision(['method' => 'directadmin', 'url' => 'https://da.test:2222', 'user' => 'bob', 'key' => 'K']), 'da_failed', 'DirectAdmin error');
    throwsCode(fn () => Net::request('GET', 'http://insecure.test/'), 'https_only', 'outbound http refused');
    throwsCode(fn () => Db::provision(['method' => 'nope']), 'db_method', 'unknown method');
    throwsCode(fn () => Db::provision(['method' => 'manual', 'host' => '127.0.0.1:1', 'name' => 'x', 'user' => 'y']), extension_loaded('pdo_mysql') ? 'db_connect' : 'no_pdo_mysql', 'unreachable database fails before anything is written');
    Net::$transport = null;
});

/** A tiny stand-in for the official WordPress download. */
function fakeCore(): array
{
    $zip = makeZip([
        'wordpress/index.php' => '<?php // wp',
        'wordpress/wp-settings.php' => '<?php // settings',
        'wordpress/wp-includes/version.php' => "<?php\n\$wp_version = '6.9.1';\n",
        'wordpress/wp-content/plugins/index.php' => '<?php // silence',
    ]);

    return [$zip, sha1($zip)];
}

section('WordPress provisioning: core, config, bridge, finish', function () {
    // wp-config round trip with hostile characters
    $db = ['host' => 'db.test:3307', 'name' => 'n', 'user' => "u'ser", 'pass' => "p\\ass'w\"ord\$x"];
    $cfg = Wp::configText($db, 'wpab_');
    $back = Wp::parseConfig($cfg);
    same([$back['user'], $back['pass'], $back['host'], $back['port'], $back['prefix']], ["u'ser", "p\\ass'w\"ord\$x", 'db.test', 3307, 'wpab_'], 'wp-config round trip');
    check(substr_count($cfg, "define('AUTH_KEY'") === 1 && preg_match("/define\('NONCE_SALT', '[a-f0-9]{64}'\)/", $cfg) === 1, 'fresh salts');
    check(str_contains(shell_exec('php -l ' . escapeshellarg(tap($cfg))) ?? '', 'No syntax errors'), 'generated wp-config is valid PHP');

    [$agent, $root, $web] = newAgent();
    installAgent($agent);
    $sites = new Sites($agent);
    $wp = new Wp($agent, $sites);
    [$coreZip, $coreSha] = fakeCore();
    $serve = function (string $sum) use ($coreZip) {
        return function (string $m, string $url) use ($coreZip, $sum) {
            if ($url === Wp::CORE_SHA1) {
                return [200, $sum . "  latest.zip\n"];
            }
            if ($url === Wp::CORE_URL) {
                return [200, $coreZip];
            }
            return [404, ''];
        };
    };
    Db::$override = fn (array $spec) => ['host' => 'localhost', 'name' => 'wpdb', 'user' => 'wpuser', 'pass' => 'S3cr3t'];
    $bridge = tmp() . '/bridge.zip';
    file_put_contents($bridge, makeZip(['wp-mcp-bridge/wp-mcp-bridge.php' => '<?php // bridge', 'wp-mcp-bridge/includes/Api.php' => '<?php']));

    // bad checksum: nothing is installed
    Net::$transport = $serve(str_repeat('0', 40));
    $site = $sites->create(['name' => 'Blog', 'kind' => 'wordpress', 'folder' => 'blog'], 't');
    same($site['mode'], 'sync', 'wordpress sites are live installs');
    throwsCode(fn () => $wp->install($site, ['method' => 'manual'], null, 't'), 'core_corrupt', 'checksum mismatch');
    check(!is_dir($web . '/blog') || Fs::isEmptyDir($web . '/blog'), 'nothing written after a corrupt download');

    // database failure: no files, no download
    Net::$transport = function () { throw new Exception('must not download'); };
    Db::$override = function () { throw new ApiError('db_connect', 'nope'); };
    throwsCode(fn () => $wp->install($site, ['method' => 'manual'], null, 't'), 'db_connect', 'database first');
    check(!is_dir($web . '/blog'), 'no folder when the database fails');

    Db::$override = fn (array $spec) => ['host' => 'localhost', 'name' => 'wpdb', 'user' => 'wpuser', 'pass' => 'S3cr3t'];
    Net::$transport = $serve($coreSha);
    $out = $wp->install($site, ['method' => 'manual'], $bridge, 't');
    same($out['wp_version'], '6.9.1', 'version detected');
    check(is_file($web . '/blog/wp-settings.php') && is_file($web . '/blog/wp-config.php'), 'core + config in place');
    check(is_file($web . '/blog/wp-content/plugins/wp-mcp-bridge/wp-mcp-bridge.php'), 'bridge copied into plugins');
    same(Wp::parseConfig(file_get_contents($web . '/blog/wp-config.php'))['pass'], 'S3cr3t', 'credentials in wp-config');
    check(!str_contains(json_encode($out), 'S3cr3t'), 'password is never returned');
    throwsCode(fn () => $wp->install($site, ['method' => 'manual'], null, 't'), 'already_installed', 'no second install over it');
    throwsCode(fn () => deployZip($sites, 'blog', ['index.html' => 'x']), 'not_deployable', 'wordpress sites are not release-deployed');

    // finish, against an in-memory SQLite standing in for the WordPress database
    $pdo = new PDO('sqlite::memory:');
    $pdo->exec('CREATE TABLE wpab_users (ID INTEGER PRIMARY KEY, user_login TEXT)');
    $pdo->exec('CREATE TABLE wpab_options (option_id INTEGER PRIMARY KEY, option_name TEXT UNIQUE, option_value TEXT, autoload TEXT)');
    throwsCode(fn () => $wp->finish($site, 'owner', 'admin', 't', $pdo, 'wpab_'), 'no_admin', 'finish before the installer ran');
    $pdo->exec("INSERT INTO wpab_users (ID, user_login) VALUES (7, 'owner')");
    Wp::setOption($pdo, 'wpab_', 'active_plugins', serialize(['akismet/akismet.php']));
    $res = $wp->finish($site, 'owner', 'live', 't', $pdo, 'wpab_');
    check((bool) preg_match('/^WPMP-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/', $res['pairing_code']), 'pairing code format');
    $active = unserialize(Wp::option($pdo, 'wpab_', 'active_plugins'));
    same($active, ['akismet/akismet.php', 'wp-mcp-bridge/wp-mcp-bridge.php'], 'bridge activated, others kept');
    $pairing = unserialize(Wp::option($pdo, 'wpab_', 'wpm_bridge_pairing'));
    // the bridge verifies: hash('sha256', normalize_code(code)) where normalize strips non-alphanumerics and uppercases
    same($pairing['hash'], hash('sha256', strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $res['pairing_code']))), 'hash matches the bridge verification');
    same([$pairing['user'], $pairing['ceiling'], $pairing['attempts']], [7, 'live', 0], 'pairing record');
    $wp->finish($site, 'owner', 'admin', 't', $pdo, 'wpab_');
    same(count(unserialize(Wp::option($pdo, 'wpab_', 'active_plugins'))), 2, 'activation is idempotent');
    check($agent->store->read('sites')['blog']['wp']['installed'] === true, 'site marked installed');

    // non-empty folder is refused
    mkdir($web . '/occupied');
    file_put_contents($web . '/occupied/x.txt', 'x');
    $busy = $sites->create(['name' => 'Busy', 'kind' => 'wordpress', 'folder' => 'occupied'], 't');
    throwsCode(fn () => $wp->install($busy, ['method' => 'manual'], null, 't'), 'target_not_empty', 'will not install over other files');
    Net::$transport = null;
    Db::$override = null;
});

section('Node.js sites: deploy, env, restart signal, server script', function () {
    [$agent, $root, $web] = newAgent();
    installAgent($agent);
    $sites = new Sites($agent);
    // an allowed location outside the web root, inside the "home"
    mkdir($root . '/nodeapps');
    $added = $agent->addRoot($root . '/nodeapps', 't');
    check(in_array($added, $agent->roots(), true), 'extra location allowed');
    foreach ([$root, '/', sys_get_temp_dir() . '/definitely-missing', $root . '/wpm-agent-data'] as $bad) {
        try {
            $agent->addRoot($bad, 't');
            check(false, 'root ' . $bad . ' must be refused');
        } catch (ApiError $e) {
            check($e->errorCode === 'bad_root', 'root refused: ' . basename($bad));
        }
    }
    $site = $sites->create(['name' => 'Shop App', 'kind' => 'node', 'root' => $added, 'folder' => 'shop', 'mode' => 'sync', 'docroot' => 'shop-public', 'startup' => 'server.js', 'port' => 24001], 't');
    same($site['node']['startup'], 'server.js', 'node settings stored');
    foreach ([['startup' => '../x.js'], ['startup' => 'run.sh'], ['port' => 80], ['port' => 70000]] as $badIn) {
        throwsCode(fn () => $sites->create(array_merge(['name' => 'N' . random_int(1, 99999), 'kind' => 'node', 'root' => $added, 'folder' => 'n' . random_int(1, 99999)], $badIn), 't'), isset($badIn['port']) ? 'bad_port' : 'bad_startup', 'node input ' . json_encode($badIn));
    }
    $inWeb = $sites->create(['name' => 'Exposed', 'kind' => 'node', 'folder' => 'exposed', 'mode' => 'sync'], 't');
    check(count($inWeb['warnings']) === 1, 'warns when the app folder is inside the web root');

    throwsCode(fn () => deployZip($sites, 'shop-app', ['package.json' => '{}']), 'no_startup', 'startup file must be in the archive');
    foreach (['index.php', 'x/y.phtml', '.htaccess', '.env', 'web.config', 'a/.git/config'] as $badName) {
        throwsCode(fn () => deployZip($sites, 'shop-app', ['server.js' => 'x', $badName => 'bad']), 'zip_rejected', 'node rejects ' . $badName);
    }
    $r1 = deployZip($sites, 'shop-app', ['server.js' => 'console.log(1)', 'node_modules/dep/install.sh' => '#!/bin/sh', 'node_modules/dep/index.js' => 'm', '.env.example' => 'A=1']);
    check(is_file($added . '/shop/server.js') && is_file($added . '/shop/node_modules/dep/install.sh'), 'files synced, including scripts that packages ship');
    check(is_file($added . '/shop/tmp/restart.txt'), 'Passenger restart marker');
    check(is_file($agent->dataDir . '/sites/shop-app/restart.txt'), 'systemd restart marker');
    $ht = file_get_contents($web . '/shop-public/.htaccess');
    check(str_contains($ht, 'PassengerAppType node') && str_contains($ht, 'PassengerAppRoot "' . $added . '/shop"') && str_contains($ht, 'PassengerStartupFile "server.js"'), 'Passenger config in the public folder');

    // env: stored privately, rendered, dangerous keys refused
    $res = $sites->setEnv('shop-app', ['DATABASE_URL' => 'mysql://u:p"w$@h/db', 'SECRET' => "a\\b"], 't');
    same($res['keys'], ['DATABASE_URL', 'SECRET'], 'env keys');
    $envFile = file_get_contents($agent->dataDir . '/sites/shop-app/env');
    check(str_contains($envFile, 'DATABASE_URL="mysql://u:p\\"w\\$@h/db"'), 'env file escapes quote and dollar');
    check(str_contains(file_get_contents($web . '/shop-public/.htaccess'), 'SetEnv SECRET "a\\\\b"'), 'SetEnv escapes backslash');
    check(!str_contains(json_encode($sites->view($sites->get('shop-app'))), 'mysql://'), 'view never shows env values');
    check(in_array('DATABASE_URL', $sites->view($sites->get('shop-app'))['node']['env_keys'], true), 'view lists env keys');
    foreach (['NODE_OPTIONS', 'LD_PRELOAD', 'PATH', 'node_options'] as $k) {
        throwsCode(fn () => $sites->setEnv('shop-app', [$k => 'x'], 't'), 'env_forbidden', 'forbidden env ' . $k);
    }
    throwsCode(fn () => $sites->setEnv('shop-app', ['1BAD' => 'x'], 't'), 'env_bad_name', 'bad env name');
    throwsCode(fn () => $sites->setEnv('shop-app', ['A' => "x\ny"], 't'), 'env_bad_value', 'newline in env value');
    $sites->create(['name' => 'Plain', 'kind' => 'static', 'folder' => 'plain', 'mode' => 'sync'], 't');
    throwsCode(fn () => $sites->setEnv('plain', ['A' => '1'], 't'), 'not_node', 'static sites have no env');

    // second deploy, rollback, restart signal moves
    $before = (string) file_get_contents($agent->dataDir . '/sites/shop-app/restart.txt');
    Util::$now = time() + 5;
    $r2 = deployZip($sites, 'shop-app', ['server.js' => 'console.log(2)']);
    Util::$now = null;
    check(!file_exists($added . '/shop/node_modules'), 'files of the old release are removed');
    same(file_get_contents($agent->dataDir . '/sites/shop-app/restart.txt') !== $before, true, 'restart marker refreshed');
    $sites->rollback('shop-app', null, 't');
    same(file_get_contents($added . '/shop/server.js'), 'console.log(1)', 'rollback restores the app');

    // the server script (built from a Linux-style description so it also runs on this Windows machine)
    $linux = ['id' => 'shop-app', 'name' => 'Shop App', 'target' => '/home/u/nodeapps/shop', 'node' => ['startup' => 'server.js', 'port' => 24001, 'docroot' => null]];
    $dd = '/home/u/wpm-agent-data';
    $gen = fn (string $d, string $u, bool $db) => NodeApp::vpsScript($linux, $d, $u, $dd . '/sites/shop-app', $db);
    $script = $gen('shop.example.com', 'appuser', true);
    foreach (['set -euo pipefail', 'User=appuser', 'Environment=PORT=24001', 'server_name shop.example.com;', 'proxy_pass http://127.0.0.1:24001;', 'PathChanged=' . $dd . '/sites/shop-app/restart.txt', 'EnvironmentFile=-' . $dd . '/sites/shop-app/env', 'mariadb-server', 'WorkingDirectory=/home/u/nodeapps/shop'] as $needle) {
        check(str_contains($script, $needle), 'script contains: ' . $needle);
    }
    check(str_contains($script, '$host') && !str_contains($script, '\\$host'), 'nginx variables are literal in the script');
    check(!str_contains($gen('shop.example.com', 'appuser', false), 'mariadb-server'), 'database is optional');
    foreach (['evil.com; rm -rf /', 'a b.com', 'localhost', "x.com\nroot", '$(id).com'] as $badDomain) {
        throwsCode(fn () => $gen($badDomain, 'appuser', false), 'bad_domain', 'domain ' . json_encode($badDomain));
    }
    throwsCode(fn () => $gen('a.example.com', 'root; reboot', false), 'bad_user', 'user name checked');
    throwsCode(fn () => $sites->nodeScript('plain', 'a.example.com', 'u', false), 'not_node', 'script only for node sites');
    $evil = $linux;
    $evil['target'] = '/home/u/app dir; rm -rf /';
    throwsCode(fn () => NodeApp::vpsScript($evil, 'a.example.com', 'u', $dd . '/sites/x', false), 'bad_path', 'unsafe paths are refused');
    check(str_starts_with($script, "#!/usr/bin/env bash\n"), 'script has a shebang');
    $lintFile = tap($script);
    $sh = trim((string) @shell_exec('bash -n ' . escapeshellarg($lintFile) . ' 2>&1'));
    check($sh === '', 'generated script passes bash -n' . ($sh !== '' ? ': ' . $sh : ''));
});

section('hosted panel: WordPress creation', function () {
    [$agent, $root, $web] = newAgent();
    $auth = installAgent($agent);
    $sites = new Sites($agent);
    $panel = new Panel($agent, $auth, $sites);
    // the bridge ships inside the agent zip
    mkdir($agent->agentDir . '/bridge/wp-mcp-bridge', 0777, true);
    file_put_contents($agent->agentDir . '/bridge/wp-mcp-bridge/wp-mcp-bridge.php', '<?php // bridge');
    $login = $auth->login(req('POST', '/login'), 'owner', 'correct horse battery');
    [$n, $v] = explode('=', explode(';', $login['cookie'])[0], 2);
    $csrf = $auth->session(req('GET', '/', '', [], [], [], [$n => $v]))['csrf'];
    $call = fn (string $m, string $route, array $post = []) => $panel->handle(req($m, $route, '', [], [], $post + ['csrf' => $csrf], [$n => $v]));

    $dash = $call('GET', '/');
    check(str_contains($dash->body, 'New WordPress site') && str_contains($dash->body, 'r=%2Fwordpress'), 'dashboard links to the WordPress form');
    check(!str_contains($dash->body, '<option value="wordpress">'), 'WordPress is not in the plain site-type list');
    $form = $call('GET', '/wordpress');
    check($form->status === 200 && str_contains($form->body, 'name="db_method"') && str_contains($form->body, 'cPanel'), 'form renders');

    [$coreZip, $coreSha] = fakeCore();
    Net::$transport = function (string $m, string $url) use ($coreZip, $coreSha) {
        return $url === Wp::CORE_SHA1 ? [200, $coreSha . "  latest.zip\n"] : ($url === Wp::CORE_URL ? [200, $coreZip] : [404, '']);
    };
    // a database failure leaves nothing behind
    Db::$override = function () { throw new ApiError('db_connect', 'Cannot connect to the database: wrong password'); };
    $bad = $call('POST', '/wordpress', ['name' => 'My Blog', 'db_method' => 'manual', 'db_host' => 'localhost', 'db_name' => 'x', 'db_user' => 'y']);
    check($bad->status === 200 && str_contains($bad->body, 'wrong password'), 'database error is shown');
    check(!isset($sites->all()['my-blog']) && !is_dir($web . '/my-blog'), 'no half-made site after a failure');

    Db::$override = fn (array $spec) => ['host' => 'localhost', 'name' => 'wpdb', 'user' => 'wpuser', 'pass' => 'S3cr3t'];
    $ok = $call('POST', '/wordpress', ['name' => 'My Blog', 'db_method' => 'cpanel', 'panel_user' => 'alice', 'panel_secret' => 'TOK']);
    same($ok->status, 303, 'created and redirected to the site page');
    check(is_file($web . '/my-blog/wp-settings.php') && is_file($web . '/my-blog/wp-config.php'), 'WordPress files written');
    check(is_file($web . '/my-blog/wp-content/plugins/wp-mcp-bridge/wp-mcp-bridge.php'), 'bridge copied from the agent');
    same($sites->all()['my-blog']['kind'], 'wordpress', 'site recorded as WordPress');
    $page = $call('GET', '/site?id=my-blog');
    $page = $panel->handle(new Request('GET', '/site', ['id' => 'my-blog'], [], [], '', ['REMOTE_ADDR' => '203.0.113.9', 'HTTPS' => 'on', 'HTTP_HOST' => 'host.test', 'SCRIPT_NAME' => '/wpm-agent/index.php'], [], [$n => $v]));
    check(str_contains($page->body, 'https://host.test/my-blog/wp-admin/install.php'), 'link to the WordPress installer');
    check(!str_contains($page->body, 'S3cr3t') && !str_contains($page->body, 'TOK'), 'no secrets on the page');
    check(!str_contains($page->body, 'name="zip"'), 'no release upload for a live WordPress site');

    // step 2: activate the bridge after the installer
    $pdo = new PDO('sqlite::memory:');
    $pdo->exec('CREATE TABLE wpx_users (ID INTEGER PRIMARY KEY, user_login TEXT)');
    $pdo->exec('CREATE TABLE wpx_options (option_id INTEGER PRIMARY KEY, option_name TEXT UNIQUE, option_value TEXT, autoload TEXT)');
    $pdo->exec("INSERT INTO wpx_users (ID, user_login) VALUES (1, 'siteadmin')");
    Wp::$pdoFactory = fn () => [$pdo, 'wpx_'];
    $early = $call('POST', '/wordpress/finish', ['id' => 'my-blog', 'admin_user' => 'nobody']);
    check(str_contains($early->body, 'class="msg bad"'), 'unknown admin is refused');
    $done = $call('POST', '/wordpress/finish', ['id' => 'my-blog', 'admin_user' => 'siteadmin']);
    check((bool) preg_match('/WPMP-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/', $done->body), 'pairing code shown');
    check(str_contains((string) Wp::option($pdo, 'wpx_', 'active_plugins'), 'wp-mcp-bridge'), 'bridge activated');
    $fa = $panel->handle(req('GET', '/wordpress', '', ['accept-language' => 'fa-IR'], [], [], [$n => $v]));
    check(str_contains($fa->body, 'سایت وردپرس جدید') && str_contains($fa->body, 'dir="rtl"'), 'Persian form');

    Net::$transport = null;
    Db::$override = null;
    Wp::$pdoFactory = null;
});

section('host self-test', function () {
    [$agent, $root, $web] = newAgent();
    installAgent($agent);
    (new Sites($agent))->create(['name' => 'T', 'folder' => 't', 'mode' => 'sync'], 't');
    $checks = \WPM\Agent\Selftest::run($agent, true, false);
    $by = array_column($checks, null, 'id');
    foreach (['php', 'https', 'data_dir', 'atomic_rename', 'locking', 'symlink', 'zlib', 'upload_limit', 'memory', 'disk', 'sodium', 'database', 'hashing', 'node', 'panel', 'site_t'] as $id) {
        check(isset($by[$id]), 'selftest reports ' . $id);
    }
    check($by['data_dir']['status'] === 'ok' && $by['atomic_rename']['status'] === 'ok' && $by['zlib']['status'] === 'ok', 'core checks pass');
    check(!array_filter($checks, static fn ($c) => $c['status'] === 'fail'), 'no failures on a healthy folder');
    same(\WPM\Agent\Selftest::run($agent, false, false)[1]['status'], 'warn', 'plain http is a warning');
    check(count(glob($agent->dataDir . '/selftest-*')) === 0, 'scratch folder is removed');
    $net = [];
    Net::$transport = function () use (&$net) { $net[] = 1; return [200, 'abc']; };
    $online = array_column(\WPM\Agent\Selftest::run($agent, true, true), null, 'id');
    same($online['outbound']['status'], 'ok', 'outbound check');
    Net::$transport = fn () => throw new ApiError('net_failed', 'blocked by firewall');
    $off = array_column(\WPM\Agent\Selftest::run($agent, true, true), null, 'id');
    same($off['outbound']['status'], 'warn', 'blocked outbound is a warning, not a failure');
    Net::$transport = null;
});

section('signed agent update', function () {
    if (!function_exists('sodium_crypto_sign_keypair')) {
        echo "  (sodium unavailable, skipped)\n";
        return;
    }
    [$agent, $root, $web] = newAgent();
    installAgent($agent);
    $src = dirname(__DIR__) . '/wpm-agent';
    // a live-looking installation to update
    mkdir($agent->agentDir . '/src', 0777, true);
    $files = ['index.php', '.htaccess'];
    foreach (glob($src . '/src/*.php') as $f) {
        $files[] = 'src/' . basename($f);
    }
    foreach ($files as $f) {
        copy($src . '/' . $f, $agent->agentDir . '/' . $f);
    }
    file_put_contents($agent->agentDir . '/data-location.php', "<?php return 'keep-me';");
    file_put_contents($agent->agentDir . '/wpm-setup.php', '<?php // setup');
    file_put_contents($agent->agentDir . '/src/Obsolete.php', '<?php // removed in the new version');

    $kp = sodium_crypto_sign_keypair();
    Update::$publicKey = base64_encode(sodium_crypto_sign_publickey($kp));
    $sign = static fn (string $zip, string $key) => base64_encode(sodium_crypto_sign_detached(Update::CONTEXT . hash('sha256', $zip), $key));
    $tree = static function (string $version) use ($files, $src): array {
        $t = [];
        foreach ($files as $f) {
            $t[$f] = (string) file_get_contents($src . '/' . $f);
        }
        $t['src/Agent.php'] = preg_replace("/const VERSION = '[^']+'/", "const VERSION = '" . $version . "'", $t['src/Agent.php']);
        $t['src/Util.php'] .= "\n// updated\n";

        return $t;
    };
    $write = static function (string $zip) use ($root): string {
        $f = $root . '/u-' . bin2hex(random_bytes(3)) . '.zip';
        file_put_contents($f, $zip);

        return $f;
    };
    $secret = sodium_crypto_sign_secretkey($kp);

    $good = makeZip($tree('99.0.0'));
    throwsCode(fn () => Update::apply($agent, $write($good), $sign($good, sodium_crypto_sign_secretkey(sodium_crypto_sign_keypair()))), 'bad_signature', 'signature from another key');
    throwsCode(fn () => Update::apply($agent, $write($good), base64_encode('short')), 'bad_signature', 'garbage signature');
    throwsCode(fn () => Update::apply($agent, $write($good . 'x'), $sign($good, $secret)), 'bad_signature', 'tampered archive');
    check(!str_contains(file_get_contents($agent->agentDir . '/src/Util.php'), '// updated'), 'nothing changed after refusals');

    $old = makeZip($tree('1.0.0'));
    throwsCode(fn () => Update::apply($agent, $write($old), $sign($old, $secret)), 'not_newer', 'downgrades are refused even when signed');
    $same = makeZip($tree(Agent::VERSION));
    throwsCode(fn () => Update::apply($agent, $write($same), $sign($same, $secret)), 'not_newer', 'the same version is refused');

    $extra = $tree('99.0.0');
    $extra['evil.php'] = '<?php system($_GET[0]);';
    $bad = makeZip($extra);
    throwsCode(fn () => Update::apply($agent, $write($bad), $sign($bad, $secret)), 'zip_rejected', 'extra files are refused');
    $nested = $tree('99.0.0');
    $nested['../escape.php'] = 'x';
    $bad2 = makeZip($nested);
    throwsCode(fn () => Update::apply($agent, $write($bad2), $sign($bad2, $secret)), 'zip_unsafe_path', 'path escape is refused');
    $incomplete = $tree('99.0.0');
    unset($incomplete['src/Update.php']);
    $bad3 = makeZip($incomplete);
    throwsCode(fn () => Update::apply($agent, $write($bad3), $sign($bad3, $secret)), 'bad_update', 'incomplete update is refused');

    $res = Update::apply($agent, $write($good), $sign($good, $secret));
    same([$res['from'], $res['to']], [Agent::VERSION, '99.0.0'], 'update applied');
    check(str_contains(file_get_contents($agent->agentDir . '/src/Util.php'), '// updated'), 'files replaced');
    check(str_contains(file_get_contents($agent->agentDir . '/src/Agent.php'), "'99.0.0'"), 'version replaced');
    check(!is_file($agent->agentDir . '/src/Obsolete.php'), 'files the new version dropped are removed');
    same(file_get_contents($agent->agentDir . '/data-location.php'), "<?php return 'keep-me';", 'data-location.php untouched');
    check(is_file($agent->agentDir . '/wpm-setup.php'), 'setup code file untouched');
    check(is_file($agent->dataDir . '/backups/' . $res['backup'] . '/src/Util.php') && !str_contains(file_get_contents($agent->dataDir . '/backups/' . $res['backup'] . '/src/Util.php'), '// updated'), 'previous version kept in backups');
    check(count(glob($agent->agentDir . '/*.wpm-new')) + count(glob($agent->agentDir . '/src/*.wpm-new')) === 0, 'no temp files left');
    check(count(glob($agent->dataDir . '/update-*')) === 0, 'staging folder removed');

    Update::$publicKey = '';
    throwsCode(fn () => Update::apply($agent, $write($good), $sign($good, $secret)), 'no_update_key', 'agent without a release key refuses updates');
    Update::$publicKey = null;
});

function tap(string $content): string
{
    $f = sys_get_temp_dir() . '/wpm-cfg-' . bin2hex(random_bytes(3)) . '.php';
    file_put_contents($f, $content);

    return $f;
}

$t = $GLOBALS['t'];
echo "\n{$t['pass']} passed, {$t['fail']} failed\n";
exit($t['fail'] === 0 ? 0 : 1);
