<?php
/**
 * Part of Maintain: wp-config.php constants and the core file check.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\PhpGuard;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Revisions;
use WPMCP\Bridge\Util;

defined( 'ABSPATH' ) || exit;

trait MaintainConfig {

    private static function config_file(): string {
        foreach ( array( ABSPATH . 'wp-config.php', dirname( ABSPATH ) . '/wp-config.php' ) as $file ) {
            if ( is_file( $file ) ) {
                return $file;
            }
        }
        throw new BridgeError( 'not_found', 'wp-config.php was not found next to WordPress or one folder above.', 404 );
    }

    /** @return bool|int|float|string|null */
    private static function config_now( string $name ) {
        $value = defined( $name ) ? constant( $name ) : null;

        return is_scalar( $value ) ? $value : null;
    }

    /**
     * Current values of wp-config constants. Credentials, keys and salts are never shown.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_config_get( array $a, Context $c ): array {
        $out = array();
        foreach ( is_array( $a['names'] ?? null ) && array() !== $a['names'] ? $a['names'] : self::CONFIG_COMMON as $name ) {
            $name         = (string) $name;
            $out[ $name ] = Policy::config_name_ok( $name ) ? self::config_now( $name ) : '(not readable here)';
        }

        return array( 'constants' => $out, 'note' => 'null means the constant is not defined. Credentials, keys, salts and paths are off limits.', 'file_writable' => is_writable( self::config_file() ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_config_set( array $a, Context $c ): array {
        $name  = (string) $a['name'];
        $value = self::config_value( $a['value'] ?? null );
        Policy::config_set( (string) file_get_contents( self::config_file() ), $name, $value );

        return array( 'will_set' => $name, 'to' => $value, 'now' => self::config_now( $name ), 'file_writable' => is_writable( self::config_file() ), 'warning' => 'Edits wp-config.php. The site is probed afterwards and the file is put back if it stops answering. Not undoable with activity.undo: set the old value again to revert.' ); // phpcs:ignore WordPress.WP.AlternativeFunctions
    }

    /**
     * "true"/"false" as text mean the booleans.
     *
     * @param mixed $value Value from the caller.
     * @return mixed
     */
    private static function config_value( $value ) {
        return is_string( $value ) && in_array( strtolower( $value ), array( 'true', 'false' ), true ) ? 'true' === strtolower( $value ) : $value;
    }

    /**
     * Sets one constant in wp-config.php (WP_DEBUG, WP_MEMORY_LIMIT, DISALLOW_FILE_EDIT...).
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_config_set( array $a, Context $c ): array {
        $name   = (string) $a['name'];
        $value  = self::config_value( $a['value'] ?? null );
        $file   = self::config_file();
        $before = (string) file_get_contents( $file );
        $after  = Policy::config_set( $before, $name, $value );
        if ( null !== ( $problem = PhpGuard::problem( $after ) ) ) {
            throw new BridgeError( 'syntax_error', 'The edited wp-config.php would not parse (' . $problem . '). Nothing was written.', 400 );
        }
        $was     = self::config_now( $name );
        $healthy = PhpGuard::front_ok();
        if ( false === file_put_contents( $file, $after, LOCK_EX ) ) {
            throw new BridgeError( 'write_failed', 'wp-config.php is not writable on this host.', 500 );
        }
        if ( function_exists( 'opcache_invalidate' ) ) {
            @opcache_invalidate( $file, true ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        }
        if ( true === $healthy && false === PhpGuard::front_ok() ) {
            file_put_contents( $file, $before, LOCK_EX );
            if ( function_exists( 'opcache_invalidate' ) ) {
                @opcache_invalidate( $file, true ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
            }
            throw new BridgeError( 'broke_site', 'The site returned a server error after this change, so wp-config.php was put back.', 409 );
        }
        $c->summary = "wp-config: $name = " . var_export( $value, true );

        return array( 'name' => $name, 'value' => $value, 'previous' => $was, 'note' => 'Takes effect from the next request.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_core_verify( array $a, Context $c ): array {
        return CoreFiles::verify( $a, $c );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_core_restore( array $a, Context $c ): array {
        return CoreFiles::preview( $a, $c );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_core_restore( array $a, Context $c ): array {
        return CoreFiles::restore( $a, $c );
    }
}
