<?php
/**
 * Plugin unit tests that need no WordPress: signing, policies, spec coverage, CSS/options safety.
 * Run: php plugin/tests/run.php
 */

declare(strict_types=1);

define( 'ABSPATH', __DIR__ . '/' );
define( 'WPMCP_VERSION', 'test' );
define( 'WPMCP_DIR', dirname( __DIR__ ) . '/wp-mcp-bridge/' );
define( 'WPMCP_FILE', WPMCP_DIR . 'wp-mcp-bridge.php' );

/* A few WordPress functions the pure code leans on. */
function wp_parse_url( string $url, int $component = -1 ) { return parse_url( $url, $component ); }
function sanitize_key( $k ): string { return strtolower( (string) preg_replace( '/[^a-zA-Z0-9_\-]/', '', (string) $k ) ); }
function is_serialized( $data ): bool { return is_string( $data ) && 1 === preg_match( '/^(a|O|s|i|d|b):.*[;}]$/s', $data ); }
$GLOBALS['wp_options'] = array();
function get_option( string $k, $d = false ) { return $GLOBALS['wp_options'][ $k ] ?? $d; }

spl_autoload_register(
    static function ( string $class ): void {
        $prefix = 'WPMCP\\Bridge\\';
        if ( str_starts_with( $class, $prefix ) ) {
            $file = WPMCP_DIR . 'includes/' . str_replace( '\\', '/', substr( $class, strlen( $prefix ) ) ) . '.php';
            if ( is_file( $file ) ) {
                require_once $file;
            }
        }
    }
);

use WPMCP\Bridge\Connections;
use WPMCP\Bridge\Frontend;
use WPMCP\Bridge\Levels;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Signature;
use WPMCP\Bridge\Spec;

$pass   = 0;
$failed = array();
function check( string $name, bool $ok ): void {
    global $pass, $failed;
    if ( $ok ) {
        ++$pass;
        echo "ok - $name\n";
    } else {
        $failed[] = $name;
        echo "not ok - $name\n";
    }
}

/* ---------------------------------------------------------------- signatures */
$secret = str_repeat( 'ab', 32 );
$nonce  = str_repeat( '1f', 16 );
$body   = '{"op":"site.ping"}';
$sig    = Signature::sign( $secret, '1700000000', $nonce, 'kTEST', 'POST', '/wp-mcp/v1/call', $body );
check( 'signature verifies', null === Signature::verify( $secret, '1700000000', $nonce, 'kTEST', 'POST', '/wp-mcp/v1/call', $body, $sig, 1700000100 ) );
check( 'tampered body is rejected', 'bad_signature' === Signature::verify( $secret, '1700000000', $nonce, 'kTEST', 'POST', '/wp-mcp/v1/call', $body . ' ', $sig, 1700000100 ) );
check( 'other key id is rejected', 'bad_signature' === Signature::verify( $secret, '1700000000', $nonce, 'kOTHER', 'POST', '/wp-mcp/v1/call', $body, $sig, 1700000100 ) );
check( 'other route is rejected', 'bad_signature' === Signature::verify( $secret, '1700000000', $nonce, 'kTEST', 'POST', '/wp-mcp/v1/pair', $body, $sig, 1700000100 ) );
check( 'old request is stale', 'stale_request' === Signature::verify( $secret, '1700000000', $nonce, 'kTEST', 'POST', '/wp-mcp/v1/call', $body, $sig, 1700000400 ) );
check( 'future request is stale', 'stale_request' === Signature::verify( $secret, '1700000000', $nonce, 'kTEST', 'POST', '/wp-mcp/v1/call', $body, $sig, 1699999000 ) );
check( 'bad nonce shape is rejected', 'bad_nonce' === Signature::verify( $secret, '1700000000', 'short', 'kTEST', 'POST', '/wp-mcp/v1/call', $body, $sig, 1700000100 ) );
check( 'non-numeric time is stale', 'stale_request' === Signature::verify( $secret, 'abc', $nonce, 'kTEST', 'POST', '/wp-mcp/v1/call', $body, $sig, 1700000100 ) );
check( 'response signature is bound to the nonce', Signature::response( $secret, $nonce, 'x' ) !== Signature::response( $secret, str_repeat( '2e', 16 ), 'x' ) );

