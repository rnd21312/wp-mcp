<?php
/**
 * The site-side activity log: what the bridge did, for whom, with what result.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class Activity {

    public static function table(): string {
        global $wpdb;

        return $wpdb->prefix . 'wpm_activity';
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
  level varchar(10) NOT NULL,
  status varchar(12) NOT NULL,
  actor varchar(100) NOT NULL,
  client varchar(100) NOT NULL,
  summary text NOT NULL,
  revision bigint(20) unsigned NOT NULL DEFAULT 0,
  request_id varchar(40) NOT NULL,
  PRIMARY KEY  (id),
  KEY op (op)
) $charset;"
        );
    }

    public static function log( Context $c, string $status, string $summary = '' ): void {
        global $wpdb;
        $wpdb->insert(
            self::table(),
            array(
                'created'    => gmdate( 'Y-m-d H:i:s' ),
                'op'         => substr( $c->op, 0, 64 ),
                'level'      => $c->level,
                'status'     => $status,
                'actor'      => substr( $c->actor, 0, 100 ),
                'client'     => substr( $c->client, 0, 100 ),
                'summary'    => substr( '' !== $summary ? $summary : $c->summary, 0, 500 ),
                'revision'   => $c->revision,
                'request_id' => substr( $c->request_id, 0, 40 ),
            )
        );
    }

    /**
     * @param array<string, mixed> $filter op, status, since, page, per_page.
     * @return array<string, mixed>
     */
    public static function list( array $filter ): array {
        global $wpdb;
        $where  = array( '1=1' );
        $params = array();
        if ( ! empty( $filter['op'] ) ) {
            $where[]  = 'op = %s';
            $params[] = (string) $filter['op'];
        }
        if ( ! empty( $filter['status'] ) ) {
            $where[]  = 'status = %s';
            $params[] = (string) $filter['status'];
        }
        if ( ! empty( $filter['since'] ) && false !== strtotime( (string) $filter['since'] ) ) {
            $where[]  = 'created >= %s';
            $params[] = gmdate( 'Y-m-d H:i:s', (int) strtotime( (string) $filter['since'] ) );
        }
        $per_page = max( 1, min( 100, (int) ( $filter['per_page'] ?? 20 ) ) );
        $page     = max( 1, (int) ( $filter['page'] ?? 1 ) );
        $sql      = 'SELECT id, created, op, level, status, actor, summary, revision FROM ' . self::table() . ' WHERE ' . implode( ' AND ', $where ) . ' ORDER BY id DESC LIMIT %d OFFSET %d';
        $rows     = $wpdb->get_results( $wpdb->prepare( $sql, ...array_merge( $params, array( $per_page, ( $page - 1 ) * $per_page ) ) ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL

        return array( 'entries' => (array) $rows, 'page' => $page, 'per_page' => $per_page );
    }

    public static function prune(): void {
        global $wpdb;
        $wpdb->query( 'DELETE FROM ' . self::table() . ' WHERE id <= (SELECT m FROM (SELECT COALESCE(MAX(id),0) - 5000 AS m FROM ' . self::table() . ') x)' ); // phpcs:ignore WordPress.DB.PreparedSQL
    }
}
