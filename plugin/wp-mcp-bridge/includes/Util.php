<?php
/**
 * Small helpers shared by the handlers.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class Util {

    /** Post types that hold personal data or internals. Never exposed through content tools. */
    private const BLOCKED_TYPES = array( 'shop_order', 'shop_order_refund', 'shop_order_placehold', 'scheduled-action', 'wp_global_styles', 'nav_menu_item', 'revision', 'customize_changeset', 'oembed_cache', 'user_request', 'flamingo_inbound', 'flamingo_outbound', 'flamingo_contact', 'wp_font_family', 'wp_font_face', 'shop_subscription' );

    /**
     * @param array<string, mixed> $a Arguments.
     * @param mixed                $default Fallback.
     * @return mixed
     */
    public static function arg( array $a, string $key, $default = null ) {
        return array_key_exists( $key, $a ) && null !== $a[ $key ] ? $a[ $key ] : $default;
    }

    /** Page/per_page with limits. @param array<string, mixed> $a Arguments. @return array{0: int, 1: int} */
    public static function paging( array $a, int $max = 100 ): array {
        return array( max( 1, (int) ( $a['page'] ?? 1 ) ), max( 1, min( $max, (int) ( $a['per_page'] ?? 20 ) ) ) );
    }

    /** Validates a post type for the content tools and returns it. */
    public static function post_type( string $type, Context $c, bool $write = false ): string {
        $type = '' === $type ? 'post' : sanitize_key( $type );
        $obj  = get_post_type_object( $type );
        if ( ! $obj || in_array( $type, self::BLOCKED_TYPES, true ) || 'attachment' === $type && $write ) {
            throw new BridgeError( 'bad_post_type', "Post type \"$type\" is not available. Use site.overview to see content types.", 400 );
        }
        if ( ! $obj->public ) {
            $c->need( 'live', "Post type \"$type\" is not public." );
        }

        return $type;
    }

    /** Finds a post by ID, slug or path. @param mixed $ref ID, slug or path. */
    public static function find_post( $ref, string $type = '' ): ?\WP_Post {
        if ( is_int( $ref ) || ( is_string( $ref ) && ctype_digit( $ref ) ) ) {
            $post = get_post( (int) $ref );

            return $post instanceof \WP_Post ? $post : null;
        }
        $ref = trim( (string) $ref );
        if ( '' === $ref ) {
            return null;
        }
        if ( str_contains( $ref, '/' ) || str_starts_with( $ref, 'http' ) ) {
            $path = (string) wp_parse_url( $ref, PHP_URL_PATH );
            $id   = url_to_postid( home_url( '/' . trim( $path, '/' ) . '/' ) );
            if ( $id ) {
                return get_post( $id );
            }
            $page = get_page_by_path( trim( $path, '/' ), OBJECT, '' !== $type ? $type : array( 'page', 'post' ) );

            return $page instanceof \WP_Post ? $page : null;
        }
        $found = get_posts( array( 'name' => sanitize_title( $ref ), 'post_type' => '' !== $type ? $type : 'any', 'post_status' => 'any', 'numberposts' => 1 ) );

        return $found[0] ?? null;
    }

    /** The level needed to see a post in its current status. */
    public static function read_level( \WP_Post $post ): string {
        return 'publish' === $post->post_status && '' === $post->post_password ? 'read' : 'draft';
    }

    /**
     * Compact view of a post for lists.
     *
     * @return array<string, mixed>
     */
    public static function brief( \WP_Post $p ): array {
        return array(
            'id'       => $p->ID,
            'type'     => $p->post_type,
            'status'   => $p->post_status,
            'title'    => get_the_title( $p ),
            'slug'     => $p->post_name,
            'url'      => get_permalink( $p ),
            'date'     => $p->post_date,
            'modified' => $p->post_modified,
            'parent'   => $p->post_parent ?: null,
            'author'   => get_the_author_meta( 'display_name', (int) $p->post_author ),
            'excerpt'  => wp_trim_words( wp_strip_all_tags( '' !== $p->post_excerpt ? $p->post_excerpt : strip_shortcodes( $p->post_content ) ), 28, '…' ),
        );
    }

    /** HTML from the AI: stripped to what editors may post unless the level is admin. */
    public static function html( string $html, Context $c ): string {
        return $c->can( 'admin' ) ? $html : wp_kses_post( $html );
    }

    /** Limits a string for output. */
    public static function clip( string $text, int $max ): array {
        return strlen( $text ) > $max ? array( substr( $text, 0, $max ), true ) : array( $text, false );
    }

    /** Terms of a post as {taxonomy: [{id,name,slug}]}. @return array<string, array<int, array<string, mixed>>> */
    public static function terms_of( int $id, string $type ): array {
        $out = array();
        foreach ( get_object_taxonomies( $type ) as $tax ) {
            $terms = wp_get_object_terms( $id, $tax );
            if ( is_array( $terms ) && $terms ) {
                $out[ $tax ] = array_map( static fn ( $t ) => array( 'id' => $t->term_id, 'name' => $t->name, 'slug' => $t->slug ), $terms );
            }
        }

        return $out;
    }

    /** Local-site HTTP fetch with the maintenance bypass header and no redirects off the site. @return array{status: int, headers: array<string, string>, body: string} */
    public static function fetch_own( string $url ): array {
        $home = (string) wp_parse_url( home_url(), PHP_URL_HOST );
        $host = (string) wp_parse_url( $url, PHP_URL_HOST );
        if ( strtolower( $host ) !== strtolower( $home ) ) {
            throw new BridgeError( 'foreign_host', 'Only pages of this site can be fetched.', 400 );
        }
        $res = wp_remote_get(
            $url,
            array(
                'timeout'     => 20,
                'redirection' => 0,
                'sslverify'   => (bool) apply_filters( 'https_local_ssl_verify', false ), // phpcs:ignore WordPress.NamingConventions
                'headers'     => array( 'X-WPM-Inspect' => Frontend::inspect_header(), 'Accept' => 'text/html,*/*' ),
                'user-agent'  => 'WP-MCP-Bridge/' . WPMCP_VERSION,
            )
        );
        if ( is_wp_error( $res ) ) {
            throw new BridgeError( 'fetch_failed', 'Could not load the page: ' . $res->get_error_message(), 502 );
        }
        $headers = array();
        foreach ( array( 'content-type', 'location', 'cache-control', 'x-robots-tag', 'link' ) as $name ) {
            $value = wp_remote_retrieve_header( $res, $name );
            if ( '' !== $value ) {
                $headers[ $name ] = is_array( $value ) ? implode( ', ', $value ) : (string) $value;
            }
        }

        return array( 'status' => (int) wp_remote_retrieve_response_code( $res ), 'headers' => $headers, 'body' => (string) wp_remote_retrieve_body( $res ) );
    }

    /**
     * Downloads a public https file, following up to 5 redirects; every hop must pass the same SSRF rules.
     *
     * @param string      $to Optional file path to stream into (for big files); body is then empty.
     * @return array{url: string, body: string}
     */
    public static function download( string $url, int $limit, string $to = '' ): array {
        for ( $hop = 0; $hop <= 5; $hop++ ) {
            if ( null !== ( $problem = Policy::url_problem( $url ) ) ) {
                throw new BridgeError( 'blocked_url', $problem, 400 );
            }
            $args = array( 'timeout' => 60, 'redirection' => 0, 'limit_response_size' => $limit, 'user-agent' => 'WP-MCP-Bridge/' . WPMCP_VERSION );
            if ( '' !== $to ) {
                $args['stream']   = true;
                $args['filename'] = $to;
            }
            $res = wp_safe_remote_get( $url, $args );
            if ( is_wp_error( $res ) ) {
                throw new BridgeError( 'download_failed', $res->get_error_message(), 502 );
            }
            $code = (int) wp_remote_retrieve_response_code( $res );
            if ( $code >= 300 && $code < 400 && '' !== (string) wp_remote_retrieve_header( $res, 'location' ) ) {
                $url = (string) \WP_Http::make_absolute_url( (string) wp_remote_retrieve_header( $res, 'location' ), $url );
                continue;
            }
            if ( 200 !== $code ) {
                throw new BridgeError( 'download_failed', "The server answered HTTP $code.", 502 );
            }

            return array( 'url' => $url, 'body' => '' === $to ? (string) wp_remote_retrieve_body( $res ) : '' );
        }
        throw new BridgeError( 'download_failed', 'Too many redirects.', 502 );
    }

    /** Absolute URL on this site from a path or URL. */
    public static function own_url( string $path ): string {
        if ( str_starts_with( $path, 'http' ) ) {
            return $path;
        }

        return home_url( '/' . ltrim( $path, '/' ) );
    }
}
