<?php
/**
 * WPM Host Agent: the one file the web server runs.
 * Everything (setup wizard, panel, signed API) goes through here: index.php?r=/route
 */
if (PHP_VERSION_ID < 80100) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo "WPM Host Agent needs PHP 8.1 or newer. This server runs PHP " . PHP_VERSION . ".\nChoose a newer PHP version in your hosting control panel.\n";
    exit;
}

define('WPM_AGENT', true);
foreach (['Util', 'ApiError', 'Store', 'Fs', 'Zip', 'Security', 'Http', 'Caps', 'Agent', 'Auth', 'Net', 'Db', 'NodeApp', 'Sites', 'Wp', 'Api', 'Panel'] as $part) {
    require __DIR__ . '/src/' . $part . '.php';
}

use WPM\Agent\Agent;
use WPM\Agent\Api;
use WPM\Agent\ApiError;
use WPM\Agent\Auth;
use WPM\Agent\Panel;
use WPM\Agent\Request;
use WPM\Agent\Response;
use WPM\Agent\Sites;
use WPM\Agent\Util;

ini_set('display_errors', '0');
ini_set('html_errors', '0');
@set_time_limit(300);

try {
    $env = getenv('WPM_AGENT_DATA');
    $agent = Agent::boot(__DIR__, is_string($env) && $env !== '' ? $env : null);
    $post = Util::bytes((string) ini_get('post_max_size'));
    $req = Request::fromGlobals(min(64 * 1048576, $post === PHP_INT_MAX ? 64 * 1048576 : $post));
    $auth = new Auth($agent);
    $sites = new Sites($agent);
    $res = str_starts_with($req->route, '/api/v1/')
        ? (new Api($agent, $auth, $sites))->handle($req)
        : (new Panel($agent, $auth, $sites))->handle($req);
} catch (ApiError $e) {
    $res = Response::json($e->status, ['ok' => false, 'error' => ['code' => $e->errorCode, 'message' => $e->getMessage()]]);
} catch (Throwable $e) {
    error_log('wpm-agent: ' . $e);
    $res = Response::json(500, ['ok' => false, 'error' => ['code' => 'internal', 'message' => 'The agent hit an unexpected error. Check the PHP error log on the host.']]);
}
$res->send();
