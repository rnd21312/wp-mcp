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

    public static function put( string $full, string $bytes ): void {
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
    public static function preview_write_many( array $a, Context $c ): array {
        $out = array();
        foreach ( self::batch( $a ) as $f ) {
            $out[] = self::preview_write( array( 'root' => $a['root'] ) + $f, $c );
        }

        return array( 'files' => $out, 'count' => count( $out ) );
    }

    /**
     * Writes several files in one call (a whole theme or plugin skeleton), all or nothing: every file is checked first,
     * then all are written, then the site is probed once. If anything fails, every file is put back.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_write_many( array $a, Context $c ): array {
        $root = (string) $a['root'];
        self::guard_self( $root );
        [ $dir, $up ] = self::root( $root, 'create' );
        $plan         = array();
        $problems     = array();
        $has_php      = false;
        foreach ( self::batch( $a ) as $f ) {
            $path = trim( str_replace( '\\', '/', (string) $f['path'] ), '/' );
            try {
                $full    = self::full( $dir, $up, $path, false, true );
                $bytes   = self::payload( $f );
                $problem = self::php_problem( $path, $bytes );
                if ( null !== $problem ) {
                    throw new BridgeError( 'syntax_error', $problem, 400 );
                }
                $has_php = $has_php || 'php' === strtolower( pathinfo( $path, PATHINFO_EXTENSION ) );
                $plan[]  = array( 'path' => $path, 'full' => $full, 'bytes' => $bytes );
            } catch ( BridgeError $e ) {
                $problems[] = array( 'path' => $path, 'error' => $e->getMessage() );
            }
        }
        if ( array() !== $problems ) {
            throw new BridgeError( 'rejected', count( $problems ) . ' of ' . ( count( $plan ) + count( $problems ) ) . ' files have a problem. Nothing was written.', 400, array( 'files' => $problems ) );
        }
        $healthy = $has_php ? self::front_ok() : null;
        $before  = array();
        try {
            foreach ( $plan as $f ) {
                $before[] = self::snapshot( $root, $f['path'], $f['full'] );
                self::put( $f['full'], $f['bytes'] );
            }
            if ( true === $healthy && false === self::front_ok() ) {
                throw new BridgeError( 'broke_site', 'The site returned a server error after these changes, so all of them were reverted automatically. Check maintain.logs for the PHP error.', 409 );
            }
        } catch ( BridgeError $e ) {
            foreach ( array_reverse( $before ) as $snap ) {
                if ( $snap['exists'] && null === $snap['data'] ) {
                    continue; // too large to snapshot; left as written
                }
                self::restore( $snap );
            }
            throw $e;
        }
        $done = array();
        foreach ( $plan as $i => $f ) {
            Revisions::record( $c, 'xfile', "$root|{$f['path']}", $before[ $i ] );
            $done[] = array( 'root' => $root, 'path' => $f['path'], 'bytes' => strlen( $f['bytes'] ), 'created' => ! $before[ $i ]['exists'], 'ok' => true );
        }
        $c->summary = 'wrote ' . count( $done ) . ' files to ' . $root;

        return array( 'root' => $root, 'files' => $done );
    }

    /**
     * The file text after the edits, and how many replacements that took.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array{0: string, 1: int}
     */
    private static function patched( array $a, Context $c ): array {
        $read = self::op_read( array( 'root' => $a['root'], 'path' => $a['path'] ), $c );
        if ( 'utf8' !== $read['encoding'] || ! empty( $read['truncated'] ) ) {
            throw new BridgeError( 'not_text', 'Only text files up to 2 MB can be patched.', 400 );
        }

        return Policy::apply_edits( (string) $read['content'], is_array( $a['edits'] ?? null ) ? $a['edits'] : array() );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_patch( array $a, Context $c ): array {
        [ $text, $count ] = self::patched( $a, $c );

        return array( 'replacements' => $count ) + self::preview_write( array( 'root' => $a['root'], 'path' => $a['path'], 'content' => $text ), $c );
    }

    /**
     * Changes parts of a text file by exact replacement, so a small edit does not need the whole file sent back.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_patch( array $a, Context $c ): array {
        [ $text, $count ] = self::patched( $a, $c );
        $written          = self::op_write( array( 'root' => $a['root'], 'path' => $a['path'], 'content' => $text ), $c );
        $c->summary       = "patched {$a['root']}/{$written['path']} ($count replacements)";

        return $written + array( 'replacements' => $count );
    }

    /**
     * Finds text in the files of a root: where a function, class name, hook or string lives.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_search( array $a, Context $c ): array {
        $query = (string) $a['query'];
        if ( '' === $query || strlen( $query ) > 300 ) {
            throw new BridgeError( 'bad_arguments', 'query must be 1-300 characters.', 400 );
        }
        $re = '~' . ( empty( $a['regex'] ) ? preg_quote( $query, '~' ) : str_replace( '~', '\~', $query ) ) . '~u' . ( empty( $a['case'] ) ? 'i' : '' );
        if ( false === @preg_match( $re, '' ) ) { // phpcs:ignore WordPress.PHP.NoSilencedErrors
            throw new BridgeError( 'bad_arguments', 'query is not a valid regular expression.', 400 );
        }
        $listed = self::op_list( array( 'root' => $a['root'], 'depth' => 4 ) + ( empty( $a['path'] ) ? array() : array( 'path' => $a['path'] ) ), $c );
        if ( ! isset( $listed['files'] ) ) {
            throw new BridgeError( 'bad_root', 'Search inside one folder: themes/<folder>, plugins/<folder>, mu-plugins, uploads or core.', 400 );
        }
        [ $dir ] = self::root( (string) $a['root'] );
        $max     = max( 1, min( 200, (int) ( $a['max'] ?? 50 ) ) );
        $hits    = array();
        $scanned = 0;
        $until   = microtime( true ) + 8;
        foreach ( $listed['files'] as $f ) {
            if ( count( $hits ) >= $max || microtime( true ) > $until ) {
                break;
            }
            if ( $f['bytes'] > 1048576 || ! in_array( strtolower( pathinfo( $f['path'], PATHINFO_EXTENSION ) ), self::TEXT, true ) ) {
                continue;
            }
            ++$scanned;
            foreach ( (array) file( $dir . '/' . $f['path'], FILE_IGNORE_NEW_LINES ) as $n => $line ) {
                if ( 1 === preg_match( $re, (string) $line ) ) {
                    $hits[] = array( 'path' => $f['path'], 'line' => $n + 1, 'text' => mb_substr( trim( (string) $line ), 0, 240 ) );
                    if ( count( $hits ) >= $max ) {
                        break;
                    }
                }
            }
        }

        return array( 'root' => $a['root'], 'query' => $query, 'matches' => $hits, 'files_scanned' => $scanned, 'truncated' => count( $hits ) >= $max || ! empty( $listed['truncated'] ) || microtime( true ) > $until );
    }

    private const PART_TOTAL = 67108864;

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_upload_part( array $a, Context $c ): array {
        [ $dir, $up ] = self::root( (string) $a['root'], 'plan' );
        $full         = self::full( $dir, $up, (string) $a['path'], false, true );

        return array( 'will_write' => $a['path'], 'root' => $a['root'], 'exists' => is_file( $full ) );
    }

    /**
     * One piece of a large file (media, fonts, archives; up to 64 MB in total). Pieces arrive in order; the last one puts the file in place.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_upload_part( array $a, Context $c ): array {
        $root = (string) $a['root'];
        self::guard_self( $root );
        $id = (string) $a['upload'];
        if ( 1 !== preg_match( '/^[a-f0-9]{16}$/', $id ) ) {
            throw new BridgeError( 'bad_arguments', 'upload must be 16 hex characters, the same for every piece of one file.', 400 );
        }
        [ $dir, $up ] = self::root( $root, 'create' );
        $path         = trim( str_replace( '\\', '/', (string) $a['path'] ), '/' );
        $full         = self::full( $dir, $up, $path, false, true );
        if ( 'php' === strtolower( pathinfo( $path, PATHINFO_EXTENSION ) ) ) {
            throw new BridgeError( 'bad_path', 'PHP files go through files.write, where they are syntax-checked.', 400 );
        }
        $bytes  = self::payload( $a );
        $offset = max( 0, (int) ( $a['offset'] ?? 0 ) );
        $tmp    = dirname( $full ) . '/.wpm-up-' . $id;
        wp_mkdir_p( dirname( $full ) );
        $have = 0 !== $offset && is_file( $tmp ) ? (int) filesize( $tmp ) : 0;
        if ( $have !== $offset ) {
            throw new BridgeError( 'out_of_order', "This upload has $have bytes so far; the next piece must start there.", 409, array( 'received' => $have ) );
        }
        if ( $have + strlen( $bytes ) > self::PART_TOTAL ) {
            @unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
            throw new BridgeError( 'too_large', 'Uploads are limited to 64 MB.', 400 );
        }
        if ( false === file_put_contents( $tmp, $bytes, 0 === $offset ? 0 : FILE_APPEND ) ) {
            throw new BridgeError( 'write_failed', 'The piece could not be stored (permissions or disk space?).', 500 );
        }
        clearstatcache( true, $tmp );
        $size = (int) filesize( $tmp );
        if ( empty( $a['last'] ) ) {
            return array( 'path' => $path, 'received' => $size, 'done' => false );
        }
        $before = self::snapshot( $root, $path, $full );
        if ( ! rename( $tmp, $full ) ) {
            @unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
            throw new BridgeError( 'write_failed', 'The file could not be put in place (permissions?).', 500 );
        }
        if ( ! $before['exists'] || null !== $before['data'] ) {
            Revisions::record( $c, 'xfile', "$root|$path", $before );
        }
        $c->summary = "uploaded $root/$path ($size bytes)";

        return array( 'root' => $root, 'path' => $path, 'bytes' => $size, 'created' => ! $before['exists'], 'done' => true );
    }

    /** @return list<array<string, mixed>> */
    private static function batch( array $a ): array {
        $files = $a['files'] ?? null;
        if ( ! is_array( $files ) || array() === $files || count( $files ) > 60 ) {
            throw new BridgeError( 'bad_arguments', 'files must be a list of 1-60 items like {path, content | data_base64}.', 400 );
        }
        $out = array();
        foreach ( $files as $f ) {
            if ( ! is_array( $f ) || empty( $f['path'] ) ) {
                throw new BridgeError( 'bad_arguments', 'Every file needs a path.', 400 );
            }
            $out[] = array_intersect_key( $f, array_flip( array( 'path', 'content', 'data_base64' ) ) );
        }

        return $out;
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
    public static function restore( array $before, bool $core_verified = false ): string {
        $root = (string) ( $before['root'] ?? '' );
        self::guard_self( $root );
        [ $dir, $up ] = self::root( $root, 'create' );
        $path         = (string) ( $before['path'] ?? '' );
        // A core file whose original was verified against the official checksums may be put back without the owner's core-edit switch.
        $full = $core_verified && 'core' === $root ? ABSPATH . $path : self::full( $dir, $up, $path, false, true );
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

    /** Folder path inside a root: plain segments only. */
    private static function dir_full( string $dir, string $path ): string {
        $path = trim( str_replace( '\\', '/', $path ), '/' );
        if ( '' === $path || strlen( $path ) > 240 || str_contains( $path, "\0" ) || str_contains( $path, 'wpmcp-backups' ) || preg_match( '#(^|/)\.#', $path ) || preg_match( '#[^A-Za-z0-9_./ -]#', $path ) ) {
            throw new BridgeError( 'bad_path', 'Folder path not allowed (letters, digits, dash, underscore, dot inside names; no dot folders).', 400 );
        }

        return $dir . '/' . $path;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_mkdir( array $a, Context $c ): array {
        $root = (string) $a['root'];
        self::guard_self( $root );
        if ( self::is_core( $root ) ) {
            throw new BridgeError( 'forbidden', 'Folders cannot be created in the core root.', 403 );
        }
        [ $dir ] = self::root( $root, 'create' );
        $full    = self::dir_full( $dir, (string) $a['path'] );
        if ( ! wp_mkdir_p( $full ) ) {
            throw new BridgeError( 'write_failed', 'The folder could not be created (permissions?).', 500 );
        }
        $c->summary = "created folder $root/" . trim( (string) $a['path'], '/' );

        return array( 'root' => $root, 'path' => trim( (string) $a['path'], '/' ), 'created' => true );
    }

    private static function is_core( string $root ): bool {
        return 'core' === trim( str_replace( '\\', '/', $root ), '/' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_rmdir( array $a, Context $c ): array {
        [ $dir ] = self::root( (string) $a['root'] );
        $full    = self::dir_full( $dir, (string) $a['path'] );
        $n       = 0;
        if ( is_dir( $full ) ) {
            foreach ( new \RecursiveIteratorIterator( new \RecursiveDirectoryIterator( $full, \FilesystemIterator::SKIP_DOTS ) ) as $f ) {
                ++$n;
            }
        }

        return array( 'will_delete_folder' => $a['path'], 'exists' => is_dir( $full ), 'files_inside' => $n, 'undo' => 'not possible', 'warning' => 'Removes the folder and everything inside it.' );
    }

    /**
     * Deletes a folder (recursively). Not undoable.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_rmdir( array $a, Context $c ): array {
        $root = (string) $a['root'];
        self::guard_self( $root );
        if ( self::is_core( $root ) ) {
            throw new BridgeError( 'forbidden', 'Folders cannot be removed from the core root.', 403 );
        }
        [ $dir ] = self::root( $root );
        $full    = self::dir_full( $dir, (string) $a['path'] );
        $real    = realpath( $full );
        if ( false === $real || ! is_dir( $real ) || ! str_starts_with( wp_normalize_path( $real ) . '/', $dir . '/' ) || wp_normalize_path( $real ) === $dir ) {
            throw new BridgeError( 'not_found', 'No such folder inside the root.', 404 );
        }
        $it = new \RecursiveIteratorIterator( new \RecursiveDirectoryIterator( $real, \FilesystemIterator::SKIP_DOTS ), \RecursiveIteratorIterator::CHILD_FIRST );
        foreach ( $it as $f ) {
            $f->isDir() && ! $f->isLink() ? rmdir( $f->getPathname() ) : unlink( $f->getPathname() );
        }
        rmdir( $real );
        $c->summary = "removed folder $root/" . trim( (string) $a['path'], '/' );

        return array( 'deleted' => trim( (string) $a['path'], '/' ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_move( array $a, Context $c ): array {
        self::refuse_off_ending( (string) $a['to'] );

        return array( 'will_move' => $a['from'], 'to' => $a['to'], 'root' => $a['root'] );
    }

    /**
     * Moves or renames a file inside a root (undoable).
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_move( array $a, Context $c ): array {
        self::refuse_off_ending( (string) $a['to'] );
        $read = self::op_read( array( 'root' => $a['root'], 'path' => $a['from'] ), $c );
        $data = 'base64' === $read['encoding'] ? array( 'data_base64' => $read['data_base64'] ) : array( 'content' => $read['content'] );
        if ( ! empty( $read['truncated'] ) ) {
            throw new BridgeError( 'too_large', 'The file is larger than 2 MB; use FTP or a zip for big files.', 400 );
        }
        $written = self::op_write( array( 'root' => $a['root'], 'path' => $a['to'] ) + $data, $c );
        self::op_delete( array( 'root' => $a['root'], 'path' => $a['from'] ), $c );
        $c->summary = "moved {$a['root']}/{$a['from']} to {$a['to']}";

        return array( 'from' => $a['from'], 'to' => $written['path'] );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_copy( array $a, Context $c ): array {
        return array( 'will_copy' => $a['from'], 'to' => $a['to'], 'root' => $a['root'] );
    }

    /**
     * Copies a file inside a root.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_copy( array $a, Context $c ): array {
        $read = self::op_read( array( 'root' => $a['root'], 'path' => $a['from'] ), $c );
        if ( ! empty( $read['truncated'] ) ) {
            throw new BridgeError( 'too_large', 'The file is larger than 2 MB.', 400 );
        }
        $data = 'base64' === $read['encoding'] ? array( 'data_base64' => $read['data_base64'] ) : array( 'content' => $read['content'] );
        $w    = self::op_write( array( 'root' => $a['root'], 'path' => $a['to'] ) + $data, $c );
        $c->summary = "copied {$a['root']}/{$a['from']} to {$a['to']}";

        return array( 'from' => $a['from'], 'to' => $w['path'] );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_fetch( array $a, Context $c ): array {
        $problem = Policy::url_problem( (string) $a['url'] );

        return array( 'will_download' => (string) $a['url'], 'into' => $a['root'] . '/' . $a['path'], 'allowed' => null === $problem, 'problem' => $problem, 'rules' => 'https only, redirects re-checked, no private addresses, max 20 MB, allowed file types only' );
    }

    /**
     * Downloads an https file straight into a root (fonts, images, scripts for a theme).
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_fetch( array $a, Context $c ): array {
        $root = (string) $a['root'];
        self::guard_self( $root );
        [ $dir, $up ] = self::root( $root, 'plan' );
        $path         = trim( str_replace( '\\', '/', (string) $a['path'] ), '/' );
        $done         = self::fetch_one( $root, $dir, $up, $path, (string) $a['url'], $c );
        $c->summary   = "downloaded into $root/$path ({$done['bytes']} bytes)";

        return $done;
    }

    /**
     * One download into a root: size and PHP syntax checked, previous content kept for undo.
     *
     * @return array<string, mixed>
     */
    private static function fetch_one( string $root, string $dir, bool $up, string $path, string $url, Context $c ): array {
        $full = self::full( $dir, $up, $path, false, true );
        $got  = Util::download( $url, 20971521 );
        if ( strlen( $got['body'] ) > 20971520 || '' === $got['body'] ) {
            throw new BridgeError( 'bad_size', 'The download is empty or larger than 20 MB.', 400 );
        }
        if ( null !== ( $problem = self::php_problem( $path, $got['body'] ) ) ) {
            throw new BridgeError( 'syntax_error', $problem . ' Nothing was written.', 400 );
        }
        $before = self::snapshot( $root, $path, $full );
        self::put( $full, $got['body'] );
        Revisions::record( $c, 'xfile', "$root|$path", $before );

        return array( 'root' => $root, 'path' => $path, 'bytes' => strlen( $got['body'] ), 'source' => $got['url'] );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_fetch_many( array $a, Context $c ): array {
        $rows = array();
        foreach ( Policy::fetch_plan( $a['items'] ?? null ) as $item ) {
            $problem = Policy::url_problem( $item['url'] );
            $rows[]  = array( 'will_download' => $item['url'], 'into' => $a['root'] . '/' . $item['path'], 'allowed' => null === $problem, 'problem' => $problem );
        }

        return array( 'downloads' => $rows, 'count' => count( $rows ), 'rules' => 'https only, redirects re-checked, no private addresses, max 20 MB each and ' . self::FETCH_MANY_BYTES / 1048576 . ' MB together, allowed file types only. Each file is checked and saved on its own: a failed one does not undo the others.' );
    }

    /** Most bytes one files.fetch_many call downloads, and the seconds after which it stops starting new downloads. */
    private const FETCH_MANY_BYTES   = 100 * 1048576;
    private const FETCH_MANY_SECONDS = 100;

    /**
     * Downloads up to 25 https files into one root with one confirmation (fonts, images, scripts for a theme). Not all or nothing:
     * every file is saved (and undoable) on its own, failures are listed. When the size or time budget runs out the rest is
     * reported as "not_started" so the caller can send them again.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_fetch_many( array $a, Context $c ): array {
        $root = (string) $a['root'];
        self::guard_self( $root );
        [ $dir, $up ] = self::root( $root, 'plan' );
        $plan         = Policy::fetch_plan( $a['items'] ?? null );
        @set_time_limit( 170 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        $started = time();
        $total        = 0;
        $results      = array();
        foreach ( $plan as $item ) {
            if ( $total >= self::FETCH_MANY_BYTES || time() - $started > self::FETCH_MANY_SECONDS ) {
                $results[] = array( 'path' => $item['path'], 'source' => $item['url'], 'ok' => false, 'error' => 'not_started', 'message' => 'The size or time budget of this call ran out. Send this item again in a new call.' );
                continue;
            }
            try {
                $done      = self::fetch_one( $root, $dir, $up, $item['path'], $item['url'], $c );
                $total    += (int) $done['bytes'];
                $results[] = array( 'path' => $done['path'], 'bytes' => $done['bytes'], 'source' => $done['source'], 'ok' => true );
            } catch ( BridgeError $e ) {
                $results[] = array( 'path' => $item['path'], 'source' => $item['url'], 'ok' => false, 'error' => $e->error_code, 'message' => $e->getMessage() );
            }
        }
        $ok         = count( array_filter( $results, static fn ( array $r ): bool => $r['ok'] ) );
        $c->summary = "downloaded $ok of " . count( $results ) . " files into $root";

        return array( 'root' => $root, 'downloaded' => $ok, 'failed' => count( $results ) - $ok, 'bytes' => $total, 'files' => $results );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_unzip( array $a, Context $c ): array {
        $problem = Policy::url_problem( (string) $a['url'] );

        return array( 'will_download' => (string) $a['url'], 'extract_into' => $a['root'] . '/' . ( $a['path'] ?? '' ), 'allowed' => null === $problem, 'problem' => $problem, 'warning' => 'Extracted PHP files are not syntax-checked or health-probed. Only known text and media types are extracted; others are skipped and listed.' );
    }

    /**
     * Downloads a zip and extracts it into a root (a whole theme, a plugin, assets). Existing files are replaced.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_unzip( array $a, Context $c ): array {
        if ( ! class_exists( '\ZipArchive' ) ) {
            throw new BridgeError( 'no_zip', 'PHP ZipArchive is not available on this server.', 501 );
        }
        $root = (string) $a['root'];
        self::guard_self( $root );
        if ( self::is_core( $root ) ) {
            throw new BridgeError( 'forbidden', 'Zips cannot be extracted into the core root.', 403 );
        }
        [ $dir, $up ] = self::root( $root, 'plan' );
        $sub          = trim( str_replace( '\\', '/', (string) ( $a['path'] ?? '' ) ), '/' );
        $strip        = ! empty( $a['strip_top'] );
        $tmp          = wp_tempnam( 'wpm-unzip.zip' );
        try {
            Util::download( (string) $a['url'], 83886080, $tmp );
            $zip = new \ZipArchive();
            if ( true !== $zip->open( $tmp ) ) {
                throw new BridgeError( 'not_zip', 'The download is not a valid zip file.', 400 );
            }
            if ( $zip->numFiles > 4000 ) {
                throw new BridgeError( 'too_many', 'The zip holds more than 4000 files.', 400 );
            }
            self::root( $root, 'create' );
            $top = '';
            if ( $strip ) {
                $first = (string) $zip->getNameIndex( 0 );
                $top   = str_contains( $first, '/' ) ? substr( $first, 0, strpos( $first, '/' ) + 1 ) : '';
            }
            $written = 0;
            $skipped = array();
            $total   = 0;
            for ( $i = 0; $i < $zip->numFiles; $i++ ) {
                $name = str_replace( '\\', '/', (string) $zip->getNameIndex( $i ) );
                if ( '' !== $top && str_starts_with( $name, $top ) ) {
                    $name = substr( $name, strlen( $top ) );
                }
                if ( '' === $name || str_ends_with( $name, '/' ) || str_starts_with( $name, '__MACOSX/' ) ) {
                    continue;
                }
                $rel = '' === $sub ? $name : $sub . '/' . $name;
                if ( ! Policy::files_path_ok( $rel, $up ) ) {
                    $skipped[] = $name;
                    continue;
                }
                $stat = $zip->statIndex( $i );
                $size = (int) ( $stat['size'] ?? 0 );
                $total += $size;
                if ( $size > 20971520 || $total > 209715200 ) {
                    throw new BridgeError( 'too_large', 'The zip expands to more than 200 MB (or a file is over 20 MB).', 400 );
                }
                $full = self::full( $dir, $up, $rel, false, true );
                self::put( $full, (string) $zip->getFromIndex( $i ) );
                ++$written;
            }
            $zip->close();
        } finally {
            @unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        }
        $c->summary = "extracted $written files into $root" . ( '' !== $sub ? "/$sub" : '' );

        return array( 'root' => $root, 'extracted' => $written, 'skipped' => array_slice( $skipped, 0, 50 ), 'skipped_count' => count( $skipped ), 'note' => 'Not undoable with activity.undo; delete the folder with files.rmdir to roll back.' );
    }
}
