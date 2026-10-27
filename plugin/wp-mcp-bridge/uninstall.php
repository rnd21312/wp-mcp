<?php
/**
 * Removes the bridge's connections, tables and options. Content the AI created stays.
 *
 * @package WPMCP\Bridge
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

global $wpdb;
foreach ( array( 'wpm_bridge_connections', 'wpm_bridge_pairing', 'wpm_bridge_db', 'wpm_tokens', 'wpm_css_sections', 'wpm_redirects', 'wpm_robots_txt', 'wpm_seo_site', 'wpm_sitemap', 'wpm_maintenance', 'wpm_backups' ) as $option ) {
    delete_option( $option );
}
$wpdb->query( 'DROP TABLE IF EXISTS ' . $wpdb->prefix . 'wpm_activity' ); // phpcs:ignore WordPress.DB
$wpdb->query( 'DROP TABLE IF EXISTS ' . $wpdb->prefix . 'wpm_revisions' ); // phpcs:ignore WordPress.DB
