<?php
/**
 * The signed endpoint: verify, authorise by level, run one operation, log, answer with a signed reply.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class Api {

    public const NS         = 'wp-mcp/v1';
    public const ROUTE_CALL = '/wp-mcp/v1/call';

    public static function routes(): void {
        register_rest_route( self::NS, '/call', array( 'methods' => 'POST', 'callback' => array( self::class, 'call' ), 'permission_callback' => '__return_true' ) );
        register_rest_route( self::NS, '/pair', array( 'methods' => 'POST', 'callback' => array( self::class, 'pair' ), 'permission_callback' => '__return_true' ) );
        register_rest_route( self::NS, '/ping', array( 'methods' => 'GET', 'callback' => static fn () => array( 'plugin' => 'wp-mcp-bridge', 'version' => WPMCP_VERSION ), 'permission_callback' => '__return_true' ) );
    }

    /* ---------------------------------------------------------------- pairing */

    public static function pair( \WP_REST_Request $request ): void {
        $ip   = isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( (string) $_SERVER['REMOTE_ADDR'] ) ) : 'unknown';
        $slot = 'wpm_pair_' . md5( $ip );
        $hits = (int) get_transient( $slot );
        if ( $hits >= 8 ) {
            self::emit( 429, array( 'ok' => false, 'error' => array( 'code' => 'slow_down', 'message' => 'Too many pairing attempts. Wait ten minutes.' ) ) );
        }
        set_transient( $slot, $hits + 1, 600 );

        if ( ! is_ssl() && 'local' !== wp_get_environment_type() ) {
            self::emit( 400, array( 'ok' => false, 'error' => array( 'code' => 'https_required', 'message' => 'Pairing sends a secret, so this site must be reached over https.' ) ) );
        }
        $body = json_decode( $request->get_body(), true );
        try {
            $data = Connections::pair( (string) ( $body['code'] ?? '' ), (string) ( $body['gateway'] ?? 'gateway' ) );
        } catch ( BridgeError $e ) {
            self::emit( $e->status, array( 'ok' => false, 'error' => array( 'code' => $e->error_code, 'message' => $e->getMessage() ) ) );
        }
        delete_transient( $slot );
        self::emit( 200, array( 'ok' => true, 'data' => $data ) );
    }

    /* ------------------------------------------------------------------ calls */

    public static function call( \WP_REST_Request $request ): void {
        $raw    = $request->get_body();
        $key_id = (string) $request->get_header( 'x_wpm_key' );
        $conn   = Connections::get( $key_id );
        if ( null === $conn ) {
            self::emit( 401, self::error_body( 'unknown_key', 'Unknown connection. Pair this site again.' ) );
        }
        $secret = (string) $conn['secret'];
        $nonce  = (string) $request->get_header( 'x_wpm_nonce' );

        $problem = Signature::verify( $secret, (string) $request->get_header( 'x_wpm_time' ), $nonce, $key_id, 'POST', self::ROUTE_CALL, $raw, (string) $request->get_header( 'x_wpm_signature' ), time() );
        if ( null !== $problem ) {
            $message = 'stale_request' === $problem ? 'Clock difference between gateway and site is over 5 minutes. Fix the server time.' : 'Request signature rejected.';
            self::emit( 401, self::error_body( $problem, $message ), $secret, $nonce );
        }
        $seen = 'wpm_n_' . substr( hash( 'sha256', $key_id . $nonce ), 0, 40 );
        if ( false !== get_transient( $seen ) ) {
            self::emit( 401, self::error_body( 'replayed', 'This request was already processed.' ), $secret, $nonce );
        }
        set_transient( $seen, 1, 2 * Signature::WINDOW );

        $body = json_decode( $raw, true );
        if ( ! is_array( $body ) ) {
            self::emit( 400, self::error_body( 'bad_json', 'Body is not JSON.' ), $secret, $nonce );
        }
        Connections::touch( $key_id );

        $op_id = (string) ( $body['op'] ?? '' );
        $level = Levels::min( Levels::valid( (string) ( $body['level'] ?? '' ) ) ? (string) $body['level'] : 'read', (string) $conn['ceiling'] );
        $ctx   = new Context( $level, $op_id, substr( sanitize_text_field( (string) ( $body['actor'] ?? '' ) ), 0, 100 ), substr( sanitize_text_field( (string) ( $body['client'] ?? '' ) ), 0, 100 ), substr( sanitize_key( (string) ( $body['request_id'] ?? '' ) ), 0, 40 ), ! empty( $body['dry_run'] ) );

        [ $status, $payload ] = self::run( $ctx, $conn, $key_id, $body );
        self::emit( $status, $payload, $secret, $nonce );
    }

    /**
     * @param array<string, mixed> $conn Connection.
     * @param array<string, mixed> $body Decoded request.
     * @return array{0: int, 1: array<string, mixed>}
     */
    private static function run( Context $ctx, array $conn, string $key_id, array $body ): array {
        $op = Spec::op( $ctx->op );
        try {
            if ( null === $op ) {
                throw new BridgeError( 'unknown_op', "Unknown operation {$ctx->op}. Update the bridge plugin or the gateway.", 404 );
            }
            $ctx->need( (string) $op['level'] );

            $user = get_userdata( (int) $conn['user'] );
            if ( ! $user || ! user_can( $user, 'manage_options' ) ) {
                throw new BridgeError( 'no_user', 'The administrator account this connection acts as is gone. Pair the site again.', 403 );
            }
            wp_set_current_user( $user->ID );
            if ( ! $ctx->can( 'admin' ) && function_exists( 'kses_init_filters' ) ) {
                kses_init_filters(); // Below admin level, HTML is filtered like an editor's.
            }

            $class  = Spec::handler_class( (string) $op['tool'] );
            $method = 'op_' . $op['action'];
            if ( null === $class || ! class_exists( $class ) || ! method_exists( $class, $method ) ) {
                throw new BridgeError( 'not_implemented', "{$ctx->op} is not implemented in this bridge version.", 501 );
            }
            $args = is_array( $body['args'] ?? null ) ? $body['args'] : array();

            @ini_set( 'display_errors', '0' ); // phpcs:ignore WordPress.PHP.IniSet, WordPress.PHP.NoSilencedErrors
            if ( ! empty( $op['write'] ) ) {
                @set_time_limit( 180 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
                wp_raise_memory_limit( 'admin' );
            }

            /* previews never change anything */
            if ( $ctx->dry_run && ! empty( $op['write'] ) ) {
                $preview = 'preview_' . $op['action'];
                $data    = method_exists( $class, $preview ) ? $class::$preview( $args, $ctx ) : array( 'dry_run' => true, 'would_run' => $ctx->op, 'args' => Policy::redact( $args ), 'note' => 'No preview available for this action; nothing was changed.' );

                return array( 200, array( 'ok' => true, 'data' => $data, 'revision' => 0, 'summary' => 'dry run' ) );
            }

            /* the same idempotency key + arguments never runs twice */
            $slot = '';
            $hash = hash( 'sha256', wp_json_encode( $args ) );
            if ( ! empty( $op['write'] ) && ! empty( $body['idempotency_key'] ) ) {
                $slot = 'wpm_i_' . substr( hash( 'sha256', $key_id . '|' . $ctx->op . '|' . $body['idempotency_key'] ), 0, 40 );
                $seen = get_transient( $slot );
                if ( is_array( $seen ) ) {
                    if ( 'running' === ( $seen['state'] ?? '' ) ) {
                        throw new BridgeError( 'busy', 'The same request is still running.', 409 );
                    }
                    if ( ( $seen['hash'] ?? '' ) !== $hash ) {
                        throw new BridgeError( 'idempotency_conflict', 'That idempotency key was used with different arguments.', 409 );
                    }

                    return array( 200, array( 'ok' => true, 'data' => $seen['data'], 'revision' => $seen['revision'], 'summary' => $seen['summary'], 'replayed' => true ) );
                }
                set_transient( $slot, array( 'state' => 'running', 'hash' => $hash ), 120 );
            }

            ob_start();
            try {
                $data = $class::$method( $args, $ctx );
            } finally {
                ob_end_clean();
            }

            if ( '' !== $slot ) {
                set_transient( $slot, array( 'state' => 'done', 'hash' => $hash, 'data' => $data, 'revision' => $ctx->revision, 'summary' => $ctx->summary ), DAY_IN_SECONDS );
            }
            if ( ! empty( $op['write'] ) ) {
                Activity::log( $ctx, 'ok' );
            }

            return array( 200, array( 'ok' => true, 'data' => $data, 'revision' => $ctx->revision, 'summary' => $ctx->summary ) );
        } catch ( BridgeError $e ) {
            self::forget_running( $slot ?? '' );
            Activity::log( $ctx, 403 === $e->status && 'level_too_low' === $e->error_code ? 'denied' : 'error', $e->getMessage() );

            return array( $e->status, array( 'ok' => false, 'error' => array( 'code' => $e->error_code, 'message' => $e->getMessage(), 'data' => $e->data ) ) );
        } catch ( \Throwable $e ) {
            self::forget_running( $slot ?? '' );
            $message = str_replace( array( ABSPATH, WP_CONTENT_DIR ), array( '/', '/wp-content' ), $e->getMessage() );
            Activity::log( $ctx, 'error', 'exception: ' . $message );

            return array( 500, array( 'ok' => false, 'error' => array( 'code' => 'exception', 'message' => 'The operation failed: ' . $message ) ) );
        }
    }

    private static function forget_running( string $slot ): void {
        if ( '' !== $slot ) {
            delete_transient( $slot );
        }
    }

    /**
     * @return array<string, mixed>
     */
    private static function error_body( string $code, string $message ): array {
        return array( 'ok' => false, 'error' => array( 'code' => $code, 'message' => $message ) );
    }

    /**
     * Sends the JSON reply (signed when a secret is known) and stops.
     *
     * @param array<string, mixed> $payload Reply.
     */
    private static function emit( int $status, array $payload, string $secret = '', string $nonce = '' ): void {
        $json = (string) wp_json_encode( $payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR );
        while ( ob_get_level() > 0 ) {
            ob_end_clean();
        }
        status_header( $status );
        header( 'Content-Type: application/json; charset=utf-8' );
        header( 'Cache-Control: no-store' );
        header( 'X-Robots-Tag: noindex' );
        if ( '' !== $secret ) {
            header( 'X-WPM-Signature: ' . Signature::response( $secret, $nonce, $json ) );
        }
        echo $json; // phpcs:ignore WordPress.Security.EscapeOutput
        exit;
    }
}
