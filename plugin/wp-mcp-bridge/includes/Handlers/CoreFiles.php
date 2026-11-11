<?php
/**
 * maintain.core_verify and maintain.core_restore: compare WordPress's own files with the official checksums of api.wordpress.org
 * and put back the original of a file that was changed, deleted or is missing.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\PhpGuard;
use WPMCP\Bridge\Policy;

defined( 'ABSPATH' ) || exit;

final class CoreFiles {

    private const LIST_LIMIT = 200;

    /**
     * Official checksums of the installed version: path => md5, and the locale they belong to.
     *
     * @return array{version: string, locale: string, sums: array<string, string>}
     */
    private static function official(): array {
        require_once ABSPATH . 'wp-admin/includes/update.php';
        require_once ABSPATH . 'wp-admin/includes/file.php';
        $version = (string) get_bloginfo( 'version' );
        $locale  = (string) ( $GLOBALS['wp_local_package'] ?? 'en_US' );
        $sums    = get_core_checksums( $version, $locale );
        if ( ! is_array( $sums ) && 'en_US' !== $locale ) {
            $locale = 'en_US';
            $sums   = get_core_checksums( $version, $locale );
        }
        if ( ! is_array( $sums ) ) {
            throw new BridgeError( 'checksums_unavailable', "api.wordpress.org has no checksums for WordPress $version (a development or beta version, or the site cannot reach api.wordpress.org).", 502 );
        }
        $sums = array_filter( $sums, static fn ( $sum, $path ): bool => Policy::core_checked( (string) $path ) && is_string( $sum ), ARRAY_FILTER_USE_BOTH );

        return array( 'version' => $version, 'locale' => $locale, 'sums' => $sums );
    }

    private static function md5_of( string $path ): ?string {
        $full = ABSPATH . $path;

        return is_file( $full ) ? ( md5_file( $full ) ?: null ) : null;
    }

    /**
     * Files of wp-admin and wp-includes that WordPress does not ship (a classic sign of injected code).
     *
     * @param array<string, string> $sums Official checksums.
     * @return list<string>
     */
    private static function unexpected( array $sums ): array {
        $found = array();
        foreach ( array( 'wp-admin', 'wp-includes' ) as $folder ) {
            if ( ! is_dir( ABSPATH . $folder ) ) {
                continue;
            }
            $it = new \RecursiveIteratorIterator( new \RecursiveDirectoryIterator( ABSPATH . $folder, \FilesystemIterator::SKIP_DOTS ) );
            foreach ( $it as $file ) {
                if ( $file->isFile() ) {
                    $found[] = ltrim( str_replace( '\\', '/', substr( $file->getPathname(), strlen( rtrim( ABSPATH, '/\\' ) ) ) ), '/' );
                }
            }
        }

        return Policy::core_unexpected( $sums, $found );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function verify( array $a, Context $c ): array {
        @set_time_limit( 120 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        $o       = self::official();
        $diff    = Policy::core_compare( $o['sums'], static fn ( string $p ): ?string => self::md5_of( $p ) );
        $extra   = self::unexpected( $o['sums'] );
        $bad     = count( $diff['modified'] ) + count( $diff['missing'] ) + count( $extra );
        $cut     = static fn ( array $list ): array => array_slice( $list, 0, self::LIST_LIMIT );
        $c->summary = $bad ? "core check: $bad differences" : 'core check: all files match';

        return array(
            'ok'          => 0 === $bad,
            'version'     => $o['version'],
            'locale'      => $o['locale'],
            'checked'     => count( $o['sums'] ),
            'modified'    => $cut( $diff['modified'] ),
            'missing'     => $cut( $diff['missing'] ),
            'unexpected'  => $cut( $extra ),
            'counts'      => array( 'modified' => count( $diff['modified'] ), 'missing' => count( $diff['missing'] ), 'unexpected' => count( $extra ) ),
            'truncated'   => max( count( $diff['modified'] ), count( $diff['missing'] ), count( $extra ) ) > self::LIST_LIMIT,
            'next'        => $bad ? 'maintain.core_restore puts back the original of modified or missing files (paths, or all:true). Unexpected files are not touched: look at them with files.read (root core) and delete them with files.delete if they are not yours.' : null,
            'not_checked' => 'wp-content (themes, plugins, uploads), wp-config.php and files in the install folder that WordPress does not ship.',
        );
    }

    /**
     * The files a restore will touch, from the paths argument or all:true.
     *
     * @param array<string, mixed> $a  Arguments.
     * @param array<string, string> $sums Official checksums.
     * @return list<string>
     */
    private static function targets( array $a, array $sums ): array {
        if ( ! empty( $a['all'] ) ) {
            $diff = Policy::core_compare( $sums, static fn ( string $p ): ?string => self::md5_of( $p ) );

            return array_slice( array_merge( $diff['modified'], $diff['missing'] ), 0, self::LIST_LIMIT );
        }
        $paths = $a['paths'] ?? null;
        if ( ! is_array( $paths ) || array() === $paths || count( $paths ) > 100 ) {
            throw new BridgeError( 'bad_arguments', 'Pass paths (1-100 files from maintain.core_verify) or all:true.', 400 );
        }
        $out = array();
        foreach ( $paths as $path ) {
            $path = trim( str_replace( '\\', '/', (string) $path ), '/' );
            if ( ! isset( $sums[ $path ] ) ) {
                throw new BridgeError( 'not_core_file', "\"$path\" is not a file WordPress ships for this version (or it is outside the checked area), so there is no original to restore.", 400 );
            }
            $out[] = $path;
        }

        return array_values( array_unique( $out ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview( array $a, Context $c ): array {
        @set_time_limit( 120 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        $o     = self::official();
        $todo  = array_values( array_filter( self::targets( $a, $o['sums'] ), static fn ( string $p ): bool => self::md5_of( $p ) !== $o['sums'][ $p ] ) );

        return array(
            'will_restore'  => array_slice( $todo, 0, self::LIST_LIMIT ),
            'count'         => count( $todo ),
            'already_original' => count( self::targets( $a, $o['sums'] ) ) - count( $todo ),
            'source'        => self::zip_url( $o['version'], $o['locale'] ),
            'note'          => 'Each file is taken from the official WordPress download and only written if it matches the official checksum. The current content is kept for undo (undoing needs core edits switched on in Tools > WP MCP Bridge).',
        );
    }

    private static function zip_url( string $version, string $locale ): string {
        return 'en_US' === $locale ? "https://downloads.wordpress.org/release/wordpress-$version.zip" : "https://downloads.wordpress.org/release/$locale/wordpress-$version.zip";
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function restore( array $a, Context $c ): array {
        if ( ! class_exists( '\ZipArchive' ) ) {
            throw new BridgeError( 'no_zip', 'PHP ZipArchive is not available on this server.', 501 );
        }
        @set_time_limit( 170 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        $o    = self::official();
        $todo = array_values( array_filter( self::targets( $a, $o['sums'] ), static fn ( string $p ): bool => self::md5_of( $p ) !== $o['sums'][ $p ] ) );
        if ( array() === $todo ) {
            return array( 'restored' => array(), 'note' => 'Every requested file already matches the official version.' );
        }
        $tmp = wp_tempnam( 'wpm-core.zip' );
        $zip    = new \ZipArchive();
        $opened = false;
        try {
            \WPMCP\Bridge\Util::download( self::zip_url( $o['version'], $o['locale'] ), 80 * 1048576, $tmp );
            if ( true !== $zip->open( $tmp ) ) {
                throw new BridgeError( 'download_failed', 'The official WordPress package could not be opened.', 502 );
            }
            $opened = true;
            $plan = array();
            foreach ( $todo as $path ) {
                $bytes = $zip->getFromName( 'wordpress/' . $path );
                if ( false === $bytes || md5( $bytes ) !== $o['sums'][ $path ] ) {
                    throw new BridgeError( 'checksum_mismatch', "The package does not contain a verified original of $path. Nothing was written.", 502 );
                }
                $plan[ $path ] = $bytes;
            }
        } finally {
            if ( $opened ) {
                $zip->close();
            }
            @unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        }

        $healthy = PhpGuard::front_ok();
        $before  = array();
        try {
            foreach ( $plan as $path => $bytes ) {
                $before[] = Files::snapshot( 'core', $path, ABSPATH . $path );
                Files::put( ABSPATH . $path, $bytes );
            }
            if ( true === $healthy && false === PhpGuard::front_ok() ) {
                throw new BridgeError( 'broke_site', 'The site returned a server error after restoring, so the files were put back as they were.', 409 );
            }
        } catch ( BridgeError $e ) {
            foreach ( array_reverse( $before ) as $snap ) {
                if ( ! $snap['exists'] || null !== $snap['data'] ) {
                    Files::restore( $snap, true );
                }
            }
            throw $e;
        }
        foreach ( $before as $snap ) {
            \WPMCP\Bridge\Revisions::record( $c, 'xfile', 'core|' . $snap['path'], $snap );
        }
        $c->summary = 'restored ' . count( $plan ) . ' core files to the original of WordPress ' . $o['version'];

        return array( 'version' => $o['version'], 'restored' => array_keys( $plan ), 'count' => count( $plan ) );
    }
}
