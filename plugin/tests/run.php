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
check( 'css: script-capable constructs are caught', Policy::css_runs_code( 'a{behavior:url(x.htc)}' ) && Policy::css_runs_code( 'a{ BEHAVIOR : url(x)}' ) && Policy::css_runs_code( 'a{width:expression(1)}' ) && Policy::css_runs_code( 'a{background:url(javascript:1)}' ) && Policy::css_runs_code( 'a{-moz-binding:url(x)}' ) );
check( 'css: scroll-behavior and overscroll-behavior are plain CSS', ! Policy::css_runs_code( 'html{scroll-behavior:smooth}.t{overscroll-behavior: contain; scroll-snap-align:start}' ) );
check( 'sql: one statement, with or without a trailing semicolon', Policy::sql_is_single( 'UPDATE wp_posts SET post_title = 1' ) && Policy::sql_is_single( "SELECT 1;
" ) );
check( 'sql: semicolons inside quoted text are data', Policy::sql_is_single( "UPDATE wp_snippets SET code = REPLACE(code, 'a(); b();', 'c(\'x\'); d(''y'');') WHERE id = 1" ) && Policy::sql_is_single( 'UPDATE t SET a = "x;y", `b;c` = 1' ) );
check( 'sql: a second statement is refused', ! Policy::sql_is_single( 'DELETE FROM a; DROP TABLE b' ) && ! Policy::sql_is_single( "UPDATE t SET a = 'x'; DROP TABLE b" ) && ! Policy::sql_is_single( "SELECT 'a' ; SELECT 'b'" ) );
$throws = static function ( callable $fn ): string {
    try {
        $fn();
    } catch ( \WPMCP\Bridge\BridgeError $e ) {
        return $e->error_code;
    }

    return '';
};
check( 'patch: one exact replacement', array( "a\nB\nc", 1 ) === Policy::apply_edits( "a\nb\nc", array( array( 'old' => 'b', 'new' => 'B' ) ) ) );
check( 'patch: edits run in order and all:true replaces every match', array( 'y-y z', 3 ) === Policy::apply_edits( 'x-x q', array( array( 'old' => 'x', 'new' => 'y', 'all' => true ), array( 'old' => 'q', 'new' => 'z' ) ) ) );
check( 'patch: an edit written with \n matches a \r\n file and keeps its line endings', array( "a\r\nX\r\nY\r\nc", 1 ) === Policy::apply_edits( "a\r\nb\r\nc", array( array( 'old' => "a\nb", 'new' => "a\nX\nY" ) ) ) );
check( 'patch: text that is not there, or there twice, changes nothing', 'no_match' === $throws( static fn () => Policy::apply_edits( 'abc', array( array( 'old' => 'zz', 'new' => '' ) ) ) ) && 'ambiguous' === $throws( static fn () => Policy::apply_edits( 'aa', array( array( 'old' => 'a', 'new' => 'b' ) ) ) ) );
check( 'patch: empty or malformed edits are refused', 'bad_arguments' === $throws( static fn () => Policy::apply_edits( 'abc', array() ) ) && 'bad_arguments' === $throws( static fn () => Policy::apply_edits( 'abc', array( array( 'old' => '', 'new' => 'x' ) ) ) ) && 'bad_arguments' === $throws( static fn () => Policy::apply_edits( 'abc', array( 'nope' ) ) ) );
$cfg = "<?php\ndefine( 'DB_NAME', 'wp' );\ndefine('WP_DEBUG', false); // off\n\n/* That's all, stop editing! Happy publishing. */\nrequire_once ABSPATH . 'wp-settings.php';\n";
check( 'config: an existing define is replaced in place', str_contains( Policy::config_set( $cfg, 'WP_DEBUG', true ), "define( 'DB_NAME', 'wp' );\ndefine( 'WP_DEBUG', true );\n\n/* That's all" ) );
$added = Policy::config_set( $cfg, 'WP_MEMORY_LIMIT', '256M' );
check( 'config: a new constant goes above "stop editing"', str_contains( $added, "define( 'WP_MEMORY_LIMIT', '256M' );\n/* That's all" ) && 1 === substr_count( $added, 'WP_MEMORY_LIMIT' ) );
check( 'config: without the comment it goes above wp-settings.php', str_contains( Policy::config_set( "<?php\nrequire_once ABSPATH . 'wp-settings.php';\n", 'WP_POST_REVISIONS', 5 ), "define( 'WP_POST_REVISIONS', 5 );\nrequire_once" ) );
check( 'config: the result is valid PHP and quotes are escaped', array() !== token_get_all( Policy::config_set( $cfg, 'WP_HOME', "https://x.test/a'b" ), TOKEN_PARSE ) );
check( 'config: credentials, keys, salts and paths are off limits', ! Policy::config_name_ok( 'DB_PASSWORD' ) && ! Policy::config_name_ok( 'AUTH_KEY' ) && ! Policy::config_name_ok( 'NONCE_SALT' ) && ! Policy::config_name_ok( 'ABSPATH' ) && ! Policy::config_name_ok( 'wp_debug' ) && ! Policy::config_name_ok( "X', 1); evil(); //" ) && Policy::config_name_ok( 'WP_DEBUG' ) );
check( 'config: a forbidden name or a non-scalar value is refused, and a file with no anchor is left alone', 'bad_arguments' === $throws( static fn () => Policy::config_set( $cfg, 'DB_HOST', 'x' ) ) && 'bad_arguments' === $throws( static fn () => Policy::config_set( $cfg, 'WP_DEBUG', array( 1 ) ) ) && 'config_unreadable' === $throws( static fn () => Policy::config_set( "<?php\n", 'WP_DEBUG', true ) ) );
check( 'the core-edit switch cannot be flipped through options', 'secret' === Policy::option_tier( 'wpm_bridge_core_write' ) );
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


/* ---------------------------------------------------------------- transfer / files */
check( 'builder and shop meta travels', Policy::transfer_meta_ok( '_elementor_data' ) && Policy::transfer_meta_ok( '_regular_price' ) && Policy::transfer_meta_ok( '_sku' ) && Policy::transfer_meta_ok( 'rank_math_title' ) && Policy::transfer_meta_ok( 'subtitle' ) );
check( 'secrets and internals do not travel', ! Policy::transfer_meta_ok( '_edit_lock' ) && ! Policy::transfer_meta_ok( 'api_secret' ) && ! Policy::transfer_meta_ok( '_thumbnail_id' ) && ! Policy::transfer_meta_ok( '_wp_attached_file' ) );
check( 'files: text anywhere, media in uploads only', Policy::files_path_ok( 'inc/a.php', false ) && Policy::files_path_ok( 'style.css', false ) && Policy::files_path_ok( 'img/a.png', true ) && ! Policy::files_path_ok( 'shell.php', true ) );
foreach ( array( '../x.php', '/etc/passwd', '.env', 'a/.git/config', 'wpmcp-backups/db.sql.gz', "a\0.php", 'run.exe', 'x.sh' ) as $p ) {
    check( 'files path refused: ' . str_replace( "\0", '\0', $p ), ! Policy::files_path_ok( $p, false ) );
}
$core = new ReflectionMethod( \WPMCP\Bridge\Handlers\Files::class, 'core_ok' );
$core->setAccessible( true );
check( 'core: wp-config and wp-content are closed', ! $core->invoke( null, 'wp-config.php', false ) && ! $core->invoke( null, 'WP-CONFIG.PHP', false ) && ! $core->invoke( null, 'wp-content/plugins/x.php', false ) && ! $core->invoke( null, '.env', false ) );
check( 'core: readable files', $core->invoke( null, 'wp-includes/version.php', false ) && $core->invoke( null, 'index.php', false ) && $core->invoke( null, '.htaccess', false ) );
check( 'core: only server files are writable', $core->invoke( null, '.htaccess', true ) && $core->invoke( null, 'robots.txt', true ) && ! $core->invoke( null, 'wp-includes/version.php', true ) && ! $core->invoke( null, 'index.php', true ) && ! $core->invoke( null, 'wp-admin/../wp-config.php', true ) );

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

/* ------------------------------------------------------- page builder trees */
function wp_strip_all_tags( $s ) { return strip_tags( (string) $s ); }
if ( ! function_exists( 'mb_substr' ) ) {
    function mb_substr( $s, $a, $l = null ) { return substr( (string) $s, $a, $l ); } // WordPress ships the same fallback.
}
$B    = \WPMCP\Bridge\Handlers\Builder::class;
$call = static function ( string $fn, array $args ) use ( $B ) {
    $m = new ReflectionMethod( $B, $fn );
    $m->setAccessible( true );

    return $m->invokeArgs( null, $args );
};
$el = array(
    array( 'id' => 'a1', 'elType' => 'container', 'settings' => array(), 'elements' => array(
        array( 'id' => 'b2', 'elType' => 'widget', 'widgetType' => 'heading', 'settings' => array( 'title' => 'Hello' ), 'elements' => array() ),
        array( 'id' => 'c3', 'elType' => 'widget', 'widgetType' => 'button', 'settings' => array( 'text' => 'Go' ), 'elements' => array() ),
    ) ),
);
$edit = Closure::bind(
    static function ( array &$tree, string $id, string $b ): bool {
        $hit = &self::find_ref( $tree, $id, $b );
        if ( null === $hit ) {
            return false;
        }
        $hit['settings']['title'] = 'Changed';

        return true;
    },
    null,
    $B
);
check( 'builder: nested element is found and edited in place', $edit( $el, 'b2', 'elementor' ) && 'Changed' === $el[0]['elements'][0]['settings']['title'] );
check( 'builder: unknown element id is not found', false === $edit( $el, 'zz', 'elementor' ) );
check( 'builder: count walks the tree', 3 === $call( 'count', array( $el ) ) );
check( 'builder: drop removes a nested element only', true === $call_drop = ( function () use ( &$el, $B ) {
    $m = new ReflectionMethod( $B, 'drop' );
    $m->setAccessible( true );
    $args = array( &$el, 'c3' );

    return $m->invokeArgs( null, $args );
} )() && 2 === $call( 'count', array( $el ) ) );
$threw = static function ( callable $f ): bool {
    try {
        $f();
    } catch ( \WPMCP\Bridge\BridgeError $e ) {
        return true;
    }

    return false;
};
check( 'builder: duplicate ids are refused', $threw( fn() => $call( 'check_tree', array( array( array( 'id' => 'x', 'elType' => 'container' ), array( 'id' => 'x', 'elType' => 'container' ) ), 'elementor' ) ) ) );
check( 'builder: an element without elType is refused for elementor', $threw( fn() => $call( 'check_tree', array( array( array( 'id' => 'x' ) ), 'elementor' ) ) ) );
check( 'builder: a bricks element needs a name', $threw( fn() => $call( 'check_tree', array( array( array( 'id' => 'x', 'settings' => array() ) ), 'bricks' ) ) ) );
check( 'builder: a valid tree passes', ! $threw( fn() => $call( 'check_tree', array( $el, 'elementor' ) ) ) );
$flat    = array(
    array( 'id' => 'r1', 'name' => 'section', 'parent' => 0, 'children' => array( 'r2' ), 'settings' => array() ),
    array( 'id' => 'r2', 'name' => 'heading', 'parent' => 'r1', 'children' => array(), 'settings' => array( 'text' => 'Hi <b>there</b>' ) ),
);
$outline = $call( 'outline', array( $flat, 'bricks' ) );
check( 'builder: bricks outline nests children under their parent', 1 === count( $outline ) && 'r2' === ( $outline[0]['children'][0]['id'] ?? '' ) && 'Hi there' === ( $outline[0]['children'][0]['text'] ?? '' ) );
$ids = array();
for ( $i = 0; $i < 50; $i++ ) {
    $ids[ $call( 'new_id', array() ) ] = 1;
}
check( 'builder: generated element ids are unique 7-char hex', 50 === count( $ids ) && 1 === preg_match( '/^[0-9a-f]{7}$/', (string) array_key_first( $ids ) ) );

/* ------------------------------------------------------------ bridge updates */
if ( ! function_exists( 'wp_get_environment_type' ) ) {
    function wp_get_environment_type() { return 'production'; }
}
$U   = \WPMCP\Bridge\Updater::class;
$sha = str_repeat( 'a', 64 );
$ok  = array( 'version' => '9.9.9', 'package' => 'https://example.com/wp-mcp-bridge.zip', 'sha256' => $sha, 'signature' => 'c2ln' );
check( 'updater: a complete https manifest is accepted', null !== $U::clean_manifest( $ok ) );
check( 'updater: plain http is refused outside development', null === $U::clean_manifest( array_merge( $ok, array( 'package' => 'http://example.com/a.zip' ) ) ) );
check( 'updater: a non-numeric version is refused', null === $U::clean_manifest( array_merge( $ok, array( 'version' => '1.0.0; drop' ) ) ) );
check( 'updater: a malformed checksum is refused', null === $U::clean_manifest( array_merge( $ok, array( 'sha256' => 'zz' ) ) ) );
check( 'updater: a manifest without a signature is refused', null === $U::clean_manifest( array_merge( $ok, array( 'signature' => '' ) ) ) );
check( 'updater: junk is refused', null === $U::clean_manifest( 'nope' ) && null === $U::clean_manifest( null ) );

$tmpzip = tempnam( sys_get_temp_dir(), 'wpmz' );
file_put_contents( $tmpzip, 'PK-demo-bytes' );
$real = hash_file( 'sha256', $tmpzip );
$m    = array_merge( $ok, array( 'sha256' => $real ) );
$key  = base64_encode( str_repeat( 'k', 32 ) );
check( 'updater: no release key means no install', str_contains( (string) $U::check_package( $tmpzip, $m, '', '1.0.0' ), 'no release key' ) );
check( 'updater: a downgrade is refused', str_contains( (string) $U::check_package( $tmpzip, array_merge( $m, array( 'version' => '1.0.0' ) ), $key, '2.0.0' ), 'not newer' ) );
check( 'updater: an equal version is refused', null !== $U::check_package( $tmpzip, array_merge( $m, array( 'version' => '2.0.0' ) ), $key, '2.0.0' ) );
check( 'updater: a changed download is refused by checksum', str_contains( (string) $U::check_package( $tmpzip, array_merge( $m, array( 'sha256' => $sha ) ), $key, '1.0.0' ), 'checksum' ) );
if ( function_exists( 'sodium_crypto_sign_keypair' ) ) {
    $pair = sodium_crypto_sign_keypair();
    $pub  = base64_encode( sodium_crypto_sign_publickey( $pair ) );
    $good = base64_encode( sodium_crypto_sign_detached( $U::CONTEXT . '9.9.9' . "\n" . $real, sodium_crypto_sign_secretkey( $pair ) ) );
    check( 'updater: a correctly signed package passes', null === $U::check_package( $tmpzip, array_merge( $m, array( 'signature' => $good ) ), $pub, '2.0.0' ) );
    $other = base64_encode( sodium_crypto_sign_detached( $U::CONTEXT . '9.9.8' . "\n" . $real, sodium_crypto_sign_secretkey( $pair ) ) );
    check( 'updater: a signature for another version is refused (no replay of an old release)', null !== $U::check_package( $tmpzip, array_merge( $m, array( 'signature' => $other ) ), $pub, '2.0.0' ) );
    $pair2 = sodium_crypto_sign_keypair();
    check( 'updater: a signature by another key is refused', null !== $U::check_package( $tmpzip, array_merge( $m, array( 'signature' => $good ) ), base64_encode( sodium_crypto_sign_publickey( $pair2 ) ), '2.0.0' ) );
} else {
    check( 'updater: without sodium nothing is installed (signature tests need the extension; run them where WordPress loads sodium_compat)', str_contains( (string) $U::check_package( $tmpzip, $m, $key, '1.0.0' ), 'cannot verify' ) );
}
unlink( $tmpzip );
check( 'updater: the repository ships a release public key', 44 === strlen( (string) ( include WPMCP_DIR . 'includes/UpdateKey.php' ) ) );


/* core checksums */
$sums = array( 'index.php' => md5( 'a' ), 'wp-admin/admin.php' => md5( 'b' ), 'wp-includes/load.php' => md5( 'c' ), 'wp-includes/gone.php' => md5( 'd' ) );
$disk = array( 'index.php' => md5( 'a' ), 'wp-admin/admin.php' => md5( 'HACKED' ), 'wp-includes/load.php' => strtoupper( md5( 'c' ) ) );
$diff = Policy::core_compare( $sums, static fn ( string $p ): ?string => $disk[ $p ] ?? null );
check( 'core: a changed file is modified, an absent one missing, equal hashes (any case) are fine', array( 'wp-admin/admin.php' ) === $diff['modified'] && array( 'wp-includes/gone.php' ) === $diff['missing'] );
check( 'core: only files WordPress does not ship are unexpected, server leftovers are ignored', array( 'wp-admin/evil.php', 'wp-includes/x/shell.php' ) === Policy::core_unexpected( $sums, array( 'wp-includes/x/shell.php', 'wp-admin/admin.php', 'wp-admin/evil.php', 'wp-admin/.htaccess', 'wp-admin/error_log' ) ) );
check( 'core: wp-content, wp-config and loose docs are not checked, normal core files are', ! Policy::core_checked( 'wp-content/themes/twentytwentyfive/style.css' ) && ! Policy::core_checked( 'wp-config.php' ) && ! Policy::core_checked( 'readme.html' ) && ! Policy::core_checked( '../x.php' ) && Policy::core_checked( 'wp-load.php' ) && Policy::core_checked( 'wp-admin/includes/file.php' ) );

/* snippets: pure helpers */
check( 'snippets: opening and closing tags are stripped from PHP code', "echo 1;\n" === Policy::snippet_code( "<?php\necho 1;\n?>\n" ) && "echo 1;\n" === Policy::snippet_code( 'echo 1;' ) && "echo 1;\n" === Policy::snippet_code( "<?php echo 1;" ) );
check( 'snippets: scope defaults, is lower-cased and unknown ones are refused', 'global' === Policy::snippet_scope( null ) && 'admin' === Policy::snippet_scope( ' Admin ' ) && 'front-end' === Policy::snippet_scope( '', 'front-end' ) );
$bad_scope = null;
try {
    Policy::snippet_scope( 'everywhere' );
} catch ( \WPMCP\Bridge\BridgeError $e ) {
    $bad_scope = $e->error_code;
}
check( 'snippets: an unknown scope is a bad argument', 'bad_arguments' === $bad_scope );
check( 'snippets: only code scopes run PHP', Policy::snippet_scope_is_php( 'single-use' ) && ! Policy::snippet_scope_is_php( 'site-css' ) && ! Policy::snippet_scope_is_php( 'content' ) );
check( 'snippets: tags come from a list or comma text, cleaned', array( 'a', 'b' ) === Policy::snippet_tags( 'a, b,,a' ) && array( 'x' ) === Policy::snippet_tags( array( ' x ', '' ) ) );
check( 'snippets: a syntax error is reported with the fragment line', null === \WPMCP\Bridge\PhpGuard::fragment_problem( "add_action('init', function () {});\n" ) && str_contains( (string) \WPMCP\Bridge\PhpGuard::fragment_problem( "\$a = 1;\n\$b = ;\n" ), 'line 2' ) );

/* files.fetch_many: the list is checked before anything is downloaded */
$plan = Policy::fetch_plan( array( array( 'url' => 'https://a.test/x.woff2', 'path' => '/assets\\x.woff2' ), array( 'url' => ' https://a.test/y.png ', 'path' => 'assets/y.png' ) ) );
check( 'fetch_many: paths are normalised and urls trimmed', 'assets/x.woff2' === $plan[0]['path'] && 'https://a.test/y.png' === $plan[1]['url'] );
$refused = static function ( $items ): ?string {
    try {
        Policy::fetch_plan( $items );
    } catch ( \WPMCP\Bridge\BridgeError $e ) {
        return $e->error_code;
    }

    return null;
};
check( 'fetch_many: empty, oversize and malformed lists are refused', 'bad_arguments' === $refused( array() ) && 'bad_arguments' === $refused( 'x' ) && 'bad_arguments' === $refused( array_fill( 0, 26, array( 'url' => 'https://a.test/x', 'path' => 'p' ) ) ) && 'bad_arguments' === $refused( array( array( 'url' => 'https://a.test/x' ) ) ) );
check( 'fetch_many: the same target twice (any case) is refused', 'bad_arguments' === $refused( array( array( 'url' => 'https://a.test/1', 'path' => 'a/B.png' ), array( 'url' => 'https://a.test/2', 'path' => 'a/b.png' ) ) ) );

/* content.save and page templates */
$tpls = array( 'templates/wide.php' => 'Wide', 'page-landing' => 'Landing' );
check( 'template: untouched when nothing is sent and none is stored', array( 'template' => null, 'note' => null ) === Policy::template_plan( null, '', $tpls ) );
check( 'template: a still valid stored template is left alone', null === Policy::template_plan( null, 'page-landing', $tpls )['template'] );
$stale = Policy::template_plan( null, 'templates/gone.php', $tpls );
check( 'template: a stored template that vanished is reset to default, with a note', 'default' === $stale['template'] && str_contains( (string) $stale['note'], 'gone.php' ) );
check( 'template: an empty string means the default template, even if the stored one is stale', 'default' === Policy::template_plan( '', 'templates/gone.php', $tpls )['template'] );
check( 'template: a valid template is passed on', 'templates/wide.php' === Policy::template_plan( ' templates/wide.php ', '', $tpls )['template'] );
$bad = null;
try {
    Policy::template_plan( 'nope.php', '', $tpls );
} catch ( \WPMCP\Bridge\BridgeError $e ) {
    $bad = $e;
}
check( 'template: an unknown template is refused with the list of real ones', $bad && 'bad_template' === $bad->error_code && str_contains( $bad->getMessage(), 'page-landing' ) );

/* inspect.outline selectors: translated to XPath and evaluated on a real DOM */
$html = '<html><body><header id="top" class="site hero"><a href="/a" class="btn big" target="_blank">A</a><a href="https://x.test/b" class="btn">B</a></header>'
    . '<main><section class="hero"><h1 data-role="title">T</h1><div><p class="lead">P</p></div></section><img src="/x.png" alt=""></main></body></html>';
$dom  = \WPMCP\Bridge\Dom::load( $html );
$xp   = new DOMXPath( $dom );
$hits = static function ( string $selector ) use ( $xp ): ?int {
    $expr = \WPMCP\Bridge\Dom::xpath_for( $selector );

    return null === $expr ? null : $xp->query( $expr )->length;
};
check( 'selector: tag, id and class still work', 1 === $hits( 'header' ) && 1 === $hits( '#top' ) && 2 === $hits( '.hero' ) && 1 === $hits( 'section.hero' ) );
check( 'selector: comma list joins matches', 3 === $hits( 'h1, .btn' ) && 2 === $hits( 'h1,p' ) );
check( 'selector: attribute presence and equality', 2 === $hits( 'a[href]' ) && 1 === $hits( '[data-role=title]' ) && 1 === $hits( 'a[target="_blank"]' ) );
check( 'selector: attribute prefix, suffix, substring, word', 1 === $hits( 'a[href^="https://"]' ) && 1 === $hits( 'img[src$=".png"]' ) && 1 === $hits( 'a[href*=x.test]' ) && 1 === $hits( 'a[class~=big]' ) );
check( 'selector: compound with class and attribute', 1 === $hits( 'a.btn[target=_blank]' ) && 0 === $hits( 'a.big[href^="https"]' ) );
check( 'selector: descendant and child combinators', 1 === $hits( 'main p' ) && 1 === $hits( 'section > h1' ) && 0 === $hits( 'section > p' ) && 1 === $hits( 'main > section div p.lead' ) );
check( 'selector: a comma inside brackets or quotes does not split', 0 === $hits( 'a[href="/a,b"]' ) && null !== $hits( 'a[href="/a,b"], h1' ) );
check( 'selector: unsupported or broken input is refused', null === $hits( '' ) && null === $hits( 'a[href' ) && null === $hits( '> p' ) && null === $hits( 'p >' ) && null === $hits( 'a:hover' ) && null === $hits( 'a, ' ) && null === $hits( 'a[x=\'"\']' . "'" ) );
check( 'selector: values cannot break out of the XPath string', 0 === $hits( 'a[href="x\' or \'1"]' ) );

echo "\n" . $pass . ' passed, ' . count( $failed ) . " failed\n";
exit( $failed ? 1 : 0 );
