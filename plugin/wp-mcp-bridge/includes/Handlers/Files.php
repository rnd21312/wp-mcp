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
use WPMCP\Bridge\PhpGuard;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Revisions;
use WPMCP\Bridge\Util;

defined( 'ABSPATH' ) || exit;

final class Files {

    use FilesEdit, FilesTree, FilesRemote;

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
    private static function root( string $root, string $mode = 'read' ): array {
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

                $mu = wp_normalize_path( WPMU_PLUGIN_DIR );

                return is_dir( $mu ) || 'read' === $mode ? array( $mu, false ) : self::make( $mu, $mode );
            case 'themes':
            case 'plugins':
                $base = 'themes' === $kind ? get_theme_root() : WP_PLUGIN_DIR;
                $segs = array_values( array_filter( array_map( 'sanitize_file_name', explode( '/', $rest ) ), 'strlen' ) );
                if ( ! $segs ) {
                    throw new BridgeError( 'bad_root', "Use $kind/<folder-name> as the root (for example $kind/my-folder), then path for files inside it.", 400 );
                }
                $dir = wp_normalize_path( $base . '/' . implode( '/', $segs ) );

                return is_dir( $dir ) || 'read' === $mode ? ( is_dir( $dir ) ? array( $dir, false ) : self::missing( $root ) ) : self::make( $dir, $mode );
            case 'uploads':
                $base = wp_normalize_path( (string) wp_upload_dir( null, false )['basedir'] );
                $dir  = '' === $rest ? $base : wp_normalize_path( $base . '/' . $rest );
                if ( str_contains( $dir, 'wpmcp-backups' ) ) {
                    throw new BridgeError( 'forbidden', 'Backups are not browsable.', 403 );
                }

                if ( is_dir( $dir ) ) {
                    return array( $dir, true );
                }

                return 'read' === $mode ? self::missing( $root ) : self::make( $dir, $mode, true );
            default:
                throw new BridgeError( 'bad_root', 'Root must be core, themes/<slug>, plugins/<slug>, mu-plugins or uploads.', 400 );
        }
    }

    /**
     * A root that does not exist yet: planned (preview) or created (write). New theme, plugin, mu-plugins and uploads folders are allowed.
     *
     * @return array{0: string, 1: bool}
     */
    private static function make( string $dir, string $mode, bool $uploads = false ): array {
        if ( 'create' === $mode && ! wp_mkdir_p( $dir ) ) {
            throw new BridgeError( 'write_failed', 'The folder could not be created (permissions?).', 500 );
        }

        return array( $dir, $uploads );
    }

    /** Renaming to x.php.off would let the web server hand out the source as plain text; a subfolder switches a file off safely. */
    private static function refuse_off_ending( string $to ): void {
        if ( preg_match( '/^(.*?)\.(off|bak|old|orig|disabled)$/i', basename( $to ), $m ) ) {
            throw new BridgeError( 'bad_path', 'That ending is not allowed: the server would show the file as plain text. To switch a file off, move it into a subfolder instead (mu-plugins only loads files at its top level), for example to "off/' . $m[1] . '".', 400 );
        }
    }

    /** @return never */
    private static function missing( string $root ): array {
        throw new BridgeError( 'not_found', "The root \"$root\" does not exist on this site.", 404 );
    }

    /** The site owner switched on editing of WordPress's own files (Tools, WP MCP Bridge). Off by default: updates overwrite such edits. */
    public static function core_writes_on(): bool {
        return (bool) get_option( 'wpm_bridge_core_write', false );
    }

    /** Core install folder: everything readable except secrets; a few server files writable, the rest only when the owner allowed it. */
    private static function core_ok( string $path, bool $write ): bool {
        $low = strtolower( $path );
        if ( '' === $path || str_contains( $path, "\0" ) || str_contains( $path, '\\' ) || preg_match( '#(^|/)\.\.?(/|$)#', $path ) ) {
            return false;
        }
        if ( in_array( $low, array( 'wp-config.php', '.env', 'wp-config-backup.php' ), true ) || str_starts_with( $low, 'wp-content/' ) || str_contains( $low, 'wpmcp-backups' ) ) {
            return false;
        }
        if ( $write ) {
            return in_array( $low, self::CORE_WRITABLE, true ) || ( self::core_writes_on() && Policy::files_path_ok( $path, false ) );
        }

        return in_array( $low, self::CORE_WRITABLE, true ) || Policy::files_path_ok( $path, false );
    }

    private static function full( string $dir, bool $uploads, string $path, bool $must_exist, bool $write = false ): string {
        $path = trim( str_replace( '\\', '/', $path ), '/' );
        if ( self::$core ? ! self::core_ok( $path, $write ) : ! Policy::files_path_ok( $path, $uploads ) ) {
            throw new BridgeError( 'bad_path', 'File path not allowed (no .., no dot files, only known text or media types; PHP is not allowed in uploads).', 400 );
        }
        $full = $dir . '/' . $path;
        if ( ! $must_exist && ! is_dir( $dir ) ) {
            return $full; // planned root, created on write
        }
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
        $kind = trim( str_replace( '\\', '/', (string) $a['root'] ), '/' );
        if ( 'themes' === $kind || 'plugins' === $kind ) {
            $folders = array();
            foreach ( (array) glob( ( 'themes' === $kind ? get_theme_root() : WP_PLUGIN_DIR ) . '/*', GLOB_ONLYDIR ) as $d ) {
                $folders[] = basename( (string) $d );
            }
            sort( $folders );

            return array( 'root' => $kind, 'folders' => $folders, 'hint' => "Use $kind/<folder> as the root to list or write files." );
        }
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
        if ( ! is_dir( $start ) ) {
            return array( 'root' => $a['root'], 'files' => array(), 'truncated' => false, 'note' => 'This folder does not exist yet; the first write creates it.' );
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
        [ $dir, $up ] = self::root( (string) $a['root'], 'plan' );
        self::guard_self( (string) $a['root'] );
        $full  = self::full( $dir, $up, (string) $a['path'], false, true );
        $bytes = self::payload( $a );

        return array( 'will_write' => $a['path'], 'root' => $a['root'], 'exists' => is_file( $full ), 'old_bytes' => is_file( $full ) ? filesize( $full ) : 0, 'new_bytes' => strlen( $bytes ), 'syntax' => PhpGuard::file_problem( (string) $a['path'], $bytes ) ?? 'ok', 'warning' => str_ends_with( strtolower( (string) $a['path'] ), '.php' ) ? 'PHP runs with full access to the site.' : null );
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

    /** @return array<string, mixed> */
    public static function snapshot( string $root, string $path, string $full ): array {
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
        [ $dir, $up ] = self::root( $root, 'create' );
        $path         = trim( str_replace( '\\', '/', (string) $a['path'] ), '/' );
        $full         = self::full( $dir, $up, $path, false, true );
        $bytes        = self::payload( $a );
        $before = self::snapshot( $root, $path, $full );
        PhpGuard::write( $full, $path, $bytes, fn () => self::restore( $before ) );
        Revisions::record( $c, 'xfile', "$root|$path", $before );
        $c->summary = "wrote $root/$path (" . strlen( $bytes ) . ' bytes)';

        return array( 'root' => $root, 'path' => $path, 'bytes' => strlen( $bytes ), 'created' => ! $before['exists'] );
    }

    private const PART_TOTAL = 67108864;

    /** Most bytes one files.fetch_many call downloads, and the seconds after which it stops starting new downloads. */
    private const FETCH_MANY_BYTES   = 100 * 1048576;

}