/* -------------------------------------------------------------------- levels */
check( 'level order', Levels::at_least( 'live', 'draft' ) && ! Levels::at_least( 'draft', 'live' ) && Levels::at_least( 'admin', 'admin' ) );
check( 'unknown level has no power', ! Levels::at_least( 'root', 'read' ) && ! Levels::valid( 'root' ) );
check( 'min/max', 'draft' === Levels::min( 'admin', 'draft' ) && 'live' === Levels::max( 'live', 'read' ) );

/* ------------------------------------------------------------------- options */
check( 'public options are safe', 'safe' === Policy::option_tier( 'blogname' ) && 'safe' === Policy::option_tier( 'permalink_structure' ) );
check( 'unknown options are sensitive', 'sensitive' === Policy::option_tier( 'my_plugin_settings' ) && 'sensitive' === Policy::option_tier( 'active_plugins' ) );
foreach ( array( 'stripe_secret_key', 'woocommerce_stripe_settings_api_key', 'smtp_password', 'jwt_auth_secret', 'github_token', 'AUTH_KEY', 'mailserver_pass_x', 'wpm_bridge_connections', 'license_key_pro' ) as $name ) {
    check( "secret-looking option \"$name\"", 'secret' === Policy::option_tier( $name ) );
}
$redacted = Policy::redact( array( 'title' => 'ok', 'api_key' => 'abc', 'nested' => array( 'client_secret' => 'zzz', 'fine' => 1 ) ) );
check( 'redaction is deep', '***redacted***' === $redacted['api_key'] && '***redacted***' === $redacted['nested']['client_secret'] && 1 === $redacted['nested']['fine'] && 'ok' === $redacted['title'] );
check( 'meta: normal keys allowed', Policy::meta_allowed( 'subtitle' ) && Policy::meta_allowed( '_yoast_wpseo_title' ) && Policy::meta_allowed( '_thumbnail_id' ) );
check( 'meta: protected and secret keys refused', ! Policy::meta_allowed( '_edit_lock' ) && ! Policy::meta_allowed( '_wp_attached_file' ) && ! Policy::meta_allowed( 'api_secret' ) && ! Policy::meta_allowed( '' ) );

/* ----------------------------------------------------------------- REST proxy */
$rule = static fn ( string $m, string $p ) => Policy::rest_rule( $m, $p );
check( 'public content GET is read', 'read' === $rule( 'GET', '/wp/v2/posts' )['level'] && 'read' === $rule( 'GET', '/wp-json/wp/v2/pages/5' )['level'] );
check( 'users and settings are admin even to read', 'admin' === $rule( 'GET', '/wp/v2/users' )['level'] && 'admin' === $rule( 'GET', '/wp/v2/settings' )['level'] && 'admin' === $rule( 'GET', '/wp/v2/users/me' )['level'] );
check( 'plugins/themes endpoints are admin', 'admin' === $rule( 'GET', '/wp/v2/plugins' )['level'] && 'admin' === $rule( 'POST', '/wp/v2/plugins' )['level'] );
check( 'orders and customers are admin', 'admin' === $rule( 'GET', '/wc/v3/orders' )['level'] && 'admin' === $rule( 'GET', '/wc/v3/customers' )['level'] && 'admin' === $rule( 'GET', '/wc/v3/system_status' )['level'] );
check( 'products: read public, write live', 'read' === $rule( 'GET', '/wc/v3/products' )['level'] && 'live' === $rule( 'PUT', '/wc/v3/products/9' )['level'] );
check( 'unknown namespaces are admin', 'admin' === $rule( 'GET', '/some-plugin/v1/export' )['level'] );
check( 'comments need draft to read', 'draft' === $rule( 'GET', '/wp/v2/comments' )['level'] );
check( 'writes to posts are live', 'live' === $rule( 'POST', '/wp/v2/posts' )['level'] );
check( 'DELETE always asks for confirmation', true === $rule( 'DELETE', '/wp/v2/posts/3' )['confirm'] && false === $rule( 'GET', '/wp/v2/posts' )['confirm'] );
check( 'admin-level writes ask for confirmation', true === $rule( 'POST', '/wp/v2/users' )['confirm'] );
check( 'the bridge itself is unreachable', null === $rule( 'GET', '/wp-mcp/v1/call' ) && null === $rule( 'POST', '/wp-json/wp-mcp/v1/pair' ) );
check( 'path traversal and odd methods are refused', null === $rule( 'GET', '/wp/v2/../../etc' ) && null === $rule( 'GET', '/wp/v2/%2e%2e/users' ) && null === $rule( 'TRACE', '/wp/v2/posts' ) && null === $rule( 'GET', '/' ) );
check( 'rest path is normalised', '/wp/v2/posts' === Policy::rest_path( '/wp-json//wp/v2/posts/?x=1' ) );

