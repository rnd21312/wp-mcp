<?php
/**
 * Part of Maintain: database information, cleanup, optimise and search-replace.
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

trait MaintainDatabase {

    /* ---------------------------------------------------------------- database */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_db_info( array $a, Context $c ): array {
        global $wpdb;
        $rows   = (array) $wpdb->get_results( $wpdb->prepare( 'SELECT TABLE_NAME AS name, TABLE_ROWS AS table_rows, DATA_LENGTH + INDEX_LENGTH AS bytes, DATA_FREE AS overhead FROM information_schema.TABLES WHERE TABLE_SCHEMA = %s AND TABLE_NAME LIKE %s ORDER BY bytes DESC', DB_NAME, $wpdb->esc_like( $wpdb->prefix ) . '%' ), ARRAY_A );
        $total  = 0;
        $tables = array();
        foreach ( $rows as $r ) {
            $total   += (int) $r['bytes'];
            $tables[] = array( 'table' => $r['name'], 'rows' => (int) $r['table_rows'], 'size' => size_format( (int) $r['bytes'] ), 'overhead' => size_format( (int) $r['overhead'] ) );
        }
        $opt   = $wpdb->options;
        $auto  = (int) $wpdb->get_var( "SELECT SUM(LENGTH(option_value)) FROM $opt WHERE autoload IN ('yes','on','auto','auto-on')" ); // phpcs:ignore WordPress.DB
        $big   = (array) $wpdb->get_results( "SELECT option_name AS name, LENGTH(option_value) AS bytes FROM $opt WHERE autoload IN ('yes','on','auto','auto-on') ORDER BY bytes DESC LIMIT 8", ARRAY_A ); // phpcs:ignore WordPress.DB
        $count = static fn ( string $sql ): int => (int) $wpdb->get_var( $sql ); // phpcs:ignore WordPress.DB

        return array(
            'total_size'   => size_format( $total ),
            'tables'       => array_slice( $tables, 0, 25 ),
            'autoload'     => array( 'size' => size_format( $auto ), 'largest' => array_map( static fn ( $r ) => array( 'option' => $r['name'], 'size' => size_format( (int) $r['bytes'] ) ), $big ), 'note' => 'Over 1 MB of autoloaded options slows every page.' ),
            'cleanable'    => array(
                'revisions'    => $count( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type='revision'" ),
                'auto_drafts'  => $count( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_status='auto-draft'" ),
                'trash'        => $count( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_status='trash'" ),
                'spam_comments' => $count( "SELECT COUNT(*) FROM {$wpdb->comments} WHERE comment_approved='spam'" ),
                'expired_transients' => $count( "SELECT COUNT(*) FROM $opt WHERE option_name LIKE '\\_transient\\_timeout\\_%' AND option_value < UNIX_TIMESTAMP()" ),
                'orphan_postmeta' => $count( "SELECT COUNT(*) FROM {$wpdb->postmeta} pm LEFT JOIN {$wpdb->posts} p ON p.ID = pm.post_id WHERE p.ID IS NULL" ),
            ),
        );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_db_cleanup( array $a, Context $c ): array {
        $info = self::op_db_info( array(), $c )['cleanable'];

        return array( 'targets' => $a['targets'], 'would_remove_up_to' => array_intersect_key( $info, array_flip( array_map( static fn ( $t ) => array( 'transients' => 'expired_transients', 'spam' => 'spam_comments', 'orphan_meta' => 'orphan_postmeta' )[ $t ] ?? $t, (array) $a['targets'] ) ) ), 'permanent' => true );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_db_cleanup( array $a, Context $c ): array {
        global $wpdb;
        $targets = array_intersect( array_map( 'strval', (array) $a['targets'] ), array( 'revisions', 'transients', 'spam', 'trash', 'auto_drafts', 'orphan_meta' ) );
        if ( ! $targets ) {
            throw new BridgeError( 'bad_targets', 'targets: revisions, transients, spam, trash, auto_drafts, orphan_meta.', 400 );
        }
        @set_time_limit( 300 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        $result = array();
        foreach ( $targets as $t ) {
            switch ( $t ) {
                case 'revisions':
                    $keep    = max( 0, (int) ( $a['keep_revisions'] ?? 5 ) );
                    $deleted = 0;
                    $parents = (array) $wpdb->get_col( $wpdb->prepare( "SELECT post_parent FROM {$wpdb->posts} WHERE post_type='revision' GROUP BY post_parent HAVING COUNT(*) > %d LIMIT 1000", $keep ) );
                    foreach ( $parents as $pid ) {
                        foreach ( array_slice( array_values( wp_get_post_revisions( (int) $pid ) ), $keep ) as $rev ) {
                            wp_delete_post_revision( $rev->ID );
                            ++$deleted;
                        }
                    }
                    $result['revisions'] = $deleted;
                    break;
                case 'transients':
                    delete_expired_transients( true );
                    $result['transients'] = 'expired ones removed';
                    break;
                case 'spam':
                    $ids = (array) $wpdb->get_col( "SELECT comment_ID FROM {$wpdb->comments} WHERE comment_approved='spam' LIMIT 5000" ); // phpcs:ignore WordPress.DB
                    foreach ( $ids as $id ) {
                        wp_delete_comment( (int) $id, true );
                    }
                    $result['spam'] = count( $ids );
                    break;
                case 'trash':
                    $ids = (array) $wpdb->get_col( "SELECT ID FROM {$wpdb->posts} WHERE post_status='trash' AND post_type NOT IN ('nav_menu_item','revision') LIMIT 2000" ); // phpcs:ignore WordPress.DB
                    foreach ( $ids as $id ) {
                        wp_delete_post( (int) $id, true );
                    }
                    $result['trash'] = count( $ids );
                    break;
                case 'auto_drafts':
                    $ids = (array) $wpdb->get_col( "SELECT ID FROM {$wpdb->posts} WHERE post_status='auto-draft' AND post_modified < (UTC_TIMESTAMP() - INTERVAL 7 DAY) LIMIT 5000" ); // phpcs:ignore WordPress.DB
                    foreach ( $ids as $id ) {
                        wp_delete_post( (int) $id, true );
                    }
                    $result['auto_drafts'] = count( $ids );
                    break;
                case 'orphan_meta':
                    $a1 = $wpdb->query( "DELETE pm FROM {$wpdb->postmeta} pm LEFT JOIN {$wpdb->posts} p ON p.ID = pm.post_id WHERE p.ID IS NULL" ); // phpcs:ignore WordPress.DB
                    $a2 = $wpdb->query( "DELETE cm FROM {$wpdb->commentmeta} cm LEFT JOIN {$wpdb->comments} c ON c.comment_ID = cm.comment_id WHERE c.comment_ID IS NULL" ); // phpcs:ignore WordPress.DB
                    $result['orphan_meta'] = (int) $a1 + (int) $a2;
                    break;
            }
        }
        $c->summary = 'db cleanup: ' . wp_json_encode( $result );

        return array( 'removed' => $result, 'note' => 'Permanent. Take a backup first when unsure.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_db_optimize( array $a, Context $c ): array {
        global $wpdb;
        $done = array();
        foreach ( self::tables() as $table ) {
            $wpdb->query( 'OPTIMIZE TABLE `' . esc_sql( $table ) . '`' ); // phpcs:ignore WordPress.DB
            $done[] = $table;
        }
        $c->summary = 'optimized ' . count( $done ) . ' tables';

        return array( 'optimized' => $done );
    }

    /* ----------------------------------------------------------- search/replace */

    /**
     * Replaces inside strings and serialized structures without breaking lengths.
     *
     * @param mixed $data Value.
     * @return mixed
     */
    public static function replace_deep( $data, string $search, string $replace, int &$hits ) {
        if ( is_string( $data ) ) {
            if ( is_serialized( $data ) ) {
                $un = @unserialize( $data, array( 'allowed_classes' => false ) ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
                if ( false === $un && 'b:0;' !== $data ) {
                    return $data; // Cannot unserialize safely: leave untouched.
                }
                if ( is_object( $un ) || str_contains( $data, '__PHP_Incomplete_Class' ) ) {
                    return $data;
                }

                return serialize( self::replace_deep( $un, $search, $replace, $hits ) );
            }
            $count = 0;
            $out   = str_replace( $search, $replace, $data, $count );
            $hits += $count;

            return $out;
        }
        if ( is_array( $data ) ) {
            $new = array();
            foreach ( $data as $k => $v ) {
                $new[ is_string( $k ) ? self::replace_deep( $k, $search, $replace, $hits ) : $k ] = self::replace_deep( $v, $search, $replace, $hits );
            }

            return $new;
        }

        return $data;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    private static function run_search_replace( array $a, bool $apply ): array {
        global $wpdb;
        $search  = (string) $a['search'];
        $replace = (string) $a['replace'];
        if ( strlen( $search ) < 3 ) {
            throw new BridgeError( 'bad_search', 'The search text must be at least 3 characters.', 400 );
        }
        @set_time_limit( 300 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        $allowed = self::tables();
        $tables  = ! empty( $a['tables'] ) ? array_values( array_intersect( array_map( 'strval', (array) $a['tables'] ), $allowed ) ) : $allowed;
        $report  = array();
        $total   = 0;
        foreach ( $tables as $table ) {
            if ( in_array( $table, array( \WPMCP\Bridge\Activity::table(), Revisions::table() ), true ) ) {
                continue;
            }
            $cols = (array) $wpdb->get_results( 'SHOW COLUMNS FROM `' . esc_sql( $table ) . '`', ARRAY_A ); // phpcs:ignore WordPress.DB
            $pk   = '';
            $text = array();
            foreach ( $cols as $col ) {
                if ( 'PRI' === $col['Key'] && '' === $pk ) {
                    $pk = $col['Field'];
                }
                if ( preg_match( '/char|text|blob/i', (string) $col['Type'] ) && ! in_array( $col['Field'], array( 'guid' ), true ) ) {
                    $text[] = $col['Field'];
                }
            }
            if ( '' === $pk || ! $text ) {
                continue;
            }
            $hits_table = 0;
            $changed    = 0;
            $last       = null;
            do {
                $sql  = 'SELECT * FROM `' . esc_sql( $table ) . '`' . ( null === $last ? '' : $wpdb->prepare( ' WHERE `' . esc_sql( $pk ) . '` > %s', $last ) ) . ' ORDER BY `' . esc_sql( $pk ) . '` ASC LIMIT 300'; // phpcs:ignore WordPress.DB
                $rows = (array) $wpdb->get_results( $sql, ARRAY_A ); // phpcs:ignore WordPress.DB
                foreach ( $rows as $row ) {
                    $last = $row[ $pk ];
                    if ( $table === $wpdb->options && str_starts_with( (string) ( $row['option_name'] ?? '' ), 'wpm_bridge_' ) ) {
                        continue;
                    }
                    $update = array();
                    foreach ( $text as $col ) {
                        if ( null === $row[ $col ] || '' === $row[ $col ] ) {
                            continue;
                        }
                        $hits = 0;
                        $new  = self::replace_deep( $row[ $col ], $search, $replace, $hits );
                        if ( $hits > 0 && $new !== $row[ $col ] ) {
                            $update[ $col ] = $new;
                            $hits_table    += $hits;
                        }
                    }
                    if ( $update ) {
                        ++$changed;
                        if ( $apply ) {
                            $wpdb->update( $table, $update, array( $pk => $row[ $pk ] ) );
                        }
                    }
                }
            } while ( 300 === count( $rows ) );
            if ( $hits_table ) {
                $report[] = array( 'table' => $table, 'rows' => $changed, 'replacements' => $hits_table );
                $total   += $hits_table;
            }
        }
        if ( $apply ) {
            wp_cache_flush();
        }

        return array( 'applied' => $apply, 'replacements' => $total, 'tables' => $report );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_search_replace( array $a, Context $c ): array {
        $r = self::run_search_replace( $a, false );

        return $r + array( 'needs_confirmation' => ! empty( $a['apply'] ), 'permanent' => true, 'advice' => 'Take maintain.backup_create first.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_search_replace( array $a, Context $c ): array {
        $r          = self::run_search_replace( $a, ! empty( $a['apply'] ) );
        $c->summary = ( $r['applied'] ? 'replaced' : 'counted' ) . " \"{$a['search']}\": {$r['replacements']} matches";

        return $r;
    }
}
