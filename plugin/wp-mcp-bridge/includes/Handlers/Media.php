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
     * Validates and stores bytes through WordPress' own upload rules (allowed types, real content check).
     *
     * @return array<string, mixed>
     */
    private static function store( string $bytes, string $filename, array $a, Context $c ): array {
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/image.php';
        require_once ABSPATH . 'wp-admin/includes/media.php';
        if ( '' === $bytes || strlen( $bytes ) > self::MAX_BYTES ) {
            throw new BridgeError( 'bad_size', 'File must be between 1 byte and 10 MB.', 400 );
        }
        $filename = sanitize_file_name( $filename );
        $type     = wp_check_filetype( $filename );
        if ( ! $type['type'] ) {
            throw new BridgeError( 'bad_type', 'This file type is not allowed on this site.', 400 );
        }
        $tmp = wp_tempnam( $filename );
        file_put_contents( $tmp, $bytes );
        $moved = wp_handle_sideload( array( 'name' => $filename, 'tmp_name' => $tmp, 'type' => $type['type'], 'error' => 0, 'size' => strlen( $bytes ) ), array( 'test_form' => false ) );
        if ( ! empty( $moved['error'] ) ) {
            @unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
            throw new BridgeError( 'upload_failed', (string) $moved['error'], 400 );
        }
        $parent = (int) ( $a['attach_to'] ?? 0 );
        $id     = wp_insert_attachment(
            array( 'post_mime_type' => $moved['type'], 'post_title' => sanitize_text_field( (string) ( $a['title'] ?? pathinfo( $filename, PATHINFO_FILENAME ) ) ), 'post_status' => 'inherit' ),
            $moved['file'],
            $parent,
            true
        );
        if ( is_wp_error( $id ) ) {
            throw new BridgeError( 'upload_failed', $id->get_error_message(), 500 );
        }
        wp_update_attachment_metadata( $id, wp_generate_attachment_metadata( $id, $moved['file'] ) );
        if ( ! empty( $a['alt'] ) ) {
            update_post_meta( $id, '_wp_attachment_image_alt', sanitize_text_field( (string) $a['alt'] ) );
        }
        Revisions::record( $c, 'post', (string) $id, null );
        $c->summary = "uploaded $filename as media #$id";

        return self::view( (int) $id );
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
        foreach ( array( 'title' => 'post_title', 'caption' => 'post_excerpt', 'description' => 'post_content' ) as $arg => $field ) {
            if ( isset( $a[ $arg ] ) ) {
                $post[ $field ] = wp_kses_post( (string) $a[ $arg ] );
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
