<?php
/**
 * media.* operations.
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

final class Media {

    private const MAX_BYTES = 10485760;

    /** @return array<string, mixed> */
    private static function view( int $id, bool $full = false ): array {
        $meta = wp_get_attachment_metadata( $id ) ?: array();
        $out  = array(
            'id'       => $id,
            'title'    => get_the_title( $id ),
            'alt'      => (string) get_post_meta( $id, '_wp_attachment_image_alt', true ),
            'mime'     => (string) get_post_mime_type( $id ),
            'url'      => (string) wp_get_attachment_url( $id ),
            'width'    => $meta['width'] ?? null,
            'height'   => $meta['height'] ?? null,
            'date'     => get_post_field( 'post_date', $id ),
            'attached_to' => (int) get_post_field( 'post_parent', $id ) ?: null,
        );
        if ( $full ) {
            $out['caption']     = wp_get_attachment_caption( $id );
            $out['description'] = get_post_field( 'post_content', $id );
            $sizes              = array();
            foreach ( array_keys( (array) ( $meta['sizes'] ?? array() ) ) as $size ) {
                $src = wp_get_attachment_image_src( $id, $size );
                if ( $src ) {
                    $sizes[ $size ] = array( 'url' => $src[0], 'width' => $src[1], 'height' => $src[2] );
                }
            }
            $out['sizes'] = $sizes;
            $file         = get_attached_file( $id );
            $out['bytes'] = $file && is_file( $file ) ? filesize( $file ) : null;
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_list( array $a, Context $c ): array {
        [ $page, $per ] = Util::paging( $a );
        $q              = new \WP_Query( array( 'post_type' => 'attachment', 'post_status' => 'inherit', 'posts_per_page' => $per, 'paged' => $page, 's' => (string) ( $a['search'] ?? '' ), 'post_mime_type' => (string) ( $a['mime'] ?? '' ), 'orderby' => 'date', 'order' => 'DESC' ) );

        return array( 'items' => array_map( static fn ( $p ) => self::view( $p->ID ), $q->posts ), 'total' => (int) $q->found_posts, 'page' => $page );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_get( array $a, Context $c ): array {
        if ( 'attachment' !== get_post_type( (int) $a['id'] ) ) {
            throw new BridgeError( 'not_found', 'No such media item.', 404 );
        }

        return self::view( (int) $a['id'], true );
    }

    /**
     * Turns a file that already lies in the uploads folder into a media library item: attachment row, sizes, alt text,
     * optional featured image. Thumbnail trouble (no image library, low memory) never loses the upload.
     *
     * @param array<string, mixed> $a title, alt, caption, description, featured (with attach_to).
     * @return array<string, mixed>
     */
    private static function adopt( string $file, string $mime, int $parent, array $a, Context $c ): array {
        $title = sanitize_text_field( (string) ( $a['title'] ?? ucfirst( trim( (string) preg_replace( '/[-_]+/', ' ', pathinfo( $file, PATHINFO_FILENAME ) ) ) ) ) );
        $post  = array( 'post_mime_type' => $mime, 'post_title' => $title, 'post_status' => 'inherit', 'guid' => self::url_of( $file ) );
        if ( ! empty( $a['caption'] ) ) {
            $post['post_excerpt'] = wp_kses_post( (string) $a['caption'] );
        }
        if ( ! empty( $a['description'] ) ) {
            $post['post_content'] = wp_kses_post( (string) $a['description'] );
        }
        $id = wp_insert_attachment( wp_slash( $post ), $file, $parent, true );
        if ( is_wp_error( $id ) ) {
            throw new BridgeError( 'upload_failed', $id->get_error_message(), 500 );
        }
        $warning = null;
        try {
            wp_update_attachment_metadata( $id, wp_generate_attachment_metadata( $id, $file ) );
        } catch ( \Throwable $e ) {
            $warning = 'Saved, but extra image sizes could not be made: ' . $e->getMessage();
        }
        $alt = (string) ( $a['alt'] ?? '' );
        if ( '' === $alt && str_starts_with( $mime, 'image/' ) ) {
            $alt = $title;
        }
        if ( '' !== $alt ) {
            update_post_meta( $id, '_wp_attachment_image_alt', sanitize_text_field( $alt ) );
        }
        if ( $parent > 0 && ! empty( $a['featured'] ) && str_starts_with( $mime, 'image/' ) ) {
            set_post_thumbnail( $parent, $id );
        }
        Revisions::record( $c, 'post', (string) $id, null );
        $view = self::view( (int) $id );
        if ( $warning ) {
            $view['warning'] = $warning;
        }

        return $view;
    }

    private static function url_of( string $file ): string {
        $up = wp_upload_dir();

        return str_replace( wp_normalize_path( $up['basedir'] ), $up['baseurl'], wp_normalize_path( $file ) );
    }

    /**
     * Validates and stores bytes through WordPress' own upload rules (allowed types, real content check).
     *
     * @return array<string, mixed>
     */
    private static function store( string $bytes, string $filename, array $a, Context $c ): array {
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/image.php';
        require_once ABSPATH . 'wp-admin/includes/media.php';
        wp_raise_memory_limit( 'image' );
        @set_time_limit( 120 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        if ( '' === $bytes || strlen( $bytes ) > self::MAX_BYTES ) {
            throw new BridgeError( 'bad_size', 'File must be between 1 byte and 10 MB. For bigger files put them in wp-content/uploads and use media.register, or use media.import_url.', 400 );
        }
        $up = wp_upload_dir();
        if ( ! empty( $up['error'] ) ) {
            throw new BridgeError( 'upload_dir', 'The uploads folder is not usable: ' . wp_strip_all_tags( (string) $up['error'] ) . ' Fix its permissions, or place the files there yourself and run media.register.', 500 );
        }
        $filename = sanitize_file_name( $filename );
        $type     = wp_check_filetype( $filename );
        if ( ! $type['type'] ) {
            throw new BridgeError( 'bad_type', 'This file type is not allowed on this site.', 400 );
        }
        $tmp = wp_tempnam( $filename );
        if ( false === file_put_contents( $tmp, $bytes ) ) {
            throw new BridgeError( 'upload_failed', 'The server could not write a temporary file (check the temp folder and disk space).', 500 );
        }
        $moved = wp_handle_sideload( array( 'name' => $filename, 'tmp_name' => $tmp, 'type' => $type['type'], 'error' => 0, 'size' => strlen( $bytes ) ), array( 'test_form' => false ) );
        if ( ! empty( $moved['error'] ) ) {
            @unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
            throw new BridgeError( 'upload_failed', wp_strip_all_tags( (string) $moved['error'] ) . ' (If the uploads folder is not writable, place the file there yourself and run media.register.)', 400 );
        }
        $saved = null;
        $note  = null;
        $opt   = Optimizer::options( $a['optimize'] ?? null );
        if ( $opt ) {
            try {
                $r = Optimizer::any( $moved['file'], $opt );
                if ( $r ) {
                    $moved['file'] = $r['file'];
                    $moved['type'] = $r['mime'];
                    $saved         = array( 'before' => $r['before'], 'after' => $r['after'] );
                }
            } catch ( \Throwable $e ) {
                $note = 'Stored without optimizing: ' . $e->getMessage();
            }
        }
        $view = self::adopt( $moved['file'], $moved['type'], (int) ( $a['attach_to'] ?? 0 ), $a + array( 'title' => pathinfo( $filename, PATHINFO_FILENAME ) ), $c );
        if ( $saved ) {
            $view['optimized'] = $saved;
        }
        if ( $note ) {
            $view['warning'] = $note;
        }
        $c->summary = 'uploaded ' . basename( (string) $moved['file'] ) . ' as media #' . $view['id'];

        return $view;
    }

    /**
     * Files in uploads that are not in the library yet (generated sizes and originals of known items excluded).
     *
     * @return string[] Absolute paths.
     */
    private static function unregistered( int $limit ): array {
        global $wpdb;
        $up    = wp_upload_dir();
        $base  = wp_normalize_path( (string) realpath( $up['basedir'] ) );
        $known = array_flip( (array) $wpdb->get_col( "SELECT meta_value FROM {$wpdb->postmeta} WHERE meta_key = '_wp_attached_file'" ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
        foreach ( (array) $wpdb->get_col( "SELECT meta_value FROM {$wpdb->postmeta} WHERE meta_key = '_wp_attachment_metadata'" ) as $raw ) { // phpcs:ignore WordPress.DB.DirectDatabaseQuery
            $m   = maybe_unserialize( $raw );
            $dir = trim( dirname( (string) ( $m['file'] ?? '' ) ), '.' );
            foreach ( (array) ( $m['sizes'] ?? array() ) as $size ) {
                $known[ ltrim( $dir . '/' . $size['file'], '/' ) ] = true;
            }
            if ( ! empty( $m['original_image'] ) ) {
                $known[ ltrim( $dir . '/' . $m['original_image'], '/' ) ] = true;
            }
        }
        $found = array();
        $it    = new \RecursiveIteratorIterator( new \RecursiveDirectoryIterator( $base, \FilesystemIterator::SKIP_DOTS ) );
        foreach ( $it as $f ) {
            $abs = wp_normalize_path( $f->getPathname() );
            $rel = ltrim( substr( $abs, strlen( $base ) ), '/' );
            if ( ! $f->isFile() || isset( $known[ $rel ] ) || preg_match( '#^(cache|wc-logs|woocommerce_uploads|elementor|backup)/#i', $rel ) || preg_match( '/-\d+x\d+\.\w+$/', $rel ) ) {
                continue;
            }
            $mime = (string) wp_check_filetype( $rel )['type'];
            if ( ! preg_match( '#^(image|video|audio)/|^application/pdf$#', $mime ) ) {
                continue;
            }
            $found[] = $abs;
            if ( count( $found ) >= $limit ) {
                break;
            }
        }

        return $found;
    }

    /**
     * Adds files that were copied into wp-content/uploads (FTP, file manager, files.write) to the media library, makes
     * their sizes, alt text and optionally sets the first image as the featured image. scan:true finds every file not yet registered.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_register( array $a, Context $c ): array {
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/image.php';
        require_once ABSPATH . 'wp-admin/includes/media.php';
        global $wpdb;
        wp_raise_memory_limit( 'image' );
        @set_time_limit( 150 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        $up   = wp_upload_dir();
        $base = wp_normalize_path( (string) realpath( $up['basedir'] ) );
        $max  = max( 1, min( 100, (int) ( $a['limit'] ?? 30 ) ) );
        $abs  = array();
        foreach ( (array) ( $a['paths'] ?? array() ) as $rel ) {
            $path = wp_normalize_path( (string) realpath( $base . '/' . ltrim( (string) $rel, '/\\' ) ) );
            if ( ! str_starts_with( $path, $base . '/' ) || ! is_file( $path ) ) {
                throw new BridgeError( 'not_found', 'No such file inside uploads: ' . sanitize_text_field( (string) $rel ), 404 );
            }
            $abs[] = $path;
        }
        if ( ! empty( $a['scan'] ) ) {
            $abs = array_values( array_unique( array_merge( $abs, self::unregistered( $max ) ) ) );
        }
        if ( array() === $abs ) {
            return array( 'registered' => array(), 'note' => 'Nothing to register. Pass paths (relative to uploads, e.g. 2025/05/hero.jpg) or scan:true.' );
        }
        $opt     = Optimizer::options( $a['optimize'] ?? null );
        $one     = 1 === count( $abs );
        $done    = array();
        $skipped = array();
        foreach ( array_slice( $abs, 0, $max ) as $path ) {
            $rel  = ltrim( substr( $path, strlen( $base ) ), '/' );
            $mime = (string) wp_check_filetype( $path )['type'];
            if ( ! $mime ) {
                $skipped[] = array( 'file' => $rel, 'reason' => 'file type not allowed' );
                continue;
            }
            $exists = (int) $wpdb->get_var( $wpdb->prepare( "SELECT post_id FROM {$wpdb->postmeta} WHERE meta_key = '_wp_attached_file' AND meta_value = %s LIMIT 1", $rel ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
            if ( $exists ) {
                $skipped[] = array( 'file' => $rel, 'reason' => 'already in library', 'id' => $exists );
                continue;
            }
            if ( $opt ) {
                try {
                    $r = Optimizer::any( $path, $opt );
                    if ( $r ) {
                        $path = $r['file'];
                        $mime = $r['mime'];
                    }
                } catch ( \Throwable $e ) {
                    $skipped[] = array( 'file' => $rel, 'reason' => 'not optimized: ' . $e->getMessage() );
                }
            }
            $item   = self::adopt( $path, $mime, (int) ( $a['attach_to'] ?? 0 ), $one ? $a : array_diff_key( $a, array( 'title' => 1, 'alt' => 1 ) ), $c );
            $done[] = array_intersect_key( $item, array_flip( array( 'id', 'url', 'title', 'warning' ) ) );
            $a['featured'] = false; // only the first image becomes the featured image.
        }
        $c->summary = 'registered ' . count( $done ) . ' file(s) in the media library';
        $more       = max( 0, count( $abs ) - $max );

        return array( 'registered' => $done, 'skipped' => $skipped, 'more' => $more ) + ( $more ? array( 'hint' => 'Run again to continue.' ) : array() );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_register( array $a, Context $c ): array {
        $paths = (array) ( $a['paths'] ?? array() );
        if ( ! empty( $a['scan'] ) ) {
            $up    = wp_upload_dir();
            $base  = wp_normalize_path( (string) realpath( $up['basedir'] ) );
            $paths = array_merge( $paths, array_map( static fn ( $p ) => ltrim( substr( $p, strlen( $base ) ), '/' ), self::unregistered( max( 1, min( 100, (int) ( $a['limit'] ?? 30 ) ) ) ) ) );
        }

        return array( 'will_register' => $paths );
    }

    /**
     * Shrinks and/or converts existing library items. Replaces the file; the URL changes when the format changes and
     * links in post content are rewritten (fix_links, default on). Not undoable: the old file is deleted.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_optimize( array $a, Context $c ): array {
        require_once ABSPATH . 'wp-admin/includes/image.php';
        global $wpdb;
        $saved = Optimizer::settings();
        $opt   = array(
            'max_width' => isset( $a['max_width'] ) ? max( 0, (int) $a['max_width'] ) : $saved['max_width'],
            'quality'   => isset( $a['quality'] ) ? max( 30, min( 100, (int) $a['quality'] ) ) : $saved['quality'],
            'format'    => isset( $a['format'] ) ? (string) $a['format'] : $saved['format'],
        );
        $out = array();
        foreach ( self::ids( $a ) as $id ) {
            $file = get_attached_file( $id );
            if ( 'attachment' !== get_post_type( $id ) || ! $file || ! is_file( $file ) ) {
                $out[] = array( 'id' => $id, 'status' => 'skipped', 'reason' => 'not an attachment with a file' );
                continue;
            }
            $old_url  = (string) wp_get_attachment_url( $id );
            $old_meta = wp_get_attachment_metadata( $id ) ?: array();
            $old_urls = array();
            foreach ( (array) ( $old_meta['sizes'] ?? array() ) as $name => $info ) {
                $old_urls[ $name ] = trailingslashit( dirname( $old_url ) ) . $info['file'];
            }
            try {
                $r = Optimizer::any( $file, $opt );
            } catch ( BridgeError $e ) {
                $out[] = array( 'id' => $id, 'status' => 'failed', 'reason' => $e->getMessage() );
                continue;
            }
            if ( ! $r || $r['file'] === $file && $r['after'] >= $r['before'] ) {
                $out[] = array( 'id' => $id, 'status' => 'unchanged', 'reason' => 'already small enough for these settings' );
                continue;
            }
            foreach ( (array) ( $old_meta['sizes'] ?? array() ) as $info ) { // old thumbnails belong to the old file.
                @unlink( trailingslashit( dirname( $file ) ) . $info['file'] ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
            }
            update_attached_file( $id, $r['file'] );
            wp_update_post( array( 'ID' => $id, 'post_mime_type' => $r['mime'] ) );
            try {
                wp_update_attachment_metadata( $id, wp_generate_attachment_metadata( $id, $r['file'] ) );
            } catch ( \Throwable $e ) {
                $r['note'] = 'sizes not regenerated: ' . $e->getMessage();
            }
            $new_url  = (string) wp_get_attachment_url( $id );
            $new_meta = wp_get_attachment_metadata( $id ) ?: array();
            $changed  = 0;
            if ( ! isset( $a['fix_links'] ) || $a['fix_links'] ) {
                $pairs = array( $old_url => $new_url );
                foreach ( $old_urls as $name => $url ) {
                    if ( isset( $new_meta['sizes'][ $name ]['file'] ) ) {
                        $pairs[ $url ] = trailingslashit( dirname( $new_url ) ) . $new_meta['sizes'][ $name ]['file'];
                    }
                }
                foreach ( $pairs as $from => $to ) {
                    if ( $from !== $to ) {
                        $changed += (int) $wpdb->query( $wpdb->prepare( "UPDATE {$wpdb->posts} SET post_content = REPLACE(post_content, %s, %s) WHERE post_content LIKE %s AND post_type <> 'revision'", $from, $to, '%' . $wpdb->esc_like( $from ) . '%' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
                    }
                }
            }
            $out[] = array( 'id' => $id, 'status' => 'optimized', 'before' => $r['before'], 'after' => $r['after'], 'saved_pct' => $r['before'] ? (int) round( 100 - $r['after'] * 100 / $r['before'] ) : 0, 'url' => $new_url, 'old_url' => $old_url !== $new_url ? $old_url : null, 'links_updated' => $changed ) + ( isset( $r['note'] ) ? array( 'note' => $r['note'] ) : array() );
        }
        $c->summary = 'optimized ' . count( array_filter( $out, static fn ( $o ) => 'optimized' === $o['status'] ) ) . ' media item(s)';

        return array( 'items' => $out, 'note' => 'Old files were replaced; this cannot be undone.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_optimize( array $a, Context $c ): array {
        $items = array();
        foreach ( self::ids( $a ) as $id ) {
            $items[] = 'attachment' === get_post_type( $id ) ? self::view( $id, true ) : array( 'id' => $id, 'error' => 'not found' );
        }

        return array( 'will_replace_files_of' => $items, 'warning' => 'Original files are deleted; if the format changes the URL changes (links in post content are rewritten). This cannot be undone.' );
    }

    /** @param array<string, mixed> $a Arguments. @return int[] */
    private static function ids( array $a ): array {
        return array_values( array_filter( array_slice( array_map( 'intval', (array) ( $a['ids'] ?? array( $a['id'] ?? 0 ) ) ), 0, 10 ) ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_upload( array $a, Context $c ): array {
        $bytes = base64_decode( (string) $a['data_base64'], true );
        if ( false === $bytes ) {
            throw new BridgeError( 'bad_data', 'data_base64 is not valid base64.', 400 );
        }

        return self::store( $bytes, (string) $a['filename'], $a, $c );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_import_url( array $a, Context $c ): array {
        $problem = Policy::url_problem( (string) $a['url'] );

        return array( 'will_download' => (string) $a['url'], 'host' => wp_parse_url( (string) $a['url'], PHP_URL_HOST ), 'allowed' => null === $problem, 'problem' => $problem, 'rules' => 'https only, no redirects, no private addresses, max 10 MB, allowed file types only' );
    }

    /**
     * Downloads a public https file and stores it in the library (shared by media.import_url and transfers).
     *
     * @param array<string, mixed> $a title, alt, filename, attach_to.
     * @return array<string, mixed>
     */
    public static function import_from_url( string $url, array $a, Context $c ): array {
        if ( null !== ( $problem = Policy::url_problem( $url ) ) ) {
            throw new BridgeError( 'blocked_url', $problem, 400 );
        }
        $res = wp_safe_remote_get( $url, array( 'timeout' => 25, 'redirection' => 0, 'limit_response_size' => self::MAX_BYTES + 1, 'user-agent' => 'WP-MCP-Bridge/' . WPMCP_VERSION ) );
        if ( is_wp_error( $res ) ) {
            throw new BridgeError( 'download_failed', $res->get_error_message(), 502 );
        }
        $code = (int) wp_remote_retrieve_response_code( $res );
        if ( 200 !== $code ) {
            throw new BridgeError( 'download_failed', $code >= 300 && $code < 400 ? 'The URL redirects; redirects are not followed. Use the final URL.' : "The server answered HTTP $code.", 502 );
        }
        $name = (string) ( $a['filename'] ?? basename( (string) wp_parse_url( $url, PHP_URL_PATH ) ) );

        return self::store( (string) wp_remote_retrieve_body( $res ), '' !== $name ? $name : 'download', $a, $c );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_import_url( array $a, Context $c ): array {
        return self::import_from_url( (string) $a['url'], $a, $c );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_update( array $a, Context $c ): array {
        $id = (int) $a['id'];
        if ( 'attachment' !== get_post_type( $id ) ) {
            throw new BridgeError( 'not_found', 'No such media item.', 404 );
        }
        $before = Revisions::snap_post( $id );
        $post   = array( 'ID' => $id );
        foreach ( array( 'title' => 'post_title', 'caption' => 'post_excerpt', 'description' => 'post_content', 'slug' => 'post_name' ) as $arg => $field ) {
            if ( isset( $a[ $arg ] ) ) {
                $post[ $field ] = 'post_name' === $field ? sanitize_title( (string) $a[ $arg ] ) : wp_kses_post( (string) $a[ $arg ] );
            }
        }
        if ( count( $post ) > 1 ) {
            wp_update_post( wp_slash( $post ) );
        }
        if ( isset( $a['alt'] ) ) {
            update_post_meta( $id, '_wp_attachment_image_alt', sanitize_text_field( (string) $a['alt'] ) );
        }
        Revisions::record( $c, 'post', (string) $id, $before );
        $c->summary = "updated media #$id";

        return self::view( $id );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_delete( array $a, Context $c ): array {
        return array( 'will_delete' => self::view( (int) $a['id'] ), 'permanent' => true, 'warning' => 'Pages that use this file will show a broken image.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_delete( array $a, Context $c ): array {
        $id = (int) $a['id'];
        if ( 'attachment' !== get_post_type( $id ) ) {
            throw new BridgeError( 'not_found', 'No such media item.', 404 );
        }
        wp_delete_attachment( $id, true );
        $c->summary = "deleted media #$id permanently";

        return array( 'deleted' => $id );
    }
}
