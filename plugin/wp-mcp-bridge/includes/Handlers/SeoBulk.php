<?php
/**
 * Bulk SEO actions: titles and descriptions for several pages, missing alt texts, a broken link report.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Revisions;
use WPMCP\Bridge\SeoRules;
use WPMCP\Bridge\Util;

defined( 'ABSPATH' ) || exit;

final class SeoBulk {

    private const SEO_FIELDS = array( 'title', 'description', 'canonical', 'noindex', 'nofollow', 'og_title', 'og_description', 'og_image', 'focus_keyword' );

    /**
     * @param mixed $items Items argument.
     * @return list<array<string, mixed>>
     */
    private static function items( $items ): array {
        if ( ! is_array( $items ) || array() === $items || count( $items ) > 50 ) {
            throw new BridgeError( 'bad_arguments', 'items must be a list of 1-50 entries like {id, title?, description?}.', 400 );
        }
        $out = array();
        foreach ( $items as $item ) {
            if ( ! is_array( $item ) || (int) ( $item['id'] ?? 0 ) <= 0 || array() === array_intersect_key( $item, array_flip( self::SEO_FIELDS ) ) ) {
                throw new BridgeError( 'bad_arguments', 'Every item needs an id and at least one of: ' . implode( ', ', self::SEO_FIELDS ) . '.', 400 );
            }
            $out[] = $item;
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_bulk_set( array $a, Context $c ): array {
        $rows = array();
        foreach ( self::items( $a['items'] ?? null ) as $item ) {
            try {
                $now    = Seo::op_get( array( 'id' => $item['id'] ), $c );
                $rows[] = array( 'id' => (int) $item['id'], 'page' => $now['title_of_page'], 'current' => array_intersect_key( (array) $now['seo'], array_flip( array_keys( $item ) ) ), 'new' => array_diff_key( $item, array( 'id' => 1 ) ) );
            } catch ( BridgeError $e ) {
                $rows[] = array( 'id' => (int) $item['id'], 'error' => $e->getMessage() );
            }
        }

        return array( 'changes' => $rows );
    }

    /**
     * One seo.set per item. Not all or nothing: items that fail are listed, the others stay (each is undoable by its revision).
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function bulk_set( array $a, Context $c ): array {
        $done   = array();
        $failed = array();
        $revs   = array();
        foreach ( self::items( $a['items'] ?? null ) as $item ) {
            try {
                Seo::op_set( $item, $c );
                $done[] = (int) $item['id'];
                $revs[] = $c->revision;
            } catch ( BridgeError $e ) {
                $failed[] = array( 'id' => (int) $item['id'], 'error' => $e->getMessage() );
            }
        }
        $c->summary = 'seo set on ' . count( $done ) . ' items' . ( $failed ? ', ' . count( $failed ) . ' failed' : '' );

        return array( 'updated' => $done, 'failed' => $failed, 'revisions' => $revs, 'undo' => 'activity.undo {revision} for each revision' );
    }

    /* ----------------------------------------------------------------- alt text */

    /**
     * Images without alt text and the alt each would get.
     *
     * @param array<string, mixed> $a Arguments.
     * @return list<array{id: int, current: string, alt: string, file: string}>
     */
    private static function alt_candidates( array $a ): array {
        $limit = max( 1, min( 100, (int) ( $a['limit'] ?? 50 ) ) );
        $query = array( 'post_type' => 'attachment', 'post_status' => 'inherit', 'post_mime_type' => 'image', 'posts_per_page' => $limit, 'orderby' => 'ID', 'order' => 'ASC', 'fields' => 'ids' );
        if ( ! empty( $a['ids'] ) ) {
            $query['post__in'] = array_map( 'intval', (array) $a['ids'] );
        } else {
            $query['meta_query'] = array( 'relation' => 'OR', array( 'key' => '_wp_attachment_image_alt', 'compare' => 'NOT EXISTS' ), array( 'key' => '_wp_attachment_image_alt', 'value' => '', 'compare' => '=' ) ); // phpcs:ignore WordPress.DB.SlowDBQuery
        }
        $out = array();
        foreach ( get_posts( $query ) as $id ) {
            $current = (string) get_post_meta( (int) $id, '_wp_attachment_image_alt', true );
            if ( '' !== trim( $current ) ) {
                continue;
            }
            $file = (string) basename( (string) get_attached_file( (int) $id ) );
            $alt  = SeoRules::alt_from( (string) get_the_title( (int) $id ), $file );
            if ( '' !== $alt ) {
                $out[] = array( 'id' => (int) $id, 'current' => $current, 'alt' => $alt, 'file' => $file );
            }
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_alt_fill( array $a, Context $c ): array {
        $rows = self::alt_candidates( $a );

        return array( 'would_set' => $rows, 'count' => count( $rows ), 'note' => 'Alt text is made from the title or file name. Images whose names mean nothing (IMG_1234, hashes) are skipped: describe those with media.update.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function alt_fill( array $a, Context $c ): array {
        $rows   = self::alt_candidates( $a );
        $before = array();
        foreach ( $rows as $row ) {
            $before[ (string) $row['id'] ] = $row['current'];
            update_post_meta( $row['id'], '_wp_attachment_image_alt', wp_slash( $row['alt'] ) );
        }
        if ( $rows ) {
            Revisions::record( $c, 'alt', 'attachments', $before );
        }
        $c->summary = 'alt text added to ' . count( $rows ) . ' images';

        return array( 'updated' => count( $rows ), 'items' => $rows, 'more' => count( $rows ) >= max( 1, min( 100, (int) ( $a['limit'] ?? 50 ) ) ) );
    }

    /**
     * Undo of alt_fill.
     *
     * @param array<string, string> $before Attachment id => old alt text.
     */
    public static function restore_alt( array $before ): string {
        foreach ( $before as $id => $alt ) {
            '' === $alt ? delete_post_meta( (int) $id, '_wp_attachment_image_alt' ) : update_post_meta( (int) $id, '_wp_attachment_image_alt', wp_slash( $alt ) );
        }

        return 'Alt texts restored.';
    }

    /* -------------------------------------------------------------- broken links */

    /**
     * Pages to scan: a path, a post id, or the most recently modified published items.
     *
     * @param array<string, mixed> $a Arguments.
     * @return list<string>
     */
    private static function pages( array $a ): array {
        $urls = array();
        foreach ( (array) ( $a['paths'] ?? array() ) as $path ) {
            $urls[] = Util::own_url( (string) $path );
        }
        foreach ( (array) ( $a['ids'] ?? array() ) as $id ) {
            $post = get_post( (int) $id );
            if ( $post && 'publish' === $post->post_status && '' === (string) $post->post_password ) {
                $urls[] = (string) get_permalink( $post );
            }
        }
        if ( array() === $urls ) {
            $recent = max( 1, min( 20, (int) ( $a['recent'] ?? 5 ) ) );
            foreach ( get_posts( array( 'post_type' => array( 'page', 'post' ), 'post_status' => 'publish', 'orderby' => 'modified', 'order' => 'DESC', 'posts_per_page' => $recent, 'has_password' => false, 'fields' => 'ids' ) ) as $id ) {
                $urls[] = (string) get_permalink( (int) $id );
            }
        }

        return array_slice( array_values( array_unique( $urls ) ), 0, 20 );
    }

    /**
     * Status of one link. Own links go through the site itself; external ones (opt-in) through WordPress's safe HTTP API, which
     * refuses private and local addresses, with short timeouts.
     *
     * @return array{status: int, redirect: string}
     */
    private static function probe( string $url, bool $own ): array {
        $args = array( 'timeout' => $own ? 15 : 6, 'redirection' => 0, 'user-agent' => 'WP-MCP-Bridge/' . WPMCP_VERSION . ' link-check', 'sslverify' => $own ? (bool) apply_filters( 'https_local_ssl_verify', false ) : true ); // phpcs:ignore WordPress.NamingConventions
        $res  = $own ? wp_remote_head( $url, $args ) : wp_safe_remote_head( $url, $args );
        if ( ! is_wp_error( $res ) && in_array( (int) wp_remote_retrieve_response_code( $res ), array( 405, 403, 501 ), true ) ) {
            $res = $own ? wp_remote_get( $url, $args + array( 'limit_response_size' => 1024 ) ) : wp_safe_remote_get( $url, $args + array( 'limit_response_size' => 1024 ) );
        }
        if ( is_wp_error( $res ) ) {
            return array( 'status' => 0, 'redirect' => $res->get_error_message() );
        }

        return array( 'status' => (int) wp_remote_retrieve_response_code( $res ), 'redirect' => (string) wp_remote_retrieve_header( $res, 'location' ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function links_check( array $a, Context $c ): array {
        @set_time_limit( 150 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        $started  = time();
        $host     = strtolower( (string) wp_parse_url( home_url(), PHP_URL_HOST ) );
        $external = ! empty( $a['external'] );
        $limit    = max( 1, min( 200, (int) ( $a['max_links'] ?? 100 ) ) );
        $pages    = self::pages( $a );
        $found    = array(); // url => array of pages
        $page_err = array();
        foreach ( $pages as $page ) {
            try {
                $res = Util::fetch_own( $page );
            } catch ( BridgeError $e ) {
                $page_err[] = array( 'page' => $page, 'error' => $e->getMessage() );
                continue;
            }
            foreach ( SeoRules::links_from_html( (string) $res['body'], $page ) as $link ) {
                if ( SeoRules::same_host( $link['url'], $host ) || $external ) {
                    $found[ $link['url'] ][] = $page;
                }
            }
        }
        $broken  = array();
        $moved   = array();
        $unknown = 0;
        $checked = 0;
        foreach ( $found as $url => $on ) {
            if ( $checked >= $limit || time() - $started > 100 ) {
                break;
            }
            ++$checked;
            $own   = SeoRules::same_host( (string) $url, $host );
            $probe = self::probe( (string) $url, $own );
            $state = 0 === $probe['status'] ? 'broken' : SeoRules::link_state( $probe['status'] );
            if ( 'broken' === $state ) {
                $broken[] = array( 'url' => $url, 'status' => $probe['status'] ?: $probe['redirect'], 'found_on' => array_slice( array_values( array_unique( $on ) ), 0, 5 ) );
            } elseif ( 'redirect' === $state ) {
                $moved[] = array( 'url' => $url, 'status' => $probe['status'], 'to' => $probe['redirect'], 'found_on' => array_slice( array_values( array_unique( $on ) ), 0, 3 ) );
            } elseif ( 'unknown' === $state ) {
                ++$unknown;
            }
        }
        $c->summary = 'link check: ' . count( $broken ) . ' broken of ' . $checked;

        return array(
            'pages_scanned'   => count( $pages ) - count( $page_err ),
            'links_found'     => count( $found ),
            'links_checked'   => $checked,
            'broken'          => $broken,
            'redirected'      => array_slice( $moved, 0, 50 ),
            'unclear'         => $unknown,
            'page_errors'     => $page_err,
            'incomplete'      => count( $found ) > $checked,
            'external_checked' => $external,
            'next'            => $broken ? 'Fix a link with content.get and content.save, or add a redirect with seo.redirect_save.' : null,
            'note'            => 'Only links in the rendered page body are checked. Without external:true only links to this site are requested.',
        );
    }
}
