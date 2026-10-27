<?php
/**
 * Undo: before/after snapshots of what each write changed, and the code that puts them back.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class Revisions {

    private const VOLATILE_META = array( '_edit_lock', '_edit_last', '_wp_old_slug', '_pingme', '_encloseme', '_wp_trash_meta_status', '_wp_trash_meta_time' );

    private const MAX_BYTES = 1500000;

    public static function table(): string {
        global $wpdb;

        return $wpdb->prefix . 'wpm_revisions';
    }

    public static function install(): void {
        global $wpdb;
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        $charset = $wpdb->get_charset_collate();
        dbDelta(
            'CREATE TABLE ' . self::table() . " (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  created datetime NOT NULL,
  op varchar(64) NOT NULL,
  actor varchar(100) NOT NULL,
  level varchar(10) NOT NULL,
  type varchar(20) NOT NULL,
  target varchar(191) NOT NULL,
  before_json longtext NOT NULL,
  after_json longtext NOT NULL,
  undone tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY  (id),
  KEY target (type, target)
) $charset;"
        );
    }

    /**
     * Stores a change. $before null means "did not exist".
     *
     * @param mixed $before Snapshot before the change.
     * @param mixed $after  Snapshot after (informational).
     */
    public static function record( Context $c, string $type, string $target, $before, $after = null ): int {
        global $wpdb;
        $b = (string) wp_json_encode( $before, JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR );
        $a = (string) wp_json_encode( $after, JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR );
        if ( strlen( $b ) > self::MAX_BYTES ) {
            $b = (string) wp_json_encode( array( '__too_large' => true ) );
        }
        if ( strlen( $a ) > self::MAX_BYTES ) {
            $a = '{"__too_large":true}';
        }
        $wpdb->insert(
            self::table(),
            array(
                'created'     => gmdate( 'Y-m-d H:i:s' ),
                'op'          => substr( $c->op, 0, 64 ),
                'actor'       => substr( $c->actor, 0, 100 ),
                'level'       => $c->level,
                'type'        => $type,
                'target'      => substr( $target, 0, 191 ),
                'before_json' => $b,
                'after_json'  => $a,
            )
        );
        $id          = (int) $wpdb->insert_id;
        $c->revision = $id;

        return $id;
    }

    /**
     * @param array<string, mixed> $filter target, id, page, per_page.
     * @return array<string, mixed>
     */
    public static function list( array $filter ): array {
        global $wpdb;
        $where  = array( '1=1' );
        $params = array();
        if ( ! empty( $filter['target'] ) ) {
            $where[]  = 'type = %s';
            $params[] = (string) $filter['target'];
        }
        if ( isset( $filter['id'] ) && '' !== (string) $filter['id'] ) {
            $where[]  = 'target = %s';
            $params[] = (string) $filter['id'];
        }
        $per_page = max( 1, min( 100, (int) ( $filter['per_page'] ?? 20 ) ) );
        $page     = max( 1, (int) ( $filter['page'] ?? 1 ) );
        $sql      = 'SELECT id, created, op, actor, level, type, target, undone, LENGTH(before_json) AS bytes FROM ' . self::table() . ' WHERE ' . implode( ' AND ', $where ) . ' ORDER BY id DESC LIMIT %d OFFSET %d';
        $rows     = $wpdb->get_results( $wpdb->prepare( $sql, ...array_merge( $params, array( $per_page, ( $page - 1 ) * $per_page ) ) ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL

        return array( 'revisions' => (array) $rows, 'page' => $page );
    }

    /* --------------------------------------------------------------- snapshots */

    /**
     * Fields, meta and terms of a post.
     *
     * @return array<string, mixed>|null
     */
    public static function snap_post( int $id ): ?array {
        $post = get_post( $id );
        if ( ! $post ) {
            return null;
        }
        $fields = array();
        foreach ( array( 'post_title', 'post_content', 'post_excerpt', 'post_status', 'post_name', 'post_parent', 'menu_order', 'comment_status', 'ping_status', 'post_date', 'post_date_gmt', 'post_type', 'post_password' ) as $f ) {
            $fields[ $f ] = $post->$f;
        }
        $meta = array();
        foreach ( (array) get_post_meta( $id ) as $key => $values ) {
            if ( ! in_array( $key, self::VOLATILE_META, true ) && ! Policy::is_secret_key( (string) $key ) ) {
                $meta[ $key ] = array_map( 'maybe_unserialize', (array) $values );
            }
        }
        $terms = array();
        foreach ( get_object_taxonomies( $post->post_type ) as $tax ) {
            $terms[ $tax ] = wp_get_object_terms( $id, $tax, array( 'fields' => 'ids' ) );
        }

        return array( 'fields' => $fields, 'meta' => $meta, 'terms' => $terms );
    }

    /**
     * @return array<string, mixed>
     */
    public static function snap_option( string $key ): array {
        $sentinel = new \stdClass();
        $value    = get_option( $key, $sentinel );

        return $value === $sentinel ? array( 'key' => $key, 'exists' => false ) : array( 'key' => $key, 'exists' => true, 'value' => $value );
    }

    /* ------------------------------------------------------------------- undo */

    /**
     * @return array<string, mixed>
     */
    public static function undo( int $id, Context $c ): array {
        global $wpdb;
        $row = $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM ' . self::table() . ' WHERE id = %d', $id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL
        if ( ! $row ) {
            throw new BridgeError( 'not_found', "No revision $id.", 404 );
        }
        if ( (int) $row['undone'] ) {
            throw new BridgeError( 'already_undone', "Revision $id was already undone.", 409 );
        }
        $c->need( (string) $row['level'], 'Undo needs at least the level the original change needed.' );
        $before = json_decode( (string) $row['before_json'], true );
        if ( is_array( $before ) && ! empty( $before['__too_large'] ) ) {
            throw new BridgeError( 'not_undoable', 'This change was too large to snapshot, so it cannot be undone automatically.', 409 );
        }

        $result = self::restore( (string) $row['type'], (string) $row['target'], $before );
        $wpdb->update( self::table(), array( 'undone' => 1 ), array( 'id' => $id ) );
        $c->summary = "undo revision $id ({$row['op']})";

        return array( 'undone' => $id, 'type' => $row['type'], 'target' => $row['target'], 'result' => $result );
    }

    /**
     * @param mixed $before Stored snapshot.
     * @return string What was done.
     */
    private static function restore( string $type, string $target, $before ): string {
        switch ( $type ) {
            case 'post':
                $id = (int) $target;
                if ( null === $before ) {
                    if ( ! get_post( $id ) ) {
                        throw new BridgeError( 'gone', 'The item no longer exists.', 404 );
                    }
                    wp_trash_post( $id );

                    return 'The item that was created is now in the trash.';
                }
                if ( ! get_post( $id ) ) {
                    throw new BridgeError( 'gone', 'The item was deleted permanently and cannot be restored.', 404 );
                }
                $update = wp_update_post( wp_slash( array_merge( (array) $before['fields'], array( 'ID' => $id ) ) ), true );
                if ( is_wp_error( $update ) ) {
                    throw new BridgeError( 'restore_failed', $update->get_error_message(), 500 );
                }
                $wanted = (array) ( $before['meta'] ?? array() );
                foreach ( array_keys( (array) get_post_meta( $id ) ) as $key ) {
                    if ( ! isset( $wanted[ $key ] ) && ! in_array( $key, self::VOLATILE_META, true ) && ! Policy::is_secret_key( (string) $key ) ) {
                        delete_post_meta( $id, (string) $key );
                    }
                }
                foreach ( $wanted as $key => $values ) {
                    delete_post_meta( $id, (string) $key );
                    foreach ( (array) $values as $value ) {
                        add_post_meta( $id, (string) $key, wp_slash( $value ) );
                    }
                }
                foreach ( (array) ( $before['terms'] ?? array() ) as $tax => $ids ) {
                    wp_set_object_terms( $id, array_map( 'intval', (array) $ids ), (string) $tax );
                }

                return 'Restored the earlier fields, meta and terms.';

            case 'option':
                $key = (string) ( $before['key'] ?? $target );
                if ( Policy::is_secret_key( $key ) ) {
                    throw new BridgeError( 'forbidden', 'That option cannot be changed.', 403 );
                }
                if ( empty( $before['exists'] ) ) {
                    delete_option( $key );

                    return 'Option removed (it did not exist before).';
                }
                update_option( $key, $before['value'] );

                return 'Option restored.';

            case 'options':
                foreach ( (array) $before as $snap ) {
                    $key = (string) ( $snap['key'] ?? '' );
                    if ( '' === $key || Policy::is_secret_key( $key ) ) {
                        continue;
                    }
                    if ( empty( $snap['exists'] ) ) {
                        delete_option( $key );
                    } else {
                        update_option( $key, $snap['value'] );
                    }
                }

                return 'Settings restored.';

            case 'theme':
                if ( ! wp_get_theme( (string) $before )->exists() ) {
                    throw new BridgeError( 'gone', 'The previous theme is no longer installed.', 404 );
                }
                switch_theme( (string) $before );

                return 'Previous theme reactivated.';

            case 'term':
                $parts = explode( ':', $target, 2 );
                $tax   = $parts[0];
                $tid   = (int) ( $parts[1] ?? 0 );
                if ( null === $before ) {
                    wp_delete_term( $tid, $tax );

                    return 'The term that was created is deleted.';
                }
                $res = wp_update_term( $tid, $tax, (array) $before );
                if ( is_wp_error( $res ) ) {
                    throw new BridgeError( 'restore_failed', $res->get_error_message(), 500 );
                }

                return 'Term restored.';

            case 'file':
                return Handlers\Design::restore_file( $target, (array) $before );

            case 'menu':
                return Handlers\Design::restore_menu( $target, $before );

            case 'comments':
                foreach ( (array) $before as $comment_id => $status ) {
                    wp_set_comment_status( (int) $comment_id, (string) $status );
                }

                return 'Comment statuses restored.';

            case 'plugins':
                require_once ABSPATH . 'wp-admin/includes/plugin.php';
                $wanted  = (array) ( $before['active'] ?? array() );
                $current = (array) get_option( 'active_plugins', array() );
                $self    = plugin_basename( WPMCP_FILE );
                foreach ( array_diff( $current, $wanted ) as $plugin ) {
                    if ( $plugin !== $self ) {
                        deactivate_plugins( $plugin );
                    }
                }
                foreach ( array_diff( $wanted, $current ) as $plugin ) {
                    activate_plugin( $plugin );
                }

                return 'Plugin activation restored.';
        }

        throw new BridgeError( 'not_undoable', "Unknown revision type $type.", 409 );
    }

    public static function prune(): void {
        global $wpdb;
        $wpdb->query( 'DELETE FROM ' . self::table() . ' WHERE id <= (SELECT m FROM (SELECT COALESCE(MAX(id),0) - 1500 AS m FROM ' . self::table() . ') x)' ); // phpcs:ignore WordPress.DB.PreparedSQL
    }
}
