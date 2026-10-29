<?php
/**
 * Plugin Name:       WP MCP Bridge
 * Description:       Secure, signed API that lets the WP MCP gateway manage this site for AI assistants: content, design, SEO, maintenance, plugins. Levels, confirmations, undo and an activity log built in.
 * Version:           2.1.0
 * Requires at least: 6.2
 * Requires PHP:      8.1
 * Author:            WP MCP
 * License:           MIT
 * Text Domain:       wp-mcp-bridge
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

defined( 'ABSPATH' ) || exit;

define( 'WPMCP_VERSION', '2.1.0' );
define( 'WPMCP_FILE', __FILE__ );
define( 'WPMCP_DIR', __DIR__ . '/' );

spl_autoload_register(
    static function ( string $class ): void {
        $prefix = 'WPMCP\\Bridge\\';
        if ( ! str_starts_with( $class, $prefix ) ) {
            return;
        }
        $file = WPMCP_DIR . 'includes/' . str_replace( '\\', '/', substr( $class, strlen( $prefix ) ) ) . '.php';
        if ( is_file( $file ) ) {
            require_once $file;
        }
    }
);

register_activation_hook( __FILE__, array( \WPMCP\Bridge\Plugin::class, 'activate' ) );
register_deactivation_hook( __FILE__, array( \WPMCP\Bridge\Plugin::class, 'deactivate' ) );

if ( version_compare( PHP_VERSION, '8.1', '<' ) ) {
    add_action(
        'admin_notices',
        static function (): void {
            echo '<div class="notice notice-error"><p>WP MCP Bridge needs PHP 8.1 or newer.</p></div>';
        }
    );
    return;
}

\WPMCP\Bridge\Plugin::boot();
