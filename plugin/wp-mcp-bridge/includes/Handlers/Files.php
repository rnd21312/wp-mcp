<?php
/**
 * files.* operations: browse and change files under wp-content (themes, plugins, mu-plugins, uploads). Admin only.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Revisions;
use WPMCP\Bridge\Util;

defined( 'ABSPATH' ) || exit;

final class Files {

    private const TEXT = array( 'php', 'css', 'js', 'json', 'html', 'htm', 'txt', 'svg', 'md', 'twig', 'xml', 'po', 'pot', 'ini', 'yml', 'yaml', 'map' );

    private const MAX = 2097152;

    /** True while the current root is the WordPress install folder. */
    private static bool $core = false;

    private const CORE_WRITABLE = array( '.htaccess', 'robots.txt', '.user.ini', 'php.ini', 'web.config' );

    /**
     * Absolute directory of a root.
     *
     * @return array{0: string, 1: bool} Directory and whether it is the uploads area.
     */
    private static function root( string $root ): array {
        self::$core = false;
        $root  = trim( str_replace( '\\', '/', $root ), '/' );
        $parts = explode( '/', $root, 2 );
        $kind  = $parts[0];
        $rest  = $parts[1] ?? '';
        if ( preg_match( '#(^|/)\.\.?(/|$)#', $rest ) || str_contains( $rest, "\0" ) ) {
            throw new BridgeError( 'bad_root', 'Invalid root.', 400 );
        }
        switch ( $kind ) {
            case 'core':
                if ( '' !== $rest ) {
                    throw new BridgeError( 'bad_root', 'Use path for subfolders of core.', 400 );
                }
                self::$core = true;

                return array( wp_normalize_path( untrailingslashit( ABSPATH ) ), false );
            case 'mu-plugins':
                if ( '' !== $rest ) {
                    throw new BridgeError( 'bad_root', 'Use path for subfolders of mu-plugins.', 400 );
                }

                return array( wp_normalize_path( WPMU_PLUGIN_DIR ), false );
            case 'themes':
                $dir = wp_normalize_path( get_theme_root() . '/' . sanitize_file_name( $rest ) );
                break;
            case 'plugins':
                $dir = wp_normalize_path( WP_PLUGIN_DIR . '/' . sanitize_file_name( $rest ) );
                break;
            case 'uploads':
                $base = wp_normalize_path( (string) wp_upload_dir( null, false )['basedir'] );
                $dir  = '' === $rest ? $base : wp_normalize_path( $base . '/' . $rest );
                if ( str_contains( $dir, 'wpmcp-backups' ) ) {
                    throw new BridgeError( 'forbidden', 'Backups are not browsable.', 403 );
                }

                return is_dir( $dir ) ? array( $dir, true ) : self::missing( $root );
            default:
                throw new BridgeError( 'bad_root', 'Root must be core, themes/<slug>, plugins/<slug>, mu-plugins or uploads.', 400 );
        }
        if ( '' === $rest || str_contains( $rest, '/' ) ) {
            throw new BridgeError( 'bad_root', "Use $kind/<folder-name> as the root, then path for anything deeper.", 400 );
        }

        return is_dir( $dir ) ? array( $dir, false ) : self::missing( $root );
    }

    /** @return never */
    private static function missing( string $root ): array {
        throw new BridgeError( 'not_found', "The root \"$root\" does not exist on this site.", 404 );
    }

    /** Core install folder: everything readable except secrets; only a few server files writable. */
    private static function core_ok( string $path, bool $write ): bool {
        $low = strtolower( $path );
        if ( '' === $path || str_contains( $path, "\0" ) || str_contains( $path, '\\' ) || preg_match( '#(^|/)\.\.?(/|$)#', $path ) ) {
            return false;
        }
        if ( in_array( $low, array( 'wp-config.php', '.env', 'wp-config-backup.php' ), true ) || str_starts_with( $low, 'wp-content/' ) || str_contains( $low, 'wpmcp-backups' ) ) {
            return false;
        }
        if ( $write ) {
            return in_array( $low, self::CORE_WRITABLE, true );
        }

        return in_array( $low, self::CORE_WRITABLE, true ) || Policy::files_path_ok( $path, false );
    }

    private static function full( string $dir, bool $uploads, string $path, bool $must_exist, bool $write = false ): string {
        $path = trim( str_replace( '\\', '/', $path ), '/' );
        if ( self::$core ? ! self::core_ok( $path, $write ) : ! Policy::files_path_ok( $path, $uploads ) ) {
            throw new BridgeError( 'bad_path', 'File path not allowed (no .., no dot files, only known text or media types; PHP is not allowed in uploads).', 400 );
        }
        $full = $dir . '/' . $path;
        if ( $must_exist ) {
            $real = realpath( $full );
            if ( false === $real || ! str_starts_with( wp_normalize_path( $real ), $dir . '/' ) ) {
                throw new BridgeError( 'not_found', 'No such file.', 404 );
            }

            return $full;
        }
        $ancestor = dirname( $full );
        while ( ! is_dir( $ancestor ) && strlen( $ancestor ) > strlen( $dir ) ) {
            $ancestor = dirname( $ancestor );
        }
        $real = realpath( $ancestor );
        if ( false === $real || ( wp_normalize_path( $real ) !== $dir && ! str_starts_with( wp_normalize_path( $real ), $dir . '/' ) ) ) {
            throw new BridgeError( 'bad_path', 'Path escapes the root.', 400 );
        }

        return $full;
    }

    private static function guard_self( string $root ): void {
        if ( 'plugins/wp-mcp-bridge' === trim( $root, '/' ) ) {
            throw new BridgeError( 'protected', 'The bridge cannot modify its own files.', 400 );
        }
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_list( array $a, Context $c ): array {
        [ $dir ]  = self::root( (string) $a['root'] );
        $start    = $dir;
        if ( ! empty( $a['path'] ) ) {
            $sub = trim( str_replace( '\\', '/', (string) $a['path'] ), '/' );
            if ( preg_match( '#(^|/)\.\.?(/|$)#', $sub ) || preg_match( '#(^|/)\.#', $sub ) ) {
                throw new BridgeError( 'bad_path', 'Invalid path.', 400 );
            }
            $start = $dir . '/' . $sub;
            $real  = realpath( $start );
            if ( false === $real || ! is_dir( $real ) || ! str_starts_with( wp_normalize_path( $real ) . '/', $dir . '/' ) ) {
                throw new BridgeError( 'not_found', 'No such folder.', 404 );
            }
        }
        $it = new \RecursiveIteratorIterator( new \RecursiveDirectoryIterator( $start, \FilesystemIterator::SKIP_DOTS ), \RecursiveIteratorIterator::SELF_FIRST );
        $it->setMaxDepth( max( 0, min( 3, (int) ( $a['depth'] ?? 2 ) - 1 ) ) );
        $files = array();
        foreach ( $it as $f ) {
            if ( count( $files ) >= 400 ) {
                break;
            }
            $rel = ltrim( substr( wp_normalize_path( $f->getPathname() ), strlen( $dir ) ), '/' );
            if ( self::$core && ( str_starts_with( $rel, 'wp-content' ) || 'wp-config.php' === $rel ) ) {
                continue;
            }
            if ( $f->isFile() && ( ! preg_match( '#(^|/)\.#', $rel ) || ( self::$core && in_array( $rel, self::CORE_WRITABLE, true ) ) ) && ! str_contains( $rel, 'node_modules/' ) ) {
                $files[] = array( 'path' => $rel, 'bytes' => $f->getSize(), 'modified' => gmdate( 'c', $f->getMTime() ) );
            }
        }
        sort( $files );

        return array( 'root' => $a['root'], 'files' => $files, 'truncated' => count( $files ) >= 400 );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_read( array $a, Context $c ): array {
        [ $dir, $up ] = self::root( (string) $a['root'] );
        $full         = self::full( $dir, $up, (string) $a['path'], true );
        $size         = (int) filesize( $full );
        $off          = max( 0, (int) ( $a['offset'] ?? 0 ) );
        $text         = in_array( strtolower( pathinfo( $full, PATHINFO_EXTENSION ) ), self::TEXT, true );
        $bytes        = (string) file_get_contents( $full, false, null, $off, self::MAX );
        $more         = $off + strlen( $bytes ) < $size;

        return $text
            ? array( 'path' => $a['path'], 'bytes' => $size, 'encoding' => 'utf8', 'truncated' => $more, 'content' => $bytes )
            : array( 'path' => $a['path'], 'bytes' => $size, 'encoding' => 'base64', 'truncated' => $more, 'data_base64' => base64_encode( $bytes ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_write( array $a, Context $c ): array {
        [ $dir, $up ] = self::root( (string) $a['root'] );
        self::guard_self( (string) $a['root'] );
        $full  = self::full( $dir, $up, (string) $a['path'], false, true );
        $bytes = self::payload( $a );

        return array( 'will_write' => $a['path'], 'root' => $a['root'], 'exists' => is_file( $full ), 'old_bytes' => is_file( $full ) ? filesize( $full ) : 0, 'new_bytes' => strlen( $bytes ), 'syntax' => self::php_problem( (string) $a['path'], $bytes ) ?? 'ok', 'warning' => str_ends_with( strtolower( (string) $a['path'] ), '.php' ) ? 'PHP runs with full access to the site.' : null );
    }

    private static function payload( array $a ): string {
        if ( isset( $a['data_base64'] ) ) {
            $bytes = base64_decode( (string) $a['data_base64'], true );
            if ( false === $bytes ) {
                throw new BridgeError( 'bad_data', 'data_base64 is not valid base64.', 400 );
            }
        } else {
            $bytes = (string) ( $a['content'] ?? '' );
        }
        if ( strlen( $bytes ) > self::MAX ) {
            throw new BridgeError( 'too_large', 'Files are limited to 2 MB per call.', 400 );
        }

        return $bytes;
    }

    private static function php_problem( string $path, string $bytes ): ?string {
        if ( 'php' !== strtolower( pathinfo( $path, PATHINFO_EXTENSION ) ) ) {
            return null;
        }
        try {
            token_get_all( $bytes, TOKEN_PARSE );
        } catch ( \ParseError $e ) {
            return 'PHP syntax error on line ' . $e->getLine() . ': ' . $e->getMessage();
        }

        return null;
    }

    private static function put( string $full, string $bytes ): void {
        wp_mkdir_p( dirname( $full ) );
        $tmp = $full . '.wpm-' . bin2hex( random_bytes( 4 ) );
        if ( false === file_put_contents( $tmp, $bytes ) || ! rename( $tmp, $full ) ) {
            @unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
            throw new BridgeError( 'write_failed', 'The file could not be written (permissions?).', 500 );
        }
        if ( function_exists( 'opcache_invalidate' ) ) {
            @opcache_invalidate( $full, true ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        }
    }

    private static function front_ok(): ?bool {
        try {
            return Util::fetch_own( home_url( '/?wpm_check=' . time() ) )['status'] < 500;
        } catch ( BridgeError $e ) {
            return null;
        }
    }

    /** @return array<string, mixed> */
    private static function snapshot( string $root, string $path, string $full ): array {
        $exists = is_file( $full );
        $bytes  = $exists ? (string) file_get_contents( $full ) : '';

        return array( 'root' => $root, 'path' => $path, 'exists' => $exists, 'data' => strlen( $bytes ) <= 1500000 ? base64_encode( $bytes ) : null );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_write( array $a, Context $c ): array {
        $root = (string) $a['root'];
        self::guard_self( $root );
        [ $dir, $up ] = self::root( $root );
        $path         = trim( str_replace( '\\', '/', (string) $a['path'] ), '/' );
        $full         = self::full( $dir, $up, $path, false, true );
        $bytes        = self::payload( $a );
        if ( null !== ( $problem = self::php_problem( $path, $bytes ) ) ) {
            throw new BridgeError( 'syntax_error', $problem . ' Nothing was written.', 400 );
        }
        $before  = self::snapshot( $root, $path, $full );
        $healthy = 'php' === strtolower( pathinfo( $path, PATHINFO_EXTENSION ) ) ? self::front_ok() : null;
        self::put( $full, $bytes );
        if ( true === $healthy && false === self::front_ok() ) {
            self::restore( $before );
            throw new BridgeError( 'broke_site', 'The site returned a server error after this change, so it was reverted automatically.', 409 );
        }
        Revisions::record( $c, 'xfile', "$root|$path", $before );
        $c->summary = "wrote $root/$path (" . strlen( $bytes ) . ' bytes)';

        return array( 'root' => $root, 'path' => $path, 'bytes' => strlen( $bytes ), 'created' => ! $before['exists'] );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_delete( array $a, Context $c ): array {
        [ $dir, $up ] = self::root( (string) $a['root'] );
        self::guard_self( (string) $a['root'] );
        $full = self::full( $dir, $up, (string) $a['path'], true, true );

        return array( 'will_delete' => $a['path'], 'bytes' => filesize( $full ), 'undo' => filesize( $full ) <= 1500000 ? 'possible' : 'not possible (file too large to snapshot)' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_delete( array $a, Context $c ): array {
        $root = (string) $a['root'];
        self::guard_self( $root );
        [ $dir, $up ] = self::root( $root );
        $path         = trim( str_replace( '\\', '/', (string) $a['path'] ), '/' );
        $full         = self::full( $dir, $up, $path, true, true );
        $before       = self::snapshot( $root, $path, $full );
        unlink( $full );
        if ( null !== $before['data'] ) {
            Revisions::record( $c, 'xfile', "$root|$path", $before );
        }
        $c->summary = "deleted $root/$path";

        return array( 'deleted' => $path, 'undoable' => null !== $before['data'] );
    }

    /**
     * Puts a file back as it was (used by undo and by the automatic revert).
     *
     * @param array<string, mixed> $before Snapshot.
     */
    public static function restore( array $before ): string {
        $root = (string) ( $before['root'] ?? '' );
        self::guard_self( $root );
        [ $dir, $up ] = self::root( $root );
        $path         = (string) ( $before['path'] ?? '' );
        $full         = self::full( $dir, $up, $path, false, true );
        if ( ! empty( $before['exists'] ) ) {
            if ( null === ( $before['data'] ?? null ) ) {
                throw new BridgeError( 'not_undoable', 'The old content was too large to snapshot.', 409 );
            }
            self::put( $full, (string) base64_decode( (string) $before['data'], true ) );

            return "Restored $root/$path.";
        }
        if ( is_file( $full ) ) {
            unlink( $full );
        }

        return "Removed $root/$path (it did not exist before).";
    }
}