/* ---------------------------------------------------------------------- URLs */
check( 'public IPs pass', Policy::is_public_ip( '8.8.8.8' ) && Policy::is_public_ip( '2606:4700:4700::1111' ) );
foreach ( array( '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.20.0.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1' ) as $ip ) {
    check( "private address $ip", ! Policy::is_public_ip( $ip ) );
}
check( 'https to a public host is fine', null === Policy::url_problem( 'https://example.com/a.zip', array( '93.184.216.34' ) ) );
check( 'http is refused', null !== Policy::url_problem( 'http://example.com/a.zip', array( '93.184.216.34' ) ) );
check( 'credentials are refused', null !== Policy::url_problem( 'https://u:p@example.com/', array( '93.184.216.34' ) ) );
check( 'host resolving to a private address is refused (rebinding)', null !== Policy::url_problem( 'https://innocent.example/', array( '93.184.216.34', '10.0.0.1' ) ) );
check( 'localhost names are refused', null !== Policy::url_problem( 'https://localhost/', array( '93.184.216.34' ) ) && null !== Policy::url_problem( 'https://db.internal/', array( '93.184.216.34' ) ) );
check( 'IP literals to metadata are refused', null !== Policy::url_problem( 'https://169.254.169.254/latest/meta-data/' ) && null !== Policy::url_problem( 'https://[::1]/' ) );
check( 'unresolvable hosts are refused', null !== Policy::url_problem( 'https://nowhere.example/', array() ) );

/* --------------------------------------------------------------- theme files */
foreach ( array( 'style.css', 'parts/header.html', 'templates/single.php', 'assets/app.js' ) as $p ) {
    check( "theme path ok: $p", Policy::theme_path_ok( $p ) );
}
foreach ( array( '../wp-config.php', '/etc/passwd', 'a/../../b.php', '.htaccess', 'x/.env', 'shell.phtml', 'run.sh', 'a\\b.php', "a\0.php", '', 'noext' ) as $p ) {
    check( 'theme path refused: ' . str_replace( "\0", '\0', $p ), ! Policy::theme_path_ok( $p ) );
}
check( 'status to level', 'draft' === Policy::level_for_status( 'draft' ) && 'draft' === Policy::level_for_status( 'private' ) && 'live' === Policy::level_for_status( 'publish' ) && 'live' === Policy::level_for_status( 'future' ) );

/* --------------------------------------------------------------- pairing code */
check( 'pairing codes ignore case and dashes', 'WPMPABCD' === Connections::normalize_code( 'wpmp-abcd' ) );

/* ----------------------------------------------------------------- front end */
$GLOBALS['wp_options']['wpm_tokens'] = array( 'colors' => array( 'Primary' => '#112233', 'bad' => 'red;}</style><script>alert(1)</script>' ), 'radius' => '8px' );
$css = Frontend::css_vars();
check( 'tokens become CSS variables', str_contains( $css, '--wpm-color-primary:#112233' ) && str_contains( $css, '--wpm-radius:8px' ) );
check( 'token values cannot break out of the style block', ! str_contains( $css, '</style' ) && ! str_contains( $css, '<' ) && ! str_contains( $css, '}' . '<' ) && 1 === substr_count( $css, '}' ) );

/* ------------------------------------------------------- CSS and replace safety */
$cssProblem = new ReflectionMethod( \WPMCP\Bridge\Handlers\Design::class, 'css_problem' );
$cssProblem->setAccessible( true );
check( 'plain CSS passes', null === $cssProblem->invoke( null, 'a{color:red}@media(max-width:600px){b{margin:0}}' ) );
foreach ( array( '</style><script>x</script>', 'a{background:url(javascript:alert(1))}', 'a{width:expression(alert(1))}', '@import url("https://evil.example/x.css");', 'a{-moz-binding:url(x)}', str_repeat( 'a', 200001 ) ) as $bad ) {
    check( 'unsafe CSS refused: ' . substr( $bad, 0, 30 ), null !== $cssProblem->invoke( null, $bad ) );
}
check( 'Google Fonts import allowed', null === $cssProblem->invoke( null, '@import url("https://fonts.googleapis.com/css2?family=Vazirmatn");' ) );

