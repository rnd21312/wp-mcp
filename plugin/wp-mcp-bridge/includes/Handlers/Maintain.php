<?php
/**
 * maintain.* operations: health, updates, backups, logs, caches, database, cron.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\Revisions;

defined( 'ABSPATH' ) || exit;

final class Maintain {

    public static function require_direct_fs(): void {
        require_once ABSPATH . 'wp-admin/includes/file.php';
        if ( 'direct' !== get_filesystem_method() ) {
            throw new BridgeError( 'fs_not_direct', 'WordPress cannot write files directly on this server (it would ask for FTP credentials), so installs and updates cannot run from the bridge.', 409 );
        }
        WP_Filesystem();
    }

    /* ------------------------------------------------------------------ health */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_health( array $a, Context $c ): array {
        global $wpdb;
        require_once ABSPATH . 'wp-admin/includes/update.php';
        require_once ABSPATH . 'wp-admin/includes/class-wp-site-health.php';
        $tests = array();
        try {
            $health = \WP_Site_Health::get_instance();
            foreach ( \WP_Site_Health::get_tests()['direct'] ?? array() as $test ) {
                try {
                    $fn = $test['test'];
                    $r  = is_string( $fn ) && method_exists( $health, 'get_test_' . $fn ) ? $health->{'get_test_' . $fn}() : ( is_callable( $fn ) ? $fn() : null );
                    if ( is_array( $r ) && 'good' !== ( $r['status'] ?? '' ) ) {
                        $tests[] = array( 'test' => wp_specialchars_decode( (string) ( $r['label'] ?? $test['label'] ), ENT_QUOTES ), 'status' => $r['status'], 'detail' => wp_specialchars_decode( wp_trim_words( wp_strip_all_tags( (string) ( $r['description'] ?? '' ) ), 40 ), ENT_QUOTES ) );
                    }
                } catch ( \Throwable $e ) {
                    continue;
                }
            }
        } catch ( \Throwable $e ) {
            $tests[] = array( 'test' => 'Site Health', 'status' => 'unknown', 'detail' => 'Could not run: ' . $e->getMessage() );
        }
        $upd = array(
            'core'    => count( array_filter( (array) get_core_updates(), static fn ( $u ) => 'upgrade' === ( $u->response ?? '' ) ) ),
            'plugins' => count( (array) get_plugin_updates() ),
            'themes'  => count( (array) get_theme_updates() ),
        );

        return array(
            'problems'   => $tests,
            'note'       => array() === $tests ? 'All direct Site Health tests pass.' : 'Only tests that are not "good" are listed.',
            'versions'   => array( 'wordpress' => get_bloginfo( 'version' ), 'php' => PHP_VERSION, 'mysql' => $wpdb->db_version(), 'server' => isset( $_SERVER['SERVER_SOFTWARE'] ) ? sanitize_text_field( wp_unslash( (string) $_SERVER['SERVER_SOFTWARE'] ) ) : '' ),
            'updates_pending' => $upd,
            'runtime'    => array( 'https' => is_ssl(), 'memory_limit' => ini_get( 'memory_limit' ), 'max_execution_time' => ini_get( 'max_execution_time' ), 'upload_max' => size_format( wp_max_upload_size() ), 'disk_free' => size_format( (float) @disk_free_space( ABSPATH ) ), 'wp_debug' => defined( 'WP_DEBUG' ) && WP_DEBUG, 'debug_log' => defined( 'WP_DEBUG_LOG' ) && WP_DEBUG_LOG, 'wp_cron_disabled' => defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON, 'object_cache' => wp_using_ext_object_cache(), 'environment' => wp_get_environment_type() ),
            'search_visibility' => get_option( 'blog_public' ) ? 'visible' : 'hidden',
        );
    }

    /* ----------------------------------------------------------------- updates */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_updates_check( array $a, Context $c ): array {
        require_once ABSPATH . 'wp-admin/includes/update.php';
        if ( ! empty( $a['refresh'] ) ) {
            wp_version_check( array(), true );
            wp_update_plugins();
            wp_update_themes();
        }
        $core = array();
        foreach ( (array) get_core_updates() as $u ) {
            if ( 'upgrade' === ( $u->response ?? '' ) ) {
                $core[] = array( 'version' => $u->current, 'php_required' => $u->php_version ?? null );
            }
        }
        $plugins = array();
        foreach ( (array) get_plugin_updates() as $file => $p ) {
            $plugins[] = array( 'plugin' => $file, 'name' => $p->Name, 'from' => $p->Version, 'to' => $p->update->new_version ?? '?', 'tested_up_to' => $p->update->tested ?? null, 'requires_php' => $p->update->requires_php ?? null );
        }
        $themes = array();
        foreach ( (array) get_theme_updates() as $slug => $t ) {
            $themes[] = array( 'theme' => $slug, 'name' => $t->get( 'Name' ), 'from' => $t->get( 'Version' ), 'to' => $t->update['new_version'] ?? '?' );
        }

        return array( 'current_wordpress' => get_bloginfo( 'version' ), 'core' => $core, 'plugins' => $plugins, 'themes' => $themes, 'checked' => get_site_transient( 'update_plugins' )->last_checked ?? null );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_update( array $a, Context $c ): array {
        $check = self::op_updates_check( array(), $c );
        $type  = (string) $a['type'];
        $slug  = (string) ( $a['slug'] ?? '' );
        $what  = 'core' === $type ? $check['core'] : array_values( array_filter( $check[ $type . 's' ], static fn ( $u ) => ( $u[ $type ] ?? '' ) === $slug ) );

        return array( 'will_update' => $type . ( '' !== $slug ? " $slug" : '' ), 'available' => $what, 'backup_first' => ! isset( $a['backup'] ) || ! empty( $a['backup'] ), 'risk' => 'Updates can break a site. A database backup is taken first; files are not backed up.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_update( array $a, Context $c ): array {
        require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
        require_once ABSPATH . 'wp-admin/includes/update.php';
        require_once ABSPATH . 'wp-admin/includes/misc.php';
        require_once ABSPATH . 'wp-admin/includes/theme.php';
        self::require_direct_fs();
        $type   = (string) $a['type'];
        $slug   = (string) ( $a['slug'] ?? '' );
        $backup = ! isset( $a['backup'] ) || ! empty( $a['backup'] ) ? self::dump_db( 'before update ' . $type . ' ' . $slug ) : null;

        $skin   = new \Automatic_Upgrader_Skin();
        $result = null;
        $from   = null;
        if ( 'core' === $type ) {
            wp_version_check( array(), true );
            $offers = array_values( array_filter( (array) get_core_updates(), static fn ( $u ) => 'upgrade' === ( $u->response ?? '' ) ) );
            if ( ! $offers ) {
                throw new BridgeError( 'no_update', 'WordPress is already up to date.', 400 );
            }
            $from   = get_bloginfo( 'version' );
            $result = ( new \Core_Upgrader( $skin ) )->upgrade( $offers[0] );
        } elseif ( 'plugin' === $type ) {
            if ( '' === $slug || ! isset( get_plugins()[ $slug ] ) ) {
                throw new BridgeError( 'not_found', 'Give slug as the plugin file, e.g. woocommerce/woocommerce.php.', 400 );
            }
            if ( plugin_basename( WPMCP_FILE ) === $slug ) {
                throw new BridgeError( 'protected', 'The bridge does not update itself while it is running. Update it from the WordPress admin.', 400 );
            }
            $from   = get_plugins()[ $slug ]['Version'];
            $active = is_plugin_active( $slug );
            wp_update_plugins();
            $result = ( new \Plugin_Upgrader( $skin ) )->upgrade( $slug );
            if ( $active && ! is_plugin_active( $slug ) ) {
                activate_plugin( $slug, '', false, true );
            }
        } else {
            if ( '' === $slug || ! wp_get_theme( $slug )->exists() ) {
                throw new BridgeError( 'not_found', 'Give slug as the theme directory.', 400 );
            }
            $from   = wp_get_theme( $slug )->get( 'Version' );
            wp_update_themes();
            $result = ( new \Theme_Upgrader( $skin ) )->upgrade( $slug );
        }
        if ( is_wp_error( $result ) ) {
            throw new BridgeError( 'update_failed', $result->get_error_message(), 500, array( 'backup' => $backup['id'] ?? null ) );
        }
        if ( false === $result ) {
            throw new BridgeError( 'update_failed', 'The update did not run (nothing newer, or the files could not be replaced). ' . implode( ' ', array_map( 'wp_strip_all_tags', (array) $skin->get_upgrade_messages() ) ), 500 );
        }
        wp_clean_plugins_cache();
        $c->summary = "updated $type $slug (from $from)" . ( $backup ? ", backup {$backup['id']}" : '' );
        $to         = 'core' === $type ? (string) get_bloginfo( 'version' ) : ( 'plugin' === $type ? (string) ( get_plugins()[ $slug ]['Version'] ?? '?' ) : (string) wp_get_theme( $slug )->get( 'Version' ) );

        return array( 'updated' => $type . ( '' !== $slug ? " $slug" : '' ), 'from' => $from, 'to' => $to, 'backup' => $backup, 'next' => 'Check the front page with inspect.page and the error log with maintain.logs. Not undoable except by restoring the backup (database only).' );
    }

    /* ----------------------------------------------------------------- backups */

    private static function backup_dir(): string {
        $uploads = wp_upload_dir( null, false );
        $dir     = trailingslashit( $uploads['basedir'] ) . 'wpmcp-backups';
        if ( ! is_dir( $dir ) ) {
            wp_mkdir_p( $dir );
            file_put_contents( $dir . '/.htaccess', "Deny from all\n<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n" );
            file_put_contents( $dir . '/index.php', "<?php\n// Silence.\n" );
        }

        return $dir;
    }

    /** @return array<int, string> */
    private static function tables(): array {
        global $wpdb;

        return array_map( 'strval', (array) $wpdb->get_col( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $wpdb->prefix ) . '%' ) ) );
    }

    /**
     * Streams every table of this site to a gzip file, one statement per line.
     *
     * @return array<string, mixed>
     */
    public static function dump_db( string $label ): array {
        global $wpdb;
        @set_time_limit( 300 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        $id   = gmdate( 'Ymd-His' ) . '-' . bin2hex( random_bytes( 4 ) );
        $file = self::backup_dir() . "/db-$id.sql.gz";
        $gz   = gzopen( $file, 'wb6' );
        if ( ! $gz ) {
            throw new BridgeError( 'backup_failed', 'Cannot write the backup file.', 500 );
        }
        gzwrite( $gz, '-- wpmcp-backup v1 prefix=' . $wpdb->prefix . "\n" );
        $tables = self::tables();
        foreach ( $tables as $table ) {
            $create = $wpdb->get_row( 'SHOW CREATE TABLE `' . esc_sql( $table ) . '`', ARRAY_N ); // phpcs:ignore WordPress.DB
            if ( ! $create ) {
                continue;
            }
            gzwrite( $gz, 'DROP TABLE IF EXISTS `' . $table . "`;\n" );
            gzwrite( $gz, str_replace( "\n", ' ', (string) $create[1] ) . ";\n" );
            $offset = 0;
            do {
                $rows = $wpdb->get_results( 'SELECT * FROM `' . esc_sql( $table ) . '` LIMIT 500 OFFSET ' . (int) $offset, ARRAY_A ); // phpcs:ignore WordPress.DB
                if ( ! $rows ) {
                    break;
                }
                $values = array();
                foreach ( $rows as $row ) {
                    $values[] = '(' . implode( ',', array_map( static fn ( $v ) => null === $v ? 'NULL' : "'" . $wpdb->_real_escape( (string) $v ) . "'", $row ) ) . ')';
                }
                gzwrite( $gz, 'INSERT INTO `' . $table . '` VALUES ' . implode( ',', $values ) . ";\n" );
                $offset += 500;
            } while ( count( $rows ) === 500 );
        }
        gzclose( $gz );
        $entry = array( 'file' => basename( $file ), 'created' => time(), 'label' => substr( sanitize_text_field( $label ), 0, 100 ), 'tables' => count( $tables ), 'bytes' => (int) filesize( $file ) );
        $all   = (array) get_option( 'wpm_backups', array() );
        $all[ $id ] = $entry;
        if ( count( $all ) > 15 ) {
            $oldest = array_key_first( $all );
            @unlink( self::backup_dir() . '/' . $all[ $oldest ]['file'] ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
            unset( $all[ $oldest ] );
        }
        update_option( 'wpm_backups', $all, false );

        return array( 'id' => $id ) + $entry;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_backup_create( array $a, Context $c ): array {
        $b          = self::dump_db( (string) ( $a['label'] ?? 'manual' ) );
        $c->summary = "database backup {$b['id']} (" . size_format( (int) $b['bytes'] ) . ')';

        return $b + array( 'note' => 'Database only. Files (uploads, themes, plugins) are not included; use your host or a file-backup plugin for those.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_backup_list( array $a, Context $c ): array {
        $out = array();
        foreach ( array_reverse( (array) get_option( 'wpm_backups', array() ), true ) as $id => $b ) {
            $out[] = array( 'id' => $id, 'label' => $b['label'], 'created' => gmdate( 'c', (int) $b['created'] ), 'size' => size_format( (int) $b['bytes'] ), 'tables' => $b['tables'], 'exists' => is_file( self::backup_dir() . '/' . $b['file'] ) );
        }

        return array( 'backups' => $out );
    }

    /** @return array<string, mixed> */
    private static function backup_entry( string $id ): array {
        $all = (array) get_option( 'wpm_backups', array() );
        if ( ! isset( $all[ $id ] ) || ! is_file( self::backup_dir() . '/' . $all[ $id ]['file'] ) ) {
            throw new BridgeError( 'not_found', 'No such backup.', 404 );
        }

        return $all[ $id ];
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_backup_restore( array $a, Context $c ): array {
        $b = self::backup_entry( (string) $a['id'] );

        return array( 'will_restore' => $a['id'], 'label' => $b['label'], 'created' => gmdate( 'c', (int) $b['created'] ), 'effect' => 'All database tables of this site are replaced by the backup. Content and settings changed since then are lost. A safety backup of the current state is taken first.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_backup_restore( array $a, Context $c ): array {
        global $wpdb;
        $b      = self::backup_entry( (string) $a['id'] );
        $safety = self::dump_db( 'safety backup before restoring ' . $a['id'] );
        @set_time_limit( 300 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        $gz = gzopen( self::backup_dir() . '/' . $b['file'], 'rb' );
        if ( ! $gz ) {
            throw new BridgeError( 'restore_failed', 'Cannot read the backup.', 500 );
        }
        $header = trim( (string) gzgets( $gz ) );
        if ( '-- wpmcp-backup v1 prefix=' . $wpdb->prefix !== $header ) {
            gzclose( $gz );
            throw new BridgeError( 'restore_failed', 'This backup belongs to a different table prefix.', 400 );
        }
        $wpdb->query( 'SET FOREIGN_KEY_CHECKS=0' );
        $ran = 0;
        while ( ! gzeof( $gz ) ) {
            $line = trim( (string) gzgets( $gz, 4194304 ) );
            if ( '' === $line ) {
                continue;
            }
            if ( ! preg_match( '/^(DROP TABLE IF EXISTS|CREATE TABLE|INSERT INTO) `' . preg_quote( $wpdb->prefix, '/' ) . '[A-Za-z0-9_$]*`/', $line ) ) {
                gzclose( $gz );
                throw new BridgeError( 'restore_failed', 'The backup contains a statement the bridge does not accept. Stopped; a safety backup was made: ' . $safety['id'], 500 );
            }
            $wpdb->query( $line ); // phpcs:ignore WordPress.DB
            ++$ran;
        }
        gzclose( $gz );
        $wpdb->query( 'SET FOREIGN_KEY_CHECKS=1' );
        wp_cache_flush();
        // Keep the registry of backups: the restored options row may predate them.
        $all = (array) get_option( 'wpm_backups', array() );
        $all[ (string) $a['id'] ]       = $b;
        $all[ (string) $safety['id'] ]  = array_diff_key( $safety, array( 'id' => 1 ) );
        update_option( 'wpm_backups', $all, false );
        $c->summary = "restored backup {$a['id']}";

        return array( 'restored' => $a['id'], 'statements' => $ran, 'safety_backup' => $safety['id'], 'note' => 'You may need to sign in again.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_backup_delete( array $a, Context $c ): array {
        $b = self::backup_entry( (string) $a['id'] );
        @unlink( self::backup_dir() . '/' . $b['file'] ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        $all = (array) get_option( 'wpm_backups', array() );
        unset( $all[ (string) $a['id'] ] );
        update_option( 'wpm_backups', $all, false );
        $c->summary = "deleted backup {$a['id']}";

        return array( 'deleted' => $a['id'] );
    }

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
}
