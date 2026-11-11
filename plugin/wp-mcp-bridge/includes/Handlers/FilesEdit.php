<?php
/**
 * Part of Files: multi-file writes, patches, search and chunked uploads.
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

trait FilesEdit {

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
                $problem = PhpGuard::file_problem( $path, $bytes );
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
        $healthy = $has_php ? PhpGuard::front_ok() : null;
        $before  = array();
        try {
            foreach ( $plan as $f ) {
                $before[] = self::snapshot( $root, $f['path'], $f['full'] );
                Util::write_atomic( $f['full'], $f['bytes'] );
            }
            if ( true === $healthy && false === PhpGuard::front_ok() ) {
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
}
