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
use WPMCP\Bridge\PhpGuard;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Revisions;
use WPMCP\Bridge\Util;

defined( 'ABSPATH' ) || exit;

final class Maintain {

    use MaintainBackups, MaintainOps, MaintainDatabase, MaintainConfig;

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
                // Only a newer release signed by the release key; every class is loaded first so the swap cannot mix versions.
                if ( ! \WPMCP\Bridge\Updater::offered( true ) ) {
                    throw new BridgeError( 'no_update', 'No newer signed bridge release is published (or this bridge has no release key). Upload the new zip from the WordPress admin instead.', 400 );
                }
                \WPMCP\Bridge\Updater::preload();
                set_site_transient( 'update_plugins', \WPMCP\Bridge\Updater::inject( get_site_transient( 'update_plugins' ) ?: new \stdClass() ) );
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
        if ( ! $result ) { // A failed download step makes upgrade() return an empty array, not false.
            throw new BridgeError( 'update_failed', 'The update did not run (nothing newer, or the files could not be replaced). ' . implode( ' ', array_map( 'wp_strip_all_tags', (array) $skin->get_upgrade_messages() ) ), 500 );
        }
        wp_clean_plugins_cache();
        $c->summary = "updated $type $slug (from $from)" . ( $backup ? ", backup {$backup['id']}" : '' );
        $to         = 'core' === $type ? (string) get_bloginfo( 'version' ) : ( 'plugin' === $type ? (string) ( get_plugins()[ $slug ]['Version'] ?? '?' ) : (string) wp_get_theme( $slug )->get( 'Version' ) );

        return array( 'updated' => $type . ( '' !== $slug ? " $slug" : '' ), 'from' => $from, 'to' => $to, 'backup' => $backup, 'next' => 'Check the front page with inspect.page and the error log with maintain.logs. Not undoable except by restoring the backup (database only).' );
    }

    private const CONFIG_COMMON = array( 'WP_DEBUG', 'WP_DEBUG_LOG', 'WP_DEBUG_DISPLAY', 'SCRIPT_DEBUG', 'WP_MEMORY_LIMIT', 'WP_MAX_MEMORY_LIMIT', 'WP_CACHE', 'WP_POST_REVISIONS', 'AUTOSAVE_INTERVAL', 'EMPTY_TRASH_DAYS', 'DISALLOW_FILE_EDIT', 'DISALLOW_FILE_MODS', 'DISABLE_WP_CRON', 'WP_AUTO_UPDATE_CORE', 'WP_ENVIRONMENT_TYPE', 'FORCE_SSL_ADMIN', 'WP_HOME', 'WP_SITEURL' );

}
