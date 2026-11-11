<?php
/**
 * Part of Files: delete, folders, move and copy.
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

trait FilesTree {

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
            Util::write_atomic( $full, (string) base64_decode( (string) $before['data'], true ) );

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
}
