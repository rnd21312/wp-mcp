<?php
/**
 * Part of Files: downloads and zip extraction.
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

trait FilesRemote {

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
        if ( null !== ( $problem = PhpGuard::file_problem( $path, $got['body'] ) ) ) {
            throw new BridgeError( 'syntax_error', $problem . ' Nothing was written.', 400 );
        }
        $before = self::snapshot( $root, $path, $full );
        Util::write_atomic( $full, $got['body'] );
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
                Util::write_atomic( $full, (string) $zip->getFromIndex( $i ) );
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
