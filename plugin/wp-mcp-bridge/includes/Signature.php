<?php
/**
 * HMAC signing shared with the gateway. Pure functions: no WordPress needed, so they are unit-tested directly.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class Signature {

    public const WINDOW = 300;

    public static function signing_string( string $ts, string $nonce, string $key_id, string $method, string $route, string $body ): string {
        return implode( "\n", array( $ts, $nonce, $key_id, strtoupper( $method ), $route, hash( 'sha256', $body ) ) );
    }

    public static function sign( string $secret, string $ts, string $nonce, string $key_id, string $method, string $route, string $body ): string {
        return hash_hmac( 'sha256', self::signing_string( $ts, $nonce, $key_id, $method, $route, $body ), $secret );
    }

    /**
     * @return string|null Error code, or null when the request is authentic and fresh.
     */
    public static function verify( string $secret, string $ts, string $nonce, string $key_id, string $method, string $route, string $body, string $given, int $now ): ?string {
        if ( ! ctype_digit( $ts ) || abs( $now - (int) $ts ) > self::WINDOW ) {
            return 'stale_request';
        }
        if ( ! preg_match( '/^[a-f0-9]{16,64}$/', $nonce ) ) {
            return 'bad_nonce';
        }

        return hash_equals( self::sign( $secret, $ts, $nonce, $key_id, $method, $route, $body ), $given ) ? null : 'bad_signature';
    }

    /** Signature the gateway checks on every reply, so a spoofed site cannot feed it answers. */
    public static function response( string $secret, string $nonce, string $body ): string {
        return hash_hmac( 'sha256', $nonce . "\n" . hash( 'sha256', $body ), $secret );
    }
}
