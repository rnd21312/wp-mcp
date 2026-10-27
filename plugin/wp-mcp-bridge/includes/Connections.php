<?php
/**
 * Gateway connections: one-time pairing codes and per-connection signing secrets.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class Connections {

    public const OPTION  = 'wpm_bridge_connections';
    public const PAIRING = 'wpm_bridge_pairing';
    public const MAX     = 10;
    public const TTL     = 900;

    private const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

    /**
     * @return array<string, array<string, mixed>>
     */
    public static function all(): array {
        $all = get_option( self::OPTION, array() );

        return is_array( $all ) ? $all : array();
    }

    /**
     * @return array<string, mixed>|null
     */
    public static function get( string $key_id ): ?array {
        return self::all()[ $key_id ] ?? null;
    }

    public static function normalize_code( string $code ): string {
        return strtoupper( (string) preg_replace( '/[^A-Za-z0-9]/', '', $code ) );
    }

    /** Makes a code like WPMP-ABCD-EFGH-JKLM-NPQR, valid 15 minutes, replacing any earlier one. */
    public static function create_pairing( int $user_id, string $ceiling ): string {
        $raw = '';
        for ( $i = 0; $i < 16; $i++ ) {
            $raw .= self::ALPHABET[ random_int( 0, 31 ) ];
        }
        update_option(
            self::PAIRING,
            array(
                'hash'     => hash( 'sha256', 'WPMP' . $raw ),
                'user'     => $user_id,
                'ceiling'  => Levels::valid( $ceiling ) ? $ceiling : 'live',
                'expires'  => time() + self::TTL,
                'attempts' => 0,
            ),
            false
        );

        return 'WPMP-' . implode( '-', str_split( $raw, 4 ) );
    }

    /**
     * Exchanges a pairing code for a connection. Single use; five wrong tries burn the code.
     *
     * @return array<string, mixed>
     */
    public static function pair( string $code, string $gateway ): array {
        $pairing = get_option( self::PAIRING, array() );
        if ( ! is_array( $pairing ) || empty( $pairing['hash'] ) || (int) $pairing['expires'] < time() ) {
            throw new BridgeError( 'no_pairing', 'No valid pairing code. Create a new one in WordPress under Tools, WP MCP Bridge.', 403 );
        }
        if ( (int) $pairing['attempts'] >= 5 ) {
            delete_option( self::PAIRING );
            throw new BridgeError( 'pairing_locked', 'Too many wrong codes. Create a new pairing code.', 403 );
        }
        if ( ! hash_equals( (string) $pairing['hash'], hash( 'sha256', self::normalize_code( $code ) ) ) ) {
            ++$pairing['attempts'];
            update_option( self::PAIRING, $pairing, false );
            throw new BridgeError( 'bad_code', 'That pairing code is wrong.', 403 );
        }
        $connections = self::all();
        if ( count( $connections ) >= self::MAX ) {
            throw new BridgeError( 'too_many', 'Too many connections. Revoke one first.', 409 );
        }
        $user = get_userdata( (int) $pairing['user'] );
        if ( ! $user || ! user_can( $user, 'manage_options' ) ) {
            throw new BridgeError( 'no_user', 'The administrator who created the code no longer exists.', 403 );
        }

        $key_id = 'k' . bin2hex( random_bytes( 6 ) );
        $secret = bin2hex( random_bytes( 32 ) );
        $connections[ $key_id ] = array(
            'secret'    => $secret,
            'user'      => (int) $pairing['user'],
            'ceiling'   => (string) $pairing['ceiling'],
            'label'     => substr( sanitize_text_field( $gateway ), 0, 80 ),
            'created'   => time(),
            'last_used' => 0,
        );
        update_option( self::OPTION, $connections, false );
        delete_option( self::PAIRING );

        return array(
            'key_id'         => $key_id,
            'secret'         => $secret,
            'site_title'     => (string) get_bloginfo( 'name' ),
            'wp_version'     => (string) get_bloginfo( 'version' ),
            'plugin_version' => WPMCP_VERSION,
            'ceiling'        => (string) $pairing['ceiling'],
            'site_url'       => home_url(),
        );
    }

    public static function revoke( string $key_id ): void {
        $all = self::all();
        unset( $all[ $key_id ] );
        update_option( self::OPTION, $all, false );
    }

    public static function set_ceiling( string $key_id, string $ceiling ): void {
        $all = self::all();
        if ( isset( $all[ $key_id ] ) && Levels::valid( $ceiling ) ) {
            $all[ $key_id ]['ceiling'] = $ceiling;
            update_option( self::OPTION, $all, false );
        }
    }

    public static function touch( string $key_id ): void {
        $all = self::all();
        if ( isset( $all[ $key_id ] ) && time() - (int) $all[ $key_id ]['last_used'] > 60 ) {
            $all[ $key_id ]['last_used'] = time();
            update_option( self::OPTION, $all, false );
        }
    }
}
