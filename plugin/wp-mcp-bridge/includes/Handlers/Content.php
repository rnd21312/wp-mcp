<?php
/**
 * content.* operations: posts, pages, custom types, terms, comments.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\Levels;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Revisions;
use WPMCP\Bridge\Util;

defined( 'ABSPATH' ) || exit;

final class Content {

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_list( array $a, Context $c ): array {
        $type   = Util::post_type( (string) ( $a['post_type'] ?? 'post' ), $c );
        $status = sanitize_key( (string) ( $a['status'] ?? 'publish' ) );
        if ( 'publish' !== $status ) {
            $c->need( 'draft', 'Only published items are visible at read level.' );
        }
        [ $page, $per ] = Util::paging( $a );
        $query          = array(
            'post_type'      => $type,
            'post_status'    => 'any' === $status ? array( 'publish', 'draft', 'pending', 'future', 'private' ) : $status,
            'posts_per_page' => $per,
            'paged'          => $page,
            'orderby'        => in_array( ( $a['orderby'] ?? '' ), array( 'date', 'modified', 'title', 'menu_order', 'id' ), true ) ? ( 'id' === $a['orderby'] ? 'ID' : $a['orderby'] ) : 'date',
            'order'          => 'asc' === strtolower( (string) ( $a['order'] ?? 'desc' ) ) ? 'ASC' : 'DESC',
            'has_password'   => false,
        );
        if ( 'publish' !== $status && $c->can( 'draft' ) ) {
            unset( $query['has_password'] );
        }
        if ( ! empty( $a['search'] ) ) {
            $query['s'] = sanitize_text_field( (string) $a['search'] );
        }
        if ( ! empty( $a['author'] ) ) {
            $query['author'] = (int) $a['author'];
        }
        if ( ! empty( $a['term'] ) && str_contains( (string) $a['term'], ':' ) ) {
            [ $tax, $slug ]      = explode( ':', (string) $a['term'], 2 );
            $query['tax_query']  = array( array( 'taxonomy' => sanitize_key( $tax ), 'field' => 'slug', 'terms' => sanitize_title( $slug ) ) ); // phpcs:ignore WordPress.DB.SlowDBQuery
        }
        $q = new \WP_Query( $query );

        return array( 'items' => array_map( array( Util::class, 'brief' ), $q->posts ), 'total' => (int) $q->found_posts, 'pages' => (int) $q->max_num_pages, 'page' => $page );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_get( array $a, Context $c ): array {
        $post = Util::find_post( $a['id'] ?? '', (string) ( $a['post_type'] ?? '' ) );
        if ( ! $post || in_array( $post->post_type, array( 'shop_order', 'revision', 'nav_menu_item', 'shop_order_refund' ), true ) ) {
            throw new BridgeError( 'not_found', 'No such item.', 404 );
        }
        $c->need( Util::read_level( $post ), 'This item is not public.' );
        $out = Util::brief( $post ) + array(
            'content'        => $post->post_content,
            'excerpt_raw'    => $post->post_excerpt,
            'template'       => (string) get_post_meta( $post->ID, '_wp_page_template', true ),
            'menu_order'     => $post->menu_order,
            'comment_status' => $post->comment_status,
            'featured_media' => (int) get_post_thumbnail_id( $post->ID ) ?: null,
            'terms'          => Util::terms_of( $post->ID, $post->post_type ),
        );
        $meta = array();
        foreach ( (array) get_post_meta( $post->ID ) as $key => $values ) {
            if ( Policy::meta_allowed( (string) $key ) && ! str_starts_with( (string) $key, '_' ) ) {
                $meta[ $key ] = Policy::redact( maybe_unserialize( $values[0] ?? '' ) );
            }
        }
        $out['meta'] = $meta;
        $include     = array_map( 'strval', (array) ( $a['include'] ?? array() ) );
        if ( in_array( 'seo', $include, true ) ) {
            $out['seo'] = Seo::read( $post->ID );
        }
        if ( in_array( 'blocks', $include, true ) && function_exists( 'parse_blocks' ) ) {
            $out['blocks'] = array_values( array_filter( array_map( static fn ( $b ) => $b['blockName'] ?? null, parse_blocks( $post->post_content ) ) ) );
        }
        if ( in_array( 'revisions', $include, true ) && $c->can( 'draft' ) ) {
            $out['revisions'] = array_map( static fn ( $r ) => array( 'id' => $r->ID, 'date' => $r->post_modified ), array_slice( array_values( wp_get_post_revisions( $post->ID ) ), 0, 10 ) );
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_save( array $a, Context $c ): array {
        $id       = (int) ( $a['id'] ?? 0 );
        $existing = $id ? get_post( $id ) : null;
        if ( $id && ! $existing ) {
            throw new BridgeError( 'not_found', "No item $id.", 404 );
        }
        $type   = Util::post_type( (string) ( $a['post_type'] ?? ( $existing->post_type ?? 'post' ) ), $c, true );
        $status = isset( $a['status'] ) ? sanitize_key( (string) $a['status'] ) : ( $existing->post_status ?? 'draft' );
        if ( ! in_array( $status, array( 'draft', 'pending', 'publish', 'future', 'private' ), true ) ) {
            throw new BridgeError( 'bad_status', 'Status must be draft, pending, publish, future or private.', 400 );
        }
        $needed = Policy::level_for_status( $status );
        if ( $existing ) {
            $needed = Levels::max( $needed, Policy::level_for_status( $existing->post_status ) );
        }
        $c->need( $needed, 'Editing or publishing live content needs live level; saving drafts needs draft.' );

        $arr = array( 'post_type' => $type, 'post_status' => $status );
        $map = array( 'title' => 'post_title', 'excerpt' => 'post_excerpt', 'slug' => 'post_name', 'parent' => 'post_parent', 'menu_order' => 'menu_order', 'comment_status' => 'comment_status' );
        foreach ( $map as $from => $to ) {
            if ( isset( $a[ $from ] ) ) {
                $arr[ $to ] = is_int( $a[ $from ] ) ? $a[ $from ] : (string) $a[ $from ];
            }
        }
        if ( isset( $a['content'] ) ) {
            $arr['post_content'] = Util::html( (string) $a['content'], $c );
        }
        if ( isset( $a['date'] ) ) {
            $ts = strtotime( (string) $a['date'] );
            if ( false === $ts ) {
                throw new BridgeError( 'bad_date', 'date must look like 2026-05-01 09:30:00.', 400 );
            }
            $arr['post_date']     = gmdate( 'Y-m-d H:i:s', $ts );
            $arr['post_date_gmt'] = get_gmt_from_date( $arr['post_date'] );
            if ( $ts > time() && 'publish' === $status ) {
                $arr['post_status'] = 'future';
            }
        }
        if ( $existing ) {
            $arr['ID'] = $id;
        }

        $before = $existing ? Revisions::snap_post( $id ) : null;
        $result = $existing ? wp_update_post( wp_slash( $arr ), true ) : wp_insert_post( wp_slash( $arr ), true );
        if ( is_wp_error( $result ) ) {
            throw new BridgeError( 'save_failed', $result->get_error_message(), 400 );
        }
        $id      = (int) $result;
        $skipped = array();

        foreach ( (array) ( $a['terms'] ?? array() ) as $tax => $values ) {
            if ( ! taxonomy_exists( (string) $tax ) ) {
                $skipped[] = "taxonomy $tax";
                continue;
            }
            wp_set_object_terms( $id, array_map( static fn ( $v ) => is_numeric( $v ) ? (int) $v : (string) $v, (array) $values ), (string) $tax );
        }
        foreach ( (array) ( $a['meta'] ?? array() ) as $key => $value ) {
            if ( ! Policy::meta_allowed( (string) $key ) ) {
                $skipped[] = "meta $key";
                continue;
            }
            update_post_meta( $id, (string) $key, wp_slash( $value ) );
        }
        if ( isset( $a['template'] ) ) {
            update_post_meta( $id, '_wp_page_template', sanitize_text_field( (string) $a['template'] ) );
        }
        if ( isset( $a['featured_media'] ) ) {
            (int) $a['featured_media'] > 0 ? set_post_thumbnail( $id, (int) $a['featured_media'] ) : delete_post_thumbnail( $id );
        }

        $post = get_post( $id );
        Revisions::record( $c, 'post', (string) $id, $before, array( 'status' => $post->post_status ) );
        $c->summary = ( $existing ? 'updated' : 'created' ) . " $type #$id ({$post->post_status})";

        return array( 'id' => $id, 'created' => ! $existing, 'status' => $post->post_status, 'url' => get_permalink( $post ), 'edit_url' => admin_url( "post.php?post=$id&action=edit" ), 'skipped' => $skipped );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_duplicate( array $a, Context $c ): array {
        $src = get_post( (int) $a['id'] );
        if ( ! $src ) {
            throw new BridgeError( 'not_found', 'No such item.', 404 );
        }
        $c->need( Util::read_level( $src ) );
        $type = Util::post_type( $src->post_type, $c, true );
        $new  = wp_insert_post( wp_slash( array( 'post_type' => $type, 'post_status' => 'draft', 'post_title' => $src->post_title . ' (copy)', 'post_content' => $src->post_content, 'post_excerpt' => $src->post_excerpt, 'post_parent' => $src->post_parent, 'menu_order' => $src->menu_order ) ), true );
        if ( is_wp_error( $new ) ) {
            throw new BridgeError( 'save_failed', $new->get_error_message(), 400 );
        }
        foreach ( (array) get_post_meta( $src->ID ) as $key => $values ) {
            if ( Policy::meta_allowed( (string) $key ) ) {
                foreach ( (array) $values as $value ) {
                    add_post_meta( (int) $new, (string) $key, wp_slash( maybe_unserialize( $value ) ) );
                }
            }
        }
        foreach ( get_object_taxonomies( $type ) as $tax ) {
            wp_set_object_terms( (int) $new, wp_get_object_terms( $src->ID, $tax, array( 'fields' => 'ids' ) ), $tax );
        }
        Revisions::record( $c, 'post', (string) $new, null, array( 'copy_of' => $src->ID ) );
        $c->summary = "duplicated #{$src->ID} as #$new";

        return array( 'id' => (int) $new, 'status' => 'draft', 'edit_url' => admin_url( "post.php?post=$new&action=edit" ) );
    }

    private static function load( int $id ): \WP_Post {
        $post = get_post( $id );
        if ( ! $post || in_array( $post->post_type, array( 'revision', 'nav_menu_item', 'shop_order' ), true ) ) {
            throw new BridgeError( 'not_found', "No item $id.", 404 );
        }

        return $post;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_trash( array $a, Context $c ): array {
        $post   = self::load( (int) $a['id'] );
        $before = Revisions::snap_post( $post->ID );
        if ( ! wp_trash_post( $post->ID ) ) {
            throw new BridgeError( 'failed', 'Could not move to trash.', 500 );
        }
        Revisions::record( $c, 'post', (string) $post->ID, $before );
        $c->summary = "trashed #{$post->ID}";

        return array( 'id' => $post->ID, 'status' => 'trash' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_restore( array $a, Context $c ): array {
        $post   = self::load( (int) $a['id'] );
        $before = Revisions::snap_post( $post->ID );
        wp_untrash_post( $post->ID );
        Revisions::record( $c, 'post', (string) $post->ID, $before );
        $c->summary = "restored #{$post->ID}";

        return array( 'id' => $post->ID, 'status' => get_post_status( $post->ID ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_delete( array $a, Context $c ): array {
        $post = self::load( (int) $a['id'] );

        return array( 'will_delete' => Util::brief( $post ), 'comments' => (int) get_comments_number( $post ), 'children' => count( get_children( array( 'post_parent' => $post->ID, 'fields' => 'ids' ) ) ), 'permanent' => true, 'undo' => 'not possible' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_delete( array $a, Context $c ): array {
        $post = self::load( (int) $a['id'] );
        if ( ! wp_delete_post( $post->ID, true ) ) {
            throw new BridgeError( 'failed', 'Could not delete.', 500 );
        }
        $c->summary = "deleted permanently {$post->post_type} #{$post->ID} \"{$post->post_title}\"";

        return array( 'deleted' => $post->ID );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_revisions( array $a, Context $c ): array {
        $post = self::load( (int) $a['id'] );
        $c->need( Util::read_level( $post ) );
        if ( ! empty( $a['restore'] ) ) {
            $c->need( 'live', 'Restoring a revision changes content.' );
            $before = Revisions::snap_post( $post->ID );
            $rev    = wp_restore_post_revision( (int) $a['restore'] );
            if ( ! $rev ) {
                throw new BridgeError( 'failed', 'That revision does not belong to this item.', 400 );
            }
            Revisions::record( $c, 'post', (string) $post->ID, $before );
            $c->summary = "restored revision {$a['restore']} of #{$post->ID}";

            return array( 'restored' => (int) $a['restore'], 'id' => $post->ID );
        }
        $items = array();
        foreach ( array_slice( array_values( wp_get_post_revisions( $post->ID ) ), 0, 30 ) as $r ) {
            $items[] = array( 'id' => $r->ID, 'date' => $r->post_modified, 'author' => get_the_author_meta( 'display_name', (int) $r->post_author ), 'title' => $r->post_title, 'content_chars' => strlen( $r->post_content ) );
        }

        return array( 'revisions' => $items );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_bulk( array $a, Context $c ): array {
        $ids    = array_slice( array_map( 'intval', (array) $a['ids'] ), 0, 50 );
        $status = sanitize_key( (string) $a['status'] );
        if ( ! in_array( $status, array( 'publish', 'draft', 'pending', 'private', 'trash' ), true ) ) {
            throw new BridgeError( 'bad_status', 'Status must be publish, draft, pending, private or trash.', 400 );
        }
        $done = array();
        foreach ( $ids as $id ) {
            $post = get_post( $id );
            if ( ! $post || in_array( $post->post_type, array( 'revision', 'nav_menu_item', 'shop_order' ), true ) ) {
                continue;
            }
            $before = Revisions::snap_post( $id );
            'trash' === $status ? wp_trash_post( $id ) : wp_update_post( array( 'ID' => $id, 'post_status' => $status ) );
            Revisions::record( $c, 'post', (string) $id, $before );
            $done[] = $id;
        }
        $c->summary = 'bulk status ' . $status . ' on ' . count( $done ) . ' items';

        return array( 'changed' => $done, 'status' => $status );
    }

    /* ------------------------------------------------------------------- terms */

    private static function taxonomy( string $name ): string {
        $name = '' === $name ? 'category' : sanitize_key( $name );
        $tax  = get_taxonomy( $name );
        if ( ! $tax || ! $tax->public && ! $tax->show_ui ) {
            throw new BridgeError( 'bad_taxonomy', "Unknown taxonomy \"$name\".", 400 );
        }

        return $name;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_terms_list( array $a, Context $c ): array {
        [ $page, $per ] = Util::paging( $a );
        $tax            = self::taxonomy( (string) ( $a['taxonomy'] ?? '' ) );
        $terms          = get_terms( array( 'taxonomy' => $tax, 'hide_empty' => ! empty( $a['hide_empty'] ), 'search' => (string) ( $a['search'] ?? '' ), 'number' => $per, 'offset' => ( $page - 1 ) * $per ) );
        if ( is_wp_error( $terms ) ) {
            throw new BridgeError( 'failed', $terms->get_error_message(), 400 );
        }

        return array( 'taxonomy' => $tax, 'terms' => array_map( static fn ( $t ) => array( 'id' => $t->term_id, 'name' => $t->name, 'slug' => $t->slug, 'parent' => $t->parent ?: null, 'count' => $t->count, 'description' => $t->description ), $terms ), 'page' => $page );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_terms_save( array $a, Context $c ): array {
        $tax  = self::taxonomy( (string) ( $a['taxonomy'] ?? '' ) );
        $args = array_filter(
            array( 'slug' => isset( $a['slug'] ) ? sanitize_title( (string) $a['slug'] ) : null, 'parent' => isset( $a['parent'] ) ? (int) $a['parent'] : null, 'description' => isset( $a['description'] ) ? wp_kses_post( (string) $a['description'] ) : null ),
            static fn ( $v ) => null !== $v
        );
        if ( ! empty( $a['id'] ) ) {
            $old = get_term( (int) $a['id'], $tax );
            if ( ! $old || is_wp_error( $old ) ) {
                throw new BridgeError( 'not_found', 'No such term.', 404 );
            }
            $res = wp_update_term( (int) $a['id'], $tax, array( 'name' => (string) $a['name'] ) + $args );
            $tid = (int) $a['id'];
            if ( ! is_wp_error( $res ) ) {
                Revisions::record( $c, 'term', "$tax:$tid", array( 'name' => $old->name, 'slug' => $old->slug, 'parent' => $old->parent, 'description' => $old->description ) );
            }
        } else {
            $res = wp_insert_term( (string) $a['name'], $tax, $args );
            $tid = is_wp_error( $res ) ? 0 : (int) $res['term_id'];
            if ( ! is_wp_error( $res ) ) {
                Revisions::record( $c, 'term', "$tax:$tid", null );
            }
        }
        if ( is_wp_error( $res ) ) {
            throw new BridgeError( 'save_failed', $res->get_error_message(), 400 );
        }
        $c->summary = "saved term $tax:$tid";

        return array( 'id' => $tid, 'taxonomy' => $tax );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_terms_delete( array $a, Context $c ): array {
        $tax  = self::taxonomy( (string) ( $a['taxonomy'] ?? '' ) );
        $term = get_term( (int) $a['id'], $tax );
        if ( ! $term || is_wp_error( $term ) ) {
            throw new BridgeError( 'not_found', 'No such term.', 404 );
        }
        if ( (int) get_option( 'default_category' ) === $term->term_id && 'category' === $tax ) {
            throw new BridgeError( 'protected', 'The default category cannot be deleted.', 400 );
        }
        wp_delete_term( $term->term_id, $tax );
        $c->summary = "deleted term $tax:{$term->term_id} \"{$term->name}\"";

        return array( 'deleted' => $term->term_id, 'name' => $term->name, 'posts_affected' => $term->count );
    }

    /* ---------------------------------------------------------------- comments */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_comments_list( array $a, Context $c ): array {
        [ $page, $per ] = Util::paging( $a );
        $args           = array( 'number' => $per, 'offset' => ( $page - 1 ) * $per, 'status' => (string) ( $a['status'] ?? 'all' ), 'search' => (string) ( $a['search'] ?? '' ), 'orderby' => 'comment_date_gmt', 'order' => 'DESC' );
        if ( ! empty( $a['post_id'] ) ) {
            $args['post_id'] = (int) $a['post_id'];
        }
        $out = array();
        foreach ( get_comments( $args ) as $cm ) {
            $row = array( 'id' => (int) $cm->comment_ID, 'post_id' => (int) $cm->comment_post_ID, 'author' => $cm->comment_author, 'date' => $cm->comment_date, 'status' => wp_get_comment_status( $cm ), 'parent' => (int) $cm->comment_parent ?: null, 'content' => $cm->comment_content );
            if ( $c->can( 'admin' ) ) {
                $row['email'] = $cm->comment_author_email;
                $row['ip']    = $cm->comment_author_IP;
            }
            $out[] = $row;
        }

        return array( 'comments' => $out, 'page' => $page );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_comments_moderate( array $a, Context $c ): array {
        $action = (string) $a['action'];
        $before = array();
        $done   = array();
        foreach ( array_slice( array_map( 'intval', (array) $a['ids'] ), 0, 100 ) as $id ) {
            $status = wp_get_comment_status( $id );
            if ( false === $status ) {
                continue;
            }
            $before[ $id ] = array( 'approved' => 'approve', 'unapproved' => 'hold' )[ $status ] ?? $status;
            'unspam' === $action ? wp_unspam_comment( $id ) : wp_set_comment_status( $id, $action );
            $done[] = $id;
        }
        Revisions::record( $c, 'comments', implode( ',', $done ), $before );
        $c->summary = "comments $action: " . implode( ',', $done );

        return array( 'changed' => $done, 'action' => $action );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_comments_reply( array $a, Context $c ): array {
        $parent = get_comment( (int) $a['comment_id'] );
        if ( ! $parent ) {
            throw new BridgeError( 'not_found', 'No such comment.', 404 );
        }
        $user = wp_get_current_user();
        $id   = wp_insert_comment( wp_slash( array( 'comment_post_ID' => $parent->comment_post_ID, 'comment_parent' => $parent->comment_ID, 'comment_content' => wp_kses_post( (string) $a['content'] ), 'user_id' => $user->ID, 'comment_author' => $user->display_name, 'comment_author_email' => $user->user_email, 'comment_approved' => 1 ) ) );
        if ( ! $id ) {
            throw new BridgeError( 'failed', 'Could not add the reply.', 500 );
        }
        $c->summary = "replied to comment {$parent->comment_ID}";

        return array( 'id' => (int) $id );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_comments_delete( array $a, Context $c ): array {
        $deleted = array();
        foreach ( array_slice( array_map( 'intval', (array) $a['ids'] ), 0, 100 ) as $id ) {
            if ( wp_delete_comment( $id, true ) ) {
                $deleted[] = $id;
            }
        }
        $c->summary = 'deleted comments: ' . implode( ',', $deleted );

        return array( 'deleted' => $deleted );
    }

    /** @return array{0: string, 1: int} */
    private static function meta_target( array $a, Context $c ): array {
        $obj = (string) ( $a['object'] ?? 'post' );
        if ( ! in_array( $obj, array( 'post', 'user', 'term', 'comment' ), true ) ) {
            throw new BridgeError( 'bad_arguments', 'object must be post, user, term or comment.', 400 );
        }
        if ( 'user' === $obj ) {
            $c->need( 'admin', 'User meta is private.' );
        }

        return array( $obj, (int) $a['id'] );
    }

    private static function meta_key_ok( string $key, Context $c ): void {
        if ( '' === $key || strlen( $key ) > 191 || Policy::is_secret_key( $key ) ) {
            throw new BridgeError( 'forbidden', 'That meta key is not available.', 403 );
        }
        if ( str_starts_with( $key, '_' ) && ! $c->can( 'admin' ) ) {
            throw new BridgeError( 'forbidden', 'Keys starting with an underscore need admin level.', 403 );
        }
    }

    /**
     * Reads meta of a post, user, term or comment (one key, or all).
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_meta_get( array $a, Context $c ): array {
        [ $obj, $id ] = self::meta_target( $a, $c );
        $key = (string) ( $a['key'] ?? '' );
        if ( '' !== $key ) {
            self::meta_key_ok( $key, $c );

            return array( 'object' => $obj, 'id' => $id, 'key' => $key, 'value' => get_metadata( $obj, $id, $key, true ) );
        }
        $out = array();
        foreach ( (array) get_metadata( $obj, $id ) as $k => $vals ) {
            if ( Policy::is_secret_key( (string) $k ) || ( str_starts_with( (string) $k, '_' ) && ! $c->can( 'admin' ) ) ) {
                continue;
            }
            $out[ $k ] = array_map( 'maybe_unserialize', (array) $vals );
        }

        return array( 'object' => $obj, 'id' => $id, 'meta' => $out );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_meta_set( array $a, Context $c ): array {
        [ $obj, $id ] = self::meta_target( $a, $c );
        $key = (string) $a['key'];
        self::meta_key_ok( $key, $c );
        $prev = get_metadata( $obj, $id, $key, true );
        update_metadata( $obj, $id, $key, wp_slash( $a['value'] ?? '' ) );
        $c->summary = "set $obj meta $key on #$id";

        return array( 'object' => $obj, 'id' => $id, 'key' => $key, 'previous' => $prev, 'note' => 'Call meta_set with "previous" to revert.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_meta_delete( array $a, Context $c ): array {
        [ $obj, $id ] = self::meta_target( $a, $c );
        $key = (string) $a['key'];
        self::meta_key_ok( $key, $c );
        $prev = get_metadata( $obj, $id, $key, true );
        delete_metadata( $obj, $id, $key );
        $c->summary = "deleted $obj meta $key on #$id";

        return array( 'object' => $obj, 'id' => $id, 'key' => $key, 'previous' => $prev );
    }
}
