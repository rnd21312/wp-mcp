<?php
/**
 * transfer.* operations: portable export and import of content between sites.
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

final class Transfer {

    private const MAX_ITEMS = 50;

    /* ------------------------------------------------------------------ export */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_export( array $a, Context $c ): array {
        $kind = (string) $a['kind'];
        $per  = max( 1, min( 25, (int) ( $a['per_page'] ?? 10 ) ) );
        $page = max( 1, (int) ( $a['page'] ?? 1 ) );
        $base = array( 'kind' => $kind, 'home_url' => untrailingslashit( home_url() ), 'page' => $page );

        switch ( $kind ) {
            case 'posts':
            case 'media':
                $type   = 'media' === $kind ? 'attachment' : Util::post_type( (string) ( $a['post_type'] ?? 'page' ), $c );
                $status = 'media' === $kind ? 'inherit' : sanitize_key( (string) ( $a['status'] ?? 'publish' ) );
                $q      = array( 'post_type' => $type, 'post_status' => 'any' === $status ? array( 'publish', 'draft', 'pending', 'future', 'private' ) : $status, 'posts_per_page' => $per, 'paged' => $page, 'orderby' => 'ID', 'order' => 'ASC' );
                if ( ! empty( $a['ids'] ) ) {
                    $q['post__in'] = array_map( 'intval', (array) $a['ids'] );
                }
                $query = new \WP_Query( $q );
                $items = array_map( static fn ( $p ) => 'media' === $kind ? self::media_item( $p ) : self::post_item( $p ), $query->posts );

                return $base + array( 'total' => (int) $query->found_posts, 'pages' => (int) $query->max_num_pages, 'items' => $items );

            case 'terms':
                $items = array();
                foreach ( get_taxonomies( array( 'public' => true ) ) as $tax ) {
                    if ( 'post_format' === $tax ) {
                        continue;
                    }
                    foreach ( (array) get_terms( array( 'taxonomy' => $tax, 'hide_empty' => false ) ) as $t ) {
                        if ( $t instanceof \WP_Term ) {
                            $parent  = $t->parent ? get_term( $t->parent, $tax ) : null;
                            $items[] = array( 'taxonomy' => $tax, 'name' => $t->name, 'slug' => $t->slug, 'description' => $t->description, 'parent_slug' => $parent instanceof \WP_Term ? $parent->slug : '' );
                        }
                    }
                }
                $slice = array_slice( $items, ( $page - 1 ) * 100, 100 );

                return $base + array( 'total' => count( $items ), 'pages' => (int) ceil( count( $items ) / 100 ), 'items' => $slice );

            case 'menus':
                $locations = get_nav_menu_locations();
                $items     = array();
                foreach ( wp_get_nav_menus() as $m ) {
                    $items[] = array( 'name' => $m->name, 'items' => self::menu_slugs( Design::tree( $m->term_id ) ), 'locations' => array_keys( array_filter( $locations, static fn ( $id ) => (int) $id === (int) $m->term_id ) ) );
                }

                return $base + array( 'total' => count( $items ), 'pages' => 1, 'items' => $items );

            case 'users':
                $c->need( 'admin', 'Users are personal data.' );
                $q = new \WP_User_Query( array( 'number' => $per, 'paged' => $page, 'orderby' => 'ID', 'order' => 'ASC' ) );

                return $base + array( 'total' => (int) $q->get_total(), 'pages' => (int) ceil( $q->get_total() / $per ), 'items' => array_map( static fn ( $u ) => array( 'old_id' => $u->ID, 'login' => $u->user_login, 'email' => $u->user_email, 'display_name' => $u->display_name, 'role' => (string) ( $u->roles[0] ?? 'subscriber' ), 'registered' => $u->user_registered ), $q->get_results() ) );

            case 'options':
                $c->need( 'admin', 'Plugin settings can contain private data.' );
                global $wpdb;
                $prefixes = array_filter( array_map( 'sanitize_text_field', array_map( 'strval', (array) ( $a['prefixes'] ?? array() ) ) ) );
                if ( ! $prefixes ) {
                    throw new BridgeError( 'prefixes_required', 'Pass prefixes, e.g. ["woocommerce_", "wpseo"], to say which plugin settings to export.', 400 );
                }
                $items = array();
                foreach ( $prefixes as $prefix ) {
                    $rows = (array) $wpdb->get_results( $wpdb->prepare( "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s AND option_name NOT LIKE %s AND option_name NOT LIKE %s ORDER BY option_name LIMIT 300", $wpdb->esc_like( $prefix ) . '%', '\\_transient\\_%', '\\_site\\_transient\\_%' ), ARRAY_A ); // phpcs:ignore WordPress.DB
                    foreach ( $rows as $row ) {
                        $name = (string) $row['option_name'];
                        if ( 'secret' === Policy::option_tier( $name ) || self::option_blocked( $name ) ) {
                            continue;
                        }
                        $items[ $name ] = array( 'name' => $name, 'value' => self::strip_secrets( get_option( $name ) ) );
                    }
                }

                return $base + array( 'total' => count( $items ), 'pages' => 1, 'items' => array_values( $items ), 'note' => 'Values under secret-looking keys (API keys, tokens, passwords) are left out; enter those on the target by hand.' );

            case 'design':
                $site = (array) get_option( 'wpm_seo_site', array() );

                return $base + array(
                    'total' => 1,
                    'pages' => 1,
                    'items' => array(
                        array(
                            'title'     => get_option( 'blogname' ),
                            'tagline'   => get_option( 'blogdescription' ),
                            'tokens'    => get_option( 'wpm_tokens', array() ),
                            'css'       => get_option( 'wpm_css_sections', array() ),
                            'redirects' => array_values( (array) get_option( 'wpm_redirects', array() ) ),
                            'seo_site'  => $site + array( 'robots_txt' => (string) get_option( 'wpm_robots_txt', '' ) ),
                        ),
                    ),
                );
        }

        throw new BridgeError( 'bad_kind', 'kind must be posts, terms, menus, media or design.', 400 );
    }

    /** @return array<string, mixed> */
    private static function post_item( \WP_Post $p ): array {
        $meta = array();
        foreach ( (array) get_post_meta( $p->ID ) as $key => $values ) {
            if ( Policy::transfer_meta_ok( (string) $key ) ) {
                $value = maybe_unserialize( $values[0] ?? '' );
                if ( strlen( (string) wp_json_encode( $value ) ) <= 2000000 ) {
                    $meta[ $key ] = $value;
                }
            }
        }
        $terms = array();
        foreach ( get_object_taxonomies( $p->post_type ) as $tax ) {
            $list = wp_get_object_terms( $p->ID, $tax );
            if ( is_array( $list ) && $list ) {
                $terms[ $tax ] = array_map( static fn ( $t ) => array( 'name' => $t->name, 'slug' => $t->slug ), $list );
            }
        }
        $thumb = (int) get_post_thumbnail_id( $p->ID );
        $item  = array(
            'old_id'     => $p->ID,
            'type'       => $p->post_type,
            'status'     => $p->post_status,
            'title'      => $p->post_title,
            'slug'       => $p->post_name,
            'content'    => $p->post_content,
            'excerpt'    => $p->post_excerpt,
            'date'       => $p->post_date,
            'parent'     => (int) $p->post_parent,
            'menu_order' => (int) $p->menu_order,
            'meta'       => $meta,
            'terms'      => $terms,
            'seo'        => array_diff_key( Seo::read( $p->ID ), array( 'provider' => 1, 'note' => 1 ) ),
        );
        if ( $thumb ) {
            $item['featured'] = array( 'old_id' => $thumb, 'url' => (string) wp_get_attachment_url( $thumb ), 'alt' => (string) get_post_meta( $thumb, '_wp_attachment_image_alt', true ), 'title' => get_the_title( $thumb ) );
        }

        return $item;
    }

    /** @return array<string, mixed> */
    private static function media_item( \WP_Post $p ): array {
        return array( 'old_id' => $p->ID, 'url' => (string) wp_get_attachment_url( $p->ID ), 'title' => $p->post_title, 'alt' => (string) get_post_meta( $p->ID, '_wp_attachment_image_alt', true ), 'caption' => $p->post_excerpt, 'mime' => $p->post_mime_type );
    }

    /**
     * Adds term slugs to taxonomy items so the target can find them again.
     *
     * @param array<int, array<string, mixed>> $items Tree.
     * @return array<int, array<string, mixed>>
     */
    private static function menu_slugs( array $items ): array {
        foreach ( $items as &$i ) {
            if ( 'taxonomy' === ( $i['type'] ?? '' ) ) {
                $t = get_term( (int) $i['object_id'], (string) $i['object'] );
                if ( $t instanceof \WP_Term ) {
                    $i['object_slug'] = $t->slug;
                }
            }
            if ( ! empty( $i['children'] ) ) {
                $i['children'] = self::menu_slugs( (array) $i['children'] );
            }
        }

        return $items;
    }

    /* ------------------------------------------------------------------ import */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_import( array $a, Context $c ): array {
        $risky = ! empty( $a['overwrite'] ) || ! empty( $a['publish'] ) || in_array( (string) ( $a['kind'] ?? '' ), array( 'users', 'options' ), true );

        return array( 'kind' => $a['kind'], 'items' => count( (array) ( $a['items'] ?? array() ) ), 'creates' => $risky ? 'items with their source status, replacing existing slugs when overwrite is set' : 'drafts; existing slugs are skipped', 'needs_confirmation' => $risky );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_import( array $a, Context $c ): array {
        $kind  = (string) $a['kind'];
        $items = array_slice( array_values( (array) $a['items'] ), 0, self::MAX_ITEMS );
        $map   = array_replace_recursive( array( 'posts' => array(), 'media' => array(), 'urls' => array() ), (array) ( $a['id_map'] ?? array() ) );
        $ctx   = array( 'source' => rtrim( (string) ( $a['source_url'] ?? '' ), '/' ), 'overwrite' => ! empty( $a['overwrite'] ), 'publish' => ! empty( $a['publish'] ), 'deadline' => microtime( true ) + 90, 'pending' => 0 );
        if ( $ctx['overwrite'] || $ctx['publish'] ) {
            $c->need( 'live', 'Overwriting or keeping published status needs live level.' );
        }
        $out = array( 'created' => array(), 'skipped' => array(), 'failed' => array() );

        switch ( $kind ) {
            case 'terms':
                $out = self::import_terms( $items, $c );
                break;
            case 'posts':
                $out = self::import_posts( $items, $map, $ctx, $c );
                break;
            case 'media':
                foreach ( $items as $item ) {
                    $item = (array) $item;
                    try {
                        $att = Media::import_from_url( (string) $item['url'], array( 'title' => $item['title'] ?? '', 'alt' => $item['alt'] ?? '' ), $c );
                        $map['media'][ (string) $item['old_id'] ] = $att['id'];
                        $out['created'][] = array( 'old_id' => $item['old_id'], 'id' => $att['id'] );
                    } catch ( \Throwable $e ) {
                        $out['failed'][] = array( 'old_id' => $item['old_id'] ?? null, 'error' => $e->getMessage() );
                    }
                }
                break;
            case 'menus':
                $c->need( 'live', 'Menus are visible to visitors.' );
                $out = self::import_menus( $items, $map, $ctx, $c );
                break;
            case 'design':
                $c->need( 'live', 'Design settings are visible to visitors.' );
                $out = self::import_design( $items, $c );
                break;
            case 'users':
                $c->need( 'admin', 'Users are personal data.' );
                $out = self::import_users( $items, $ctx );
                break;
            case 'options':
                $c->need( 'admin', 'Plugin settings can change how the site behaves.' );
                $out = self::import_options( $items, $c );
                break;
            default:
                throw new BridgeError( 'bad_kind', 'kind must be posts, terms, menus, media or design.', 400 );
        }
        $c->summary = "imported $kind: " . count( $out['created'] ) . ' created, ' . count( $out['skipped'] ) . ' skipped, ' . count( $out['failed'] ) . ' failed';

        return $out + array( 'kind' => $kind, 'id_map' => $map, 'media_pending' => $ctx['pending'] );
    }

    /**
     * @param array<int, mixed> $items Terms.
     * @return array<string, mixed>
     */
    private static function import_terms( array $items, Context $c ): array {
        $out = array( 'created' => array(), 'skipped' => array(), 'failed' => array() );
        usort( $items, static fn ( $x, $y ) => ( '' !== ( (array) $x )['parent_slug'] ?? '' ) <=> ( '' !== ( (array) $y )['parent_slug'] ?? '' ) );
        foreach ( $items as $item ) {
            $item = (array) $item;
            $tax  = sanitize_key( (string) ( $item['taxonomy'] ?? '' ) );
            if ( ! taxonomy_exists( $tax ) ) {
                $out['failed'][] = array( 'slug' => $item['slug'] ?? '', 'error' => "taxonomy $tax does not exist here" );
                continue;
            }
            if ( term_exists( (string) $item['slug'], $tax ) ) {
                $out['skipped'][] = array( 'taxonomy' => $tax, 'slug' => $item['slug'] );
                continue;
            }
            $args = array( 'slug' => (string) $item['slug'], 'description' => wp_kses_post( (string) ( $item['description'] ?? '' ) ) );
            if ( ! empty( $item['parent_slug'] ) ) {
                $parent = get_term_by( 'slug', (string) $item['parent_slug'], $tax );
                if ( $parent instanceof \WP_Term ) {
                    $args['parent'] = $parent->term_id;
                }
            }
            $res = wp_insert_term( (string) $item['name'], $tax, $args );
            if ( is_wp_error( $res ) ) {
                $out['failed'][] = array( 'slug' => $item['slug'], 'error' => $res->get_error_message() );
                continue;
            }
            Revisions::record( $c, 'term', $tax . ':' . $res['term_id'], null );
            $out['created'][] = array( 'taxonomy' => $tax, 'slug' => $item['slug'], 'id' => (int) $res['term_id'] );
        }

        return $out;
    }

    /**
     * Fetches the source site's uploads referenced in a text and points the text at the local copies; also rewrites
     * links to the source site.
     *
     * @param array<string, mixed> $map Id map, by reference.
     * @param array<string, mixed> $ctx Import context, by reference.
     */
    private static function rewrite( string $text, array &$map, array &$ctx, Context $c ): string {
        $source = (string) $ctx['source'];
        if ( '' === $source || '' === $text ) {
            return $text;
        }
        $host    = (string) wp_parse_url( $source, PHP_URL_HOST );
        $plain   = str_replace( '\\/', '/', $text ); // JSON-escaped slashes (page builders) are read like normal URLs.
        $replace = array();
        if ( '' !== $host && preg_match_all( '#https?://' . preg_quote( $host, '#' ) . '[^\s"\'<>)\\\\,;]*?/wp-content/uploads/[^\s"\'<>)\\\\,;]+#i', $plain, $m ) ) {
            foreach ( array_unique( $m[0] ) as $url ) {
                if ( ! isset( $map['urls'][ $url ] ) ) {
                    if ( microtime( true ) > $ctx['deadline'] ) {
                        ++$ctx['pending'];
                        continue;
                    }
                    try {
                        $att                 = Media::import_from_url( $url, array(), $c );
                        $map['urls'][ $url ] = $att['url'];
                    } catch ( \Throwable $e ) {
                        $map['urls'][ $url ] = $url; // Keep the source URL; it still works while the source exists.
                    }
                }
                if ( $map['urls'][ $url ] !== $url ) {
                    $replace[ $url ]                          = $map['urls'][ $url ];
                    $replace[ str_replace( '/', '\\/', $url ) ] = str_replace( '/', '\\/', $map['urls'][ $url ] );
                }
            }
        }
        $home                                     = untrailingslashit( home_url() );
        $replace[ $source ]                       = $home;
        $replace[ str_replace( '/', '\\/', $source ) ] = str_replace( '/', '\\/', $home );

        return strtr( $text, $replace );
    }

    /**
     * @param array<int, mixed>    $items Posts.
     * @param array<string, mixed> $map   Id map, by reference.
     * @param array<string, mixed> $ctx   Import context.
     * @return array<string, mixed>
     */
    private static function import_posts( array $items, array &$map, array &$ctx, Context $c ): array {
        $out = array( 'created' => array(), 'skipped' => array(), 'failed' => array() );
        foreach ( $items as $item ) {
            $item = (array) $item;
            $old  = (string) ( $item['old_id'] ?? '' );
            try {
                $type     = Util::post_type( (string) ( $item['type'] ?? 'page' ), $c, true );
                $slug     = (string) ( $item['slug'] ?? '' );
                $found    = '' !== $slug ? get_posts( array( 'name' => $slug, 'post_type' => $type, 'post_status' => 'any', 'numberposts' => 1 ) ) : array();
                $existing = $found[0] ?? null;
                if ( $existing && ! $ctx['overwrite'] ) {
                    $map['posts'][ $old ] = $existing->ID;
                    $out['skipped'][]     = array( 'old_id' => $old, 'id' => $existing->ID, 'slug' => $slug, 'reason' => 'slug exists' );
                    continue;
                }
                $status = 'draft';
                if ( $ctx['publish'] && in_array( $item['status'] ?? '', array( 'publish', 'draft', 'pending', 'private', 'future' ), true ) ) {
                    $status = (string) $item['status'];
                }
                $post = array(
                    'post_type'    => $type,
                    'post_status'  => $status,
                    'post_title'   => (string) ( $item['title'] ?? '' ),
                    'post_name'    => $slug,
                    'post_content' => Util::html( self::rewrite( (string) ( $item['content'] ?? '' ), $map, $ctx, $c ), $c ),
                    'post_excerpt' => (string) ( $item['excerpt'] ?? '' ),
                    'menu_order'   => (int) ( $item['menu_order'] ?? 0 ),
                    'post_parent'  => (int) ( $map['posts'][ (string) ( $item['parent'] ?? 0 ) ] ?? 0 ),
                );
                if ( ! empty( $item['date'] ) && 'draft' !== $status ) {
                    $post['post_date']     = (string) $item['date'];
                    $post['post_date_gmt'] = get_gmt_from_date( $post['post_date'] );
                }
                $before = $existing ? Revisions::snap_post( $existing->ID ) : null;
                if ( $existing ) {
                    $post['ID'] = $existing->ID;
                }
                $id = $existing ? wp_update_post( wp_slash( $post ), true ) : wp_insert_post( wp_slash( $post ), true );
                if ( is_wp_error( $id ) ) {
                    throw new BridgeError( 'save_failed', $id->get_error_message(), 400 );
                }
                $id = (int) $id;

                foreach ( (array) ( $item['terms'] ?? array() ) as $tax => $list ) {
                    if ( ! taxonomy_exists( (string) $tax ) ) {
                        continue;
                    }
                    $ids = array();
                    foreach ( (array) $list as $t ) {
                        $t  = (array) $t;
                        $ex = term_exists( (string) $t['slug'], (string) $tax );
                        if ( ! $ex ) {
                            $ex = wp_insert_term( (string) $t['name'], (string) $tax, array( 'slug' => (string) $t['slug'] ) );
                        }
                        if ( ! is_wp_error( $ex ) ) {
                            $ids[] = (int) ( is_array( $ex ) ? $ex['term_id'] : $ex );
                        }
                    }
                    wp_set_object_terms( $id, $ids, (string) $tax );
                }
                foreach ( (array) ( $item['meta'] ?? array() ) as $key => $value ) {
                    if ( ! Policy::transfer_meta_ok( (string) $key ) ) {
                        continue;
                    }
                    if ( is_string( $value ) && str_starts_with( (string) $key, '_elementor_data' ) ) {
                        $value = self::rewrite( $value, $map, $ctx, $c );
                    }
                    update_post_meta( $id, (string) $key, wp_slash( $value ) );
                }
                if ( ! empty( $item['featured']['url'] ) ) {
                    $fid = (int) ( $map['media'][ (string) $item['featured']['old_id'] ] ?? 0 );
                    if ( ! $fid && microtime( true ) < $ctx['deadline'] ) {
                        $fid = (int) Media::import_from_url( (string) $item['featured']['url'], array( 'alt' => $item['featured']['alt'] ?? '', 'title' => $item['featured']['title'] ?? '' ), $c )['id'];
                        $map['media'][ (string) $item['featured']['old_id'] ] = $fid;
                    }
                    if ( $fid ) {
                        set_post_thumbnail( $id, $fid );
                    }
                }
                $seo = array_filter( (array) ( $item['seo'] ?? array() ), static fn ( $v ) => '' !== $v && false !== $v && null !== $v );
                if ( $seo ) {
                    try {
                        Seo::op_set( array( 'id' => $id ) + array_intersect_key( $seo, array_flip( array( 'title', 'description', 'canonical', 'noindex', 'nofollow', 'og_title', 'og_description', 'og_image', 'focus_keyword' ) ) ), $c );
                    } catch ( \Throwable $e ) {
                        unset( $e ); // SEO is best effort; the page itself is imported.
                    }
                }
                Revisions::record( $c, 'post', (string) $id, $before );
                $map['posts'][ $old ] = $id;
                $out['created'][]     = array( 'old_id' => $old, 'id' => $id, 'slug' => $slug, 'status' => $status, 'replaced' => (bool) $existing );
            } catch ( \Throwable $e ) {
                $out['failed'][] = array( 'old_id' => $old, 'slug' => $item['slug'] ?? '', 'error' => $e->getMessage() );
            }
        }

        return $out;
    }

    /**
     * @param array<int, mixed>    $items Menus.
     * @param array<string, mixed> $map   Id map.
     * @param array<string, mixed> $ctx   Import context.
     * @return array<string, mixed>
     */
    private static function import_menus( array $items, array $map, array $ctx, Context $c ): array {
        $out  = array( 'created' => array(), 'skipped' => array(), 'failed' => array() );
        $home = untrailingslashit( home_url() );
        $fix  = static function ( array $nodes ) use ( &$fix, $map, $ctx, $home ): array {
            $result = array();
            foreach ( $nodes as $n ) {
                $n    = (array) $n;
                $item = array( 'title' => (string) ( $n['title'] ?? '' ) );
                $new  = 0;
                if ( 'post_type' === ( $n['type'] ?? '' ) ) {
                    $new = (int) ( $map['posts'][ (string) ( $n['object_id'] ?? 0 ) ] ?? 0 );
                } elseif ( 'taxonomy' === ( $n['type'] ?? '' ) && ! empty( $n['object_slug'] ) ) {
                    $t   = get_term_by( 'slug', (string) $n['object_slug'], (string) $n['object'] );
                    $new = $t instanceof \WP_Term ? $t->term_id : 0;
                }
                if ( $new ) {
                    $item += array( 'object' => $n['object'], 'object_id' => $new );
                } else {
                    $item['url'] = str_replace( (string) $ctx['source'], $home, (string) ( $n['url'] ?? '#' ) );
                }
                if ( ! empty( $n['children'] ) ) {
                    $item['children'] = $fix( (array) $n['children'] );
                }
                $result[] = $item;
            }

            return $result;
        };
        foreach ( $items as $menu ) {
            $menu = (array) $menu;
            try {
                $res = Design::build_menu( sanitize_text_field( (string) $menu['name'] ), $fix( (array) ( $menu['items'] ?? array() ) ), array_map( 'strval', (array) ( $menu['locations'] ?? array() ) ) );
                Revisions::record( $c, 'menu', (string) $res['id'], null );
                $out['created'][] = array( 'name' => $menu['name'], 'id' => $res['id'], 'items' => $res['items'] );
            } catch ( \Throwable $e ) {
                $out['failed'][] = array( 'name' => $menu['name'] ?? '', 'error' => $e->getMessage() );
            }
        }

        return $out;
    }

    /**
     * @param array<int, mixed> $items One design bundle.
     * @return array<string, mixed>
     */
    private static function import_design( array $items, Context $c ): array {
        $out = array( 'created' => array(), 'skipped' => array(), 'failed' => array() );
        $d   = (array) ( $items[0] ?? array() );
        $do  = static function ( string $what, callable $fn ) use ( &$out ): void {
            try {
                $fn();
                $out['created'][] = $what;
            } catch ( \Throwable $e ) {
                $out['failed'][] = array( 'part' => $what, 'error' => $e->getMessage() );
            }
        };
        if ( isset( $d['title'] ) || isset( $d['tagline'] ) ) {
            $do( 'branding', static fn () => Design::op_branding_set( array( 'title' => $d['title'] ?? null, 'tagline' => $d['tagline'] ?? null ), $c ) );
        }
        if ( ! empty( $d['tokens'] ) ) {
            $do( 'tokens', static fn () => Design::op_tokens_set( (array) $d['tokens'], $c ) );
        }
        foreach ( (array) ( $d['css'] ?? array() ) as $name => $css ) {
            $do( "css:$name", static fn () => Design::op_css_set( array( 'css' => (string) $css, 'section' => (string) $name ), $c ) );
        }
        foreach ( (array) ( $d['redirects'] ?? array() ) as $r ) {
            $r = (array) $r;
            $do( 'redirect:' . ( $r['from'] ?? '' ), static fn () => Seo::op_redirect_save( array( 'from' => $r['from'] ?? '', 'to' => $r['to'] ?? '', 'code' => $r['code'] ?? 301, 'regex' => ! empty( $r['regex'] ) ), $c ) );
        }
        if ( ! empty( $d['seo_site'] ) ) {
            $do( 'seo_site', static fn () => Seo::op_site_set( array_intersect_key( (array) $d['seo_site'], array_flip( array( 'robots_txt', 'org_name', 'org_logo', 'org_same_as', 'title_separator', 'default_og_image' ) ) ), $c ) );
        }

        return $out;
    }

    /* ------------------------------------------------------- users and options */

    private static function option_blocked( string $name ): bool {
        return in_array( $name, array( 'siteurl', 'home', 'admin_email', 'active_plugins', 'template', 'stylesheet', 'user_roles', 'cron', 'rewrite_rules', 'db_version', 'initial_db_version', 'recently_activated', 'default_role', 'users_can_register', 'blog_public', 'sidebars_widgets' ), true ) || str_starts_with( $name, 'wpm_' ) || str_contains( $name, 'secret' );
    }

    /**
     * Removes values under secret-looking keys, at any depth.
     *
     * @param mixed $value Option value.
     * @return mixed
     */
    private static function strip_secrets( $value ) {
        if ( is_object( $value ) ) {
            $value = (array) $value;
        }
        if ( ! is_array( $value ) ) {
            return $value;
        }
        $out = array();
        foreach ( $value as $k => $v ) {
            if ( is_string( $k ) && Policy::is_secret_key( $k ) ) {
                continue;
            }
            $out[ $k ] = self::strip_secrets( $v );
        }

        return $out;
    }

    /**
     * @param array<int, mixed>    $items Users.
     * @param array<string, mixed> $ctx   Import context.
     * @return array<string, mixed>
     */
    private static function import_users( array $items, array $ctx ): array {
        $out = array( 'created' => array(), 'skipped' => array(), 'failed' => array() );
        foreach ( $items as $u ) {
            $u     = (array) $u;
            $login = sanitize_user( (string) ( $u['login'] ?? '' ), true );
            $email = sanitize_email( (string) ( $u['email'] ?? '' ) );
            if ( '' === $login || username_exists( $login ) || ( '' !== $email && email_exists( $email ) ) ) {
                $out['skipped'][] = array( 'login' => $login, 'reason' => 'login or email already exists' );
                continue;
            }
            $role = sanitize_key( (string) ( $u['role'] ?? 'subscriber' ) );
            if ( ! get_role( $role ) ) {
                $role = 'subscriber';
            }
            if ( 'administrator' === $role && ! $ctx['publish'] ) {
                $out['skipped'][] = array( 'login' => $login, 'reason' => 'administrator accounts are only imported with publish=true' );
                continue;
            }
            $id = wp_insert_user( array( 'user_login' => $login, 'user_email' => $email, 'user_pass' => wp_generate_password( 32 ), 'role' => $role, 'display_name' => sanitize_text_field( (string) ( $u['display_name'] ?? $login ) ) ) );
            if ( is_wp_error( $id ) ) {
                $out['failed'][] = array( 'login' => $login, 'error' => $id->get_error_message() );
                continue;
            }
            $out['created'][] = array( 'login' => $login, 'id' => (int) $id, 'role' => $role );
        }
        $out['note'] = 'Passwords are not copied: the new users must use "lost password" to sign in.';

        return $out;
    }

    /**
     * @param array<int, mixed> $items Options.
     * @return array<string, mixed>
     */
    private static function import_options( array $items, Context $c ): array {
        $out    = array( 'created' => array(), 'skipped' => array(), 'failed' => array() );
        $before = array();
        foreach ( $items as $item ) {
            $item = (array) $item;
            $name = (string) ( $item['name'] ?? '' );
            if ( '' === $name || 'secret' === Policy::option_tier( $name ) || self::option_blocked( $name ) ) {
                $out['skipped'][] = array( 'name' => $name, 'reason' => 'protected option' );
                continue;
            }
            $before[] = Revisions::snap_option( $name );
            update_option( $name, $item['value'] ?? '' );
            $out['created'][] = $name;
        }
        if ( $before ) {
            Revisions::record( $c, 'options', 'import', $before );
        }

        return $out;
    }
}