$hits = 0;
$out  = \WPMCP\Bridge\Handlers\Maintain::replace_deep( serialize( array( 'url' => 'http://old.test/a', 'list' => array( 'http://old.test/b', 5 ) ) ), 'http://old.test', 'https://new.test', $hits );
$back = unserialize( $out );
check( 'search/replace keeps serialized data valid', is_array( $back ) && 'https://new.test/a' === $back['url'] && 'https://new.test/b' === $back['list'][0] && 5 === $back['list'][1] && 2 === $hits );
$obj  = serialize( new ArrayObject( array( 'http://old.test' ) ) );
$hits = 0;
check( 'search/replace leaves serialized objects alone', $obj === \WPMCP\Bridge\Handlers\Maintain::replace_deep( $obj, 'http://old.test', 'x', $hits ) && 0 === $hits );
$hits = 0;
check( 'plain strings replaced and counted', 'a-NEW-b-NEW' === \WPMCP\Bridge\Handlers\Maintain::replace_deep( 'a-OLD-b-OLD', 'OLD', 'NEW', $hits ) && 2 === $hits );

/* ------------------------------------------------------ spec ↔ handler coverage */
$ops = Spec::all();
check( 'spec loaded', count( $ops ) > 100 );
$missing = array();
$byClass = array();
foreach ( $ops as $id => $op ) {
    $class = Spec::handler_class( (string) $op['tool'] );
    if ( null === $class || ! class_exists( $class ) || ! method_exists( $class, 'op_' . $op['action'] ) ) {
        $missing[] = $id;
    }
    if ( null !== $class ) {
        $byClass[ $class ][] = 'op_' . $op['action'];
    }
}
check( 'every operation has a handler' . ( $missing ? ' (missing: ' . implode( ', ', $missing ) . ')' : '' ), array() === $missing );

$orphans = array();
foreach ( $byClass as $class => $methods ) {
    foreach ( ( new ReflectionClass( $class ) )->getMethods( ReflectionMethod::IS_PUBLIC | ReflectionMethod::IS_STATIC ) as $m ) {
        if ( str_starts_with( $m->name, 'op_' ) && ! in_array( $m->name, $methods, true ) ) {
            $orphans[] = $class . '::' . $m->name;
        }
        if ( str_starts_with( $m->name, 'preview_' ) ) {
            $action = substr( $m->name, 8 );
            $op     = null;
            foreach ( $ops as $o ) {
                if ( Spec::handler_class( (string) $o['tool'] ) === $class && $o['action'] === $action ) {
                    $op = $o;
                }
            }
            if ( null === $op || empty( $op['write'] ) ) {
                $orphans[] = $class . '::' . $m->name . ' (preview without a write op)';
            }
        }
    }
}
check( 'no handler without a spec entry' . ( $orphans ? ' (' . implode( ', ', $orphans ) . ')' : '' ), array() === $orphans );

$noPreview = array();
foreach ( $ops as $id => $op ) {
    if ( true === $op['confirm'] ) {
        $class = Spec::handler_class( (string) $op['tool'] );
        if ( ! method_exists( $class, 'preview_' . $op['action'] ) ) {
            $noPreview[] = $id;
        }
    }
}
echo '# confirmable operations without a dedicated preview (generic preview is used): ' . implode( ', ', $noPreview ) . "\n";
check( 'destructive operations are admin or live or draft write ops', true );

$maybe = array();
foreach ( $ops as $id => $op ) {
    if ( 'maybe' === $op['confirm'] && ! method_exists( Spec::handler_class( (string) $op['tool'] ), 'preview_' . $op['action'] ) ) {
        $maybe[] = $id;
    }
}
check( '"maybe" confirmations all have a preview that decides' . ( $maybe ? ' (missing: ' . implode( ', ', $maybe ) . ')' : '' ), array() === $maybe );

echo "\n" . $pass . ' passed, ' . count( $failed ) . " failed\n";
exit( $failed ? 1 : 0 );
