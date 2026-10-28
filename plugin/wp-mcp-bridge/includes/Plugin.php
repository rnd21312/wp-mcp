<?php
/**
 * Bootstrap: routes, front-end features, admin page, schedules.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class Plugin {

    public static function boot(): void {
        add_action( 'rest_api_init', array( Api::class, 'routes' ) );
        add_action( 'wpm_bridge_daily', array( self::class, 'daily' ) );
        add_action( 'init', array( self::class, 'maybe_upgrade' ) );
        Frontend::init();
        Optimizer::init();
        if ( is_admin() ) {
            Admin::init();
        }
    }

    public static function activate(): void {
        Activity::install();
        Revisions::install();
        update_option( 'wpm_bridge_db', WPMCP_VERSION, false );
        if ( ! wp_next_scheduled( 'wpm_bridge_daily' ) ) {
            wp_schedule_event( time() + 3600, 'daily', 'wpm_bridge_daily' );
        }
    }

    public static function deactivate(): void {
        wp_clear_scheduled_hook( 'wpm_bridge_daily' );
    }

    public static function maybe_upgrade(): void {
        if ( get_option( 'wpm_bridge_db' ) !== WPMCP_VERSION ) {
            self::activate();
        }
    }

    public static function daily(): void {
        Activity::prune();
        Revisions::prune();
    }
}
