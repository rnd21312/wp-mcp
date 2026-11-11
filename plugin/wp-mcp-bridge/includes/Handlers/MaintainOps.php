<?php
/**
 * Part of Maintain: logs, cache, cron, language packs, maintenance mode and SQL.
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

trait MaintainOps {

    /* -------------------------------------------------------------------- logs */

    private static function log_path(): ?string {
        $candidates = array();
        if ( defined( 'WP_DEBUG_LOG' ) && is_string( WP_DEBUG_LOG ) ) {
            $candidates[] = WP_DEBUG_LOG;
        }
        $candidates[] = WP_CONTENT_DIR . '/debug.log';
        $ini          = ini_get( 'error_log' );
        if ( $ini ) {
            $candidates[] = $ini;
        }
        foreach ( $candidates as $path ) {
            if ( is_string( $path ) && is_file( $path ) && is_readable( $path ) ) {
                return $path;
            }
        }

        return null;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_logs( array $a, Context $c ): array {
        $path = self::log_path();
        if ( null === $path ) {
            return array( 'enabled' => defined( 'WP_DEBUG_LOG' ) && WP_DEBUG_LOG, 'entries' => array(), 'note' => 'No log file found. To record errors, set WP_DEBUG and WP_DEBUG_LOG to true in wp-config.php (and WP_DEBUG_DISPLAY to false).' );
        }
        $size = (int) filesize( $path );
        $fh   = fopen( $path, 'rb' );
        fseek( $fh, max( 0, $size - 600000 ) );
        $chunk = (string) stream_get_contents( $fh );
        fclose( $fh );
        $want   = max( 10, min( 500, (int) ( $a['lines'] ?? 100 ) ) );
        $filter = (string) ( $a['contains'] ?? '' );
        $groups = array();
        foreach ( array_reverse( explode( "\n", $chunk ) ) as $line ) {
            $line = trim( $line );
            if ( '' === $line || ( '' !== $filter && false === stripos( $line, $filter ) ) ) {
                continue;
            }
            $when = '';
            if ( preg_match( '/^\[([^\]]+)\]\s*(.*)$/', $line, $m ) ) {
                $when = $m[1];
                $line = $m[2];
            }
            $line = str_replace( array( ABSPATH, WP_CONTENT_DIR ), array( '/', '/wp-content' ), $line );
            $key  = md5( (string) preg_replace( '/\d+/', '#', substr( $line, 0, 200 ) ) );
            if ( ! isset( $groups[ $key ] ) ) {
                if ( count( $groups ) >= $want ) {
                    continue;
                }
                $groups[ $key ] = array( 'last' => $when, 'count' => 0, 'message' => substr( $line, 0, 500 ) );
            }
            ++$groups[ $key ]['count'];
        }

        return array( 'file_bytes' => $size, 'entries' => array_values( $groups ), 'note' => 'Newest first, repeated messages grouped. Messages may include text from visitors.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_logs_clear( array $a, Context $c ): array {
        $path = self::log_path();
        if ( null === $path || ! is_writable( $path ) ) {
            throw new BridgeError( 'not_found', 'No writable log file.', 404 );
        }
        file_put_contents( $path, '' );
        $c->summary = 'cleared the error log';

        return array( 'cleared' => true );
    }

    /* ------------------------------------------------------------------- cache */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_cache_flush( array $a, Context $c ): array {
        $scope = array_map( 'strval', (array) ( $a['scope'] ?? array( 'object', 'transients', 'rewrite', 'plugins' ) ) );
        $done  = array();
        if ( in_array( 'object', $scope, true ) ) {
            wp_cache_flush();
            $done[] = 'object cache';
        }
        if ( in_array( 'transients', $scope, true ) ) {
            delete_expired_transients( true );
            $done[] = 'expired transients';
        }
        if ( in_array( 'rewrite', $scope, true ) ) {
            flush_rewrite_rules( false );
            $done[] = 'rewrite rules';
        }
        if ( in_array( 'plugins', $scope, true ) ) {
            $done = array_merge( $done, self::flush_cache_plugins() );
        }
        $c->summary = 'flushed: ' . implode( ', ', $done );

        return array( 'flushed' => $done );
    }

    /** @return array<int, string> */
    private static function flush_cache_plugins(): array {
        $done = array();
        $try  = array(
            'WP Rocket'         => static function (): bool { if ( function_exists( 'rocket_clean_domain' ) ) { rocket_clean_domain(); return true; } return false; },
            'W3 Total Cache'    => static function (): bool { if ( function_exists( 'w3tc_flush_all' ) ) { w3tc_flush_all(); return true; } return false; },
            'LiteSpeed Cache'   => static function (): bool { if ( defined( 'LSCWP_V' ) ) { do_action( 'litespeed_purge_all' ); return true; } return false; },
            'WP Super Cache'    => static function (): bool { if ( function_exists( 'wp_cache_clear_cache' ) ) { wp_cache_clear_cache(); return true; } return false; },
            'WP Fastest Cache'  => static function (): bool { if ( isset( $GLOBALS['wp_fastest_cache'] ) && method_exists( $GLOBALS['wp_fastest_cache'], 'deleteCache' ) ) { $GLOBALS['wp_fastest_cache']->deleteCache( true ); return true; } return false; },
            'Autoptimize'       => static function (): bool { if ( class_exists( 'autoptimizeCache' ) ) { \autoptimizeCache::clearall(); return true; } return false; },
            'SiteGround'        => static function (): bool { if ( function_exists( 'sg_cachepress_purge_cache' ) ) { sg_cachepress_purge_cache(); return true; } return false; },
            'Breeze'            => static function (): bool { if ( class_exists( 'Breeze_PurgeCache' ) ) { do_action( 'breeze_clear_all_cache' ); return true; } return false; },
            'WP-Optimize'       => static function (): bool { if ( function_exists( 'WP_Optimize' ) ) { do_action( 'wpo_cache_flush' ); return true; } return false; },
        );
        foreach ( $try as $name => $fn ) {
            try {
                if ( $fn() ) {
                    $done[] = $name;
                }
            } catch ( \Throwable $e ) {
                continue;
            }
        }

        return $done;
    }

    /* -------------------------------------------------------------------- cron */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_cron_list( array $a, Context $c ): array {
        $out = array();
        foreach ( (array) _get_cron_array() as $time => $hooks ) {
            foreach ( (array) $hooks as $hook => $events ) {
                foreach ( (array) $events as $event ) {
                    $out[] = array( 'hook' => $hook, 'next_run' => gmdate( 'c', (int) $time ), 'schedule' => $event['schedule'] ?: 'once', 'registered' => has_action( (string) $hook ) ? true : false );
                }
            }
        }

        return array( 'events' => array_slice( $out, 0, 150 ), 'total' => count( $out ), 'cron_disabled' => defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_cron_run( array $a, Context $c ): array {
        $hook = (string) $a['hook'];
        foreach ( (array) _get_cron_array() as $hooks ) {
            if ( isset( $hooks[ $hook ] ) ) {
                $args = (array) reset( $hooks[ $hook ] )['args'];
                if ( ! has_action( $hook ) ) {
                    throw new BridgeError( 'not_registered', 'Nothing is hooked to that event.', 400 );
                }
                do_action_ref_array( $hook, $args );
                $c->summary = "ran cron hook $hook";

                return array( 'ran' => $hook );
            }
        }
        throw new BridgeError( 'not_found', 'That hook is not scheduled. Use maintain.cron_list.', 404 );
    }

    /* -------------------------------------------------------------- maintenance */

    /**
     * Downloads a WordPress language pack (core, plugins, themes) and optionally makes it the site language.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_language_install( array $a, Context $c ): array {
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/misc.php';
        require_once ABSPATH . 'wp-admin/includes/translation-install.php';
        require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
        $locale = preg_replace( '/[^A-Za-z_]/', '', (string) $a['locale'] );
        if ( '' === $locale ) {
            throw new BridgeError( 'bad_arguments', 'locale must look like fa_IR.', 400 );
        }
        self::require_direct_fs();
        $got = 'en_US' === $locale ? $locale : wp_download_language_pack( $locale );
        if ( ! $got ) {
            throw new BridgeError( 'not_found', "WordPress.org has no language pack \"$locale\" (or the download failed).", 404 );
        }
        // Plugin and theme packs.
        $upgrader = new \Language_Pack_Upgrader( new \Automatic_Upgrader_Skin() );
        wp_clean_update_cache();
        wp_update_themes();
        wp_update_plugins();
        $upgrader->bulk_upgrade();
        $before = get_option( 'WPLANG' );
        if ( ! empty( $a['activate'] ) ) {
            update_option( 'WPLANG', 'en_US' === $locale ? '' : $locale );
            Revisions::record( $c, 'option', 'WPLANG', array( 'key' => 'WPLANG', 'value' => $before, 'exists' => false !== $before ) );
        }
        $c->summary = "installed language $locale";

        return array( 'locale' => $locale, 'installed' => true, 'activated' => ! empty( $a['activate'] ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_maintenance_mode( array $a, Context $c ): array {
        $before = Revisions::snap_option( 'wpm_maintenance' );
        $state  = array( 'on' => (bool) $a['enabled'], 'message' => sanitize_text_field( (string) ( $a['message'] ?? 'We are doing some maintenance and will be back shortly.' ) ) );
        update_option( 'wpm_maintenance', $state, false );
        Revisions::record( $c, 'options', 'maintenance', array( $before ) );
        $c->summary = 'maintenance mode ' . ( $state['on'] ? 'on' : 'off' );

        return $state + array( 'note' => 'Visitors get HTTP 503. Signed-in administrators and the bridge still see the site.' );
    }

    /**
     * Read-only SQL: one SELECT/SHOW/DESCRIBE/EXPLAIN. {prefix} is replaced by the table prefix.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_sql( array $a, Context $c ): array {
        global $wpdb;
        $q = rtrim( trim( str_replace( '{prefix}', $wpdb->prefix, (string) $a['query'] ) ), "; \t\n\r" );
        if ( ! preg_match( '/^(select|show|describe|desc|explain)\b/i', $q ) || ! Policy::sql_is_single( $q ) || preg_match( '/\b(into\s+outfile|into\s+dumpfile|load_file)\b/i', $q ) ) {
            throw new BridgeError( 'read_only', 'maintain.sql runs one SELECT/SHOW/DESCRIBE/EXPLAIN. Use maintain.sql_write for changes.', 400 );
        }
        $limit = max( 1, min( 1000, (int) ( $a['limit'] ?? 200 ) ) );
        $rows  = (array) $wpdb->get_results( $q, ARRAY_A ); // phpcs:ignore WordPress.DB
        if ( '' !== $wpdb->last_error ) {
            throw new BridgeError( 'sql_error', $wpdb->last_error, 400 );
        }
        $total = count( $rows );

        return array( 'rows' => array_slice( $rows, 0, $limit ), 'count' => $total, 'truncated' => $total > $limit, 'prefix' => $wpdb->prefix );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_sql_write( array $a, Context $c ): array {
        global $wpdb;

        return array( 'will_run' => str_replace( '{prefix}', $wpdb->prefix, (string) $a['query'] ), 'warning' => 'Changes the database directly and cannot be undone with activity.undo. Take maintain.backup_create first.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_sql_write( array $a, Context $c ): array {
        global $wpdb;
        $q = rtrim( trim( str_replace( '{prefix}', $wpdb->prefix, (string) $a['query'] ) ), "; \t\n\r" );
        if ( '' === $q || ! Policy::sql_is_single( $q ) || ! preg_match( '/^(insert|update|delete|replace|create|alter|drop|truncate)\b/i', $q ) || preg_match( '/\b(into\s+outfile|into\s+dumpfile|load_file)\b/i', $q ) ) {
            throw new BridgeError( 'bad_query', 'One INSERT/UPDATE/DELETE/REPLACE/CREATE/ALTER/DROP/TRUNCATE statement per call.', 400 );
        }
        $res = $wpdb->query( $q ); // phpcs:ignore WordPress.DB
        if ( false === $res || '' !== $wpdb->last_error ) {
            throw new BridgeError( 'sql_error', $wpdb->last_error ?: 'The statement failed.', 400 );
        }
        wp_cache_flush();
        $c->summary = 'sql: ' . substr( $q, 0, 80 );

        return array( 'affected' => (int) $res, 'insert_id' => (int) $wpdb->insert_id );
    }
}
