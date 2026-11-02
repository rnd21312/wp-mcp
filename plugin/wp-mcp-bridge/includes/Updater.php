<?php
/**
 * Signed updates for the bridge itself, through WordPress's own update system.
 *
 * The release publishes bridge-latest.json {version, package, sha256, signature}. WordPress then shows "update available"
 * like for any plugin, and maintain.update can apply it. Nothing is installed unless the zip's SHA-256 matches and an
 * Ed25519 signature over "wpm-bridge-update\n<version>\n<sha256>" verifies against the public key in UpdateKey.php.
 * Updates are never automatic: a person (or an AI after a confirmation) starts them.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class Updater {

    public const SLUG    = 'wp-mcp-bridge/wp-mcp-bridge.php';
    public const CONTEXT = "wpm-bridge-update\n";
    private const CACHE  = 'wpm_bridge_latest';

    /** Test seam: base64 public key used instead of includes/UpdateKey.php. */
    public static ?string $public_key = null;

    public static function init(): void {
        add_filter( 'pre_set_site_transient_update_plugins', array( self::class, 'inject' ) );
        add_filter( 'plugins_api', array( self::class, 'details' ), 10, 3 );
        add_filter( 'upgrader_pre_download', array( self::class, 'download' ), 10, 3 );
    }

    public static function source(): string {
        $url = defined( 'WPMCP_UPDATE_URL' ) ? (string) WPMCP_UPDATE_URL : 'https://github.com/rnd21312/wp-mcp/releases/latest/download/bridge-latest.json';

        return (string) apply_filters( 'wpm_bridge_update_url', $url );
    }

    public static function public_key(): string {
        if ( null !== self::$public_key ) {
            return self::$public_key;
        }
        $file = __DIR__ . '/UpdateKey.php';

        return is_file( $file ) ? (string) ( include $file ) : '';
    }

    /** https only; plain http is accepted on a development install. */
    public static function url_ok( string $url ): bool {
        $scheme = (string) wp_parse_url( $url, PHP_URL_SCHEME );

        return 'https' === $scheme || ( 'http' === $scheme && 'local' === wp_get_environment_type() );
    }

    /**
     * Shape check of a manifest. @param mixed $m Decoded JSON.
     *
     * @return array<string, string>|null Clean manifest or null.
     */
    public static function clean_manifest( $m ): ?array {
        if ( ! is_array( $m ) ) {
            return null;
        }
        $v   = (string) ( $m['version'] ?? '' );
        $pkg = (string) ( $m['package'] ?? '' );
        $sha = strtolower( (string) ( $m['sha256'] ?? '' ) );
        $sig = (string) ( $m['signature'] ?? '' );
        if ( 1 !== preg_match( '/^\d+\.\d+\.\d+$/', $v ) || 1 !== preg_match( '/^[0-9a-f]{64}$/', $sha ) || '' === $sig || ! self::url_ok( $pkg ) ) {
            return null;
        }

        return array( 'version' => $v, 'package' => $pkg, 'sha256' => $sha, 'signature' => $sig );
    }

    /** What a downloaded zip must satisfy. @return string|null Problem, or null when it may be installed. */
    public static function check_package( string $file, array $manifest, string $key_b64, string $current ): ?string {
        if ( '' === $key_b64 ) {
            return 'This bridge has no release key, so it will not install updates. Upload the new zip by hand.';
        }
        if ( ! version_compare( $manifest['version'], $current, '>' ) ) {
            return 'The update (' . $manifest['version'] . ') is not newer than this bridge (' . $current . '). Downgrades are refused.';
        }
        if ( ! hash_equals( $manifest['sha256'], (string) hash_file( 'sha256', $file ) ) ) {
            return 'The download does not match the published checksum. Nothing was changed.';
        }
        if ( ! function_exists( 'sodium_crypto_sign_verify_detached' ) ) {
            return 'This PHP cannot verify signatures, so the update was not installed.';
        }
        $key = base64_decode( $key_b64, true );
        $sig = base64_decode( $manifest['signature'], true );
        if ( false === $key || strlen( $key ) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES || false === $sig || strlen( $sig ) !== SODIUM_CRYPTO_SIGN_BYTES ) {
            return 'The update signature is malformed.';
        }
        if ( ! sodium_crypto_sign_verify_detached( $sig, self::CONTEXT . $manifest['version'] . "\n" . $manifest['sha256'], $key ) ) {
            return 'The update is not signed by the release key. Nothing was changed.';
        }

        return null;
    }

    /** The newest published release, cached for six hours (an hour after a failure). @return array<string, string>|null */
    public static function latest( bool $refresh = false ): ?array {
        if ( '' === self::public_key() ) {
            return null;
        }
        if ( $refresh ) {
            delete_transient( self::CACHE );
        }
        $cached = get_transient( self::CACHE );
        if ( is_array( $cached ) ) {
            return $cached['ok'] ? $cached['m'] : null;
        }
        $url = self::source();
        $m   = null;
        if ( self::url_ok( $url ) ) {
            $res = wp_remote_get( $url, array( 'timeout' => 10, 'redirection' => 5, 'headers' => array( 'Accept' => 'application/json' ) ) );
            if ( ! is_wp_error( $res ) && 200 === (int) wp_remote_retrieve_response_code( $res ) ) {
                $m = self::clean_manifest( json_decode( (string) wp_remote_retrieve_body( $res ), true ) );
            }
        }
        set_transient( self::CACHE, array( 'ok' => null !== $m, 'm' => $m ), null !== $m ? 6 * HOUR_IN_SECONDS : HOUR_IN_SECONDS );

        return $m;
    }

    /** A newer release than the installed one, or null. @return array<string, string>|null */
    public static function offered( bool $refresh = false ): ?array {
        $m = self::latest( $refresh );

        return $m && version_compare( $m['version'], WPMCP_VERSION, '>' ) ? $m : null;
    }

    /** @param mixed $transient update_plugins transient. @return mixed */
    public static function inject( $transient ) {
        if ( ! is_object( $transient ) ) {
            return $transient;
        }
        $m = self::offered();
        if ( $m ) {
            $transient->response[ self::SLUG ] = (object) array(
                'id'           => 'wp-mcp-bridge',
                'slug'         => 'wp-mcp-bridge',
                'plugin'       => self::SLUG,
                'new_version'  => $m['version'],
                'url'          => 'https://github.com/rnd21312/wp-mcp',
                'package'      => $m['package'],
                'requires_php' => '8.1',
            );
        }

        return $transient;
    }

    /**
     * @param mixed  $res    Result so far.
     * @param string $action Requested action.
     * @param object $args   Arguments.
     * @return mixed
     */
    public static function details( $res, $action, $args ) {
        if ( 'plugin_information' !== $action || ! is_object( $args ) || 'wp-mcp-bridge' !== ( $args->slug ?? '' ) ) {
            return $res;
        }
        $m = self::latest();

        return (object) array(
            'name'         => 'WP MCP Bridge',
            'slug'         => 'wp-mcp-bridge',
            'version'      => $m['version'] ?? WPMCP_VERSION,
            'requires_php' => '8.1',
            'homepage'     => 'https://github.com/rnd21312/wp-mcp',
            'sections'     => array( 'description' => 'Signed API that lets the WP MCP gateway manage this site. Updates are verified against the release key before they are installed.' ),
        );
    }

    /** Loads every class of the running version so no file is read from the new one half way through an update. */
    public static function preload(): void {
        foreach ( array_merge( glob( WPMCP_DIR . 'includes/*.php' ) ?: array(), glob( WPMCP_DIR . 'includes/Handlers/*.php' ) ?: array() ) as $file ) {
            require_once $file;
        }
    }

    /**
     * Downloads and verifies our own package before WordPress touches any file.
     *
     * @param mixed  $reply   Short-circuit value.
     * @param string $package Package URL.
     * @return mixed
     */
    public static function download( $reply, $package ) {
        $m = self::latest();
        if ( ! $m || $m['package'] !== (string) $package ) {
            return $reply;
        }
        self::preload();
        $tmp = wp_tempnam( 'wpm-bridge.zip' );
        $res = wp_remote_get( $m['package'], array( 'timeout' => 120, 'redirection' => 5, 'stream' => true, 'filename' => $tmp ) );
        if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) {
            @unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors

            return new \WP_Error( 'wpm_download', 'Could not download the bridge update.' );
        }
        $problem = self::check_package( $tmp, $m, self::public_key(), WPMCP_VERSION ) ?? self::zip_problem( $tmp );
        if ( null !== $problem ) {
            @unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors

            return new \WP_Error( 'wpm_bad_update', $problem );
        }

        return $tmp;
    }

    /** Only the bridge's own folder may be in the zip. */
    private static function zip_problem( string $file ): ?string {
        if ( ! class_exists( '\ZipArchive' ) ) {
            return null; // WordPress unzips with PclZip then, which refuses paths outside the target as well.
        }
        $zip = new \ZipArchive();
        if ( true !== $zip->open( $file ) ) {
            return 'The update is not a readable zip.';
        }
        $has = false;
        for ( $i = 0; $i < $zip->numFiles; $i++ ) {
            $name = (string) $zip->getNameIndex( $i );
            if ( ! str_starts_with( $name, 'wp-mcp-bridge/' ) || str_contains( $name, '..' ) ) {
                $zip->close();

                return 'The update contains a file outside the bridge folder: ' . $name;
            }
            $has = $has || 'wp-mcp-bridge/wp-mcp-bridge.php' === $name;
        }
        $zip->close();

        return $has ? null : 'The update does not contain wp-mcp-bridge.php.';
    }
}
