<?php
/**
 * plugins.* operations.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Revisions;
use WPMCP\Bridge\Util;

defined( 'ABSPATH' ) || exit;

final class PluginOps {

    private static function load(): void {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
        require_once ABSPATH . 'wp-admin/includes/plugin-install.php';
        require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/misc.php';
    }

    private static function known( string $file ): array {
        self::load();
        $all = get_plugins();
        if ( ! isset( $all[ $file ] ) ) {
            throw new BridgeError( 'not_found', "No plugin file \"$file\". Use plugins.list for the exact value (dir/file.php).", 404 );
        }

        return $all[ $file ];
    }

    private static function not_self( string $file ): void {
        if ( plugin_basename( WPMCP_FILE ) === $file ) {
            throw new BridgeError( 'protected', 'The bridge cannot change itself; do that from the WordPress admin.', 400 );
        }
    }

    /** @return array<int, string> */
    private static function snapshot(): array {
        return array_values( (array) get_option( 'active_plugins', array() ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_list( array $a, Context $c ): array {
        self::load();
        $status  = (string) ( $a['status'] ?? 'all' );
        $updates = (array) ( get_site_transient( 'update_plugins' )->response ?? array() );
        $out     = array();
        foreach ( get_plugins() as $file => $p ) {
            $active = is_plugin_active( $file );
            if ( ( 'active' === $status && ! $active ) || ( 'inactive' === $status && $active ) || ( 'update' === $status && ! isset( $updates[ $file ] ) ) ) {
                continue;
            }
            $out[] = array( 'plugin' => $file, 'name' => $p['Name'], 'version' => $p['Version'], 'active' => $active, 'update' => isset( $updates[ $file ] ) ? $updates[ $file ]->new_version : null, 'author' => wp_strip_all_tags( $p['Author'] ), 'description' => wp_trim_words( wp_strip_all_tags( $p['Description'] ), 18 ) );
        }

        return array( 'plugins' => $out, 'total' => count( $out ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_search( array $a, Context $c ): array {
        self::load();
        $res = plugins_api( 'query_plugins', array( 'search' => sanitize_text_field( (string) $a['query'] ), 'per_page' => max( 1, min( 20, (int) ( $a['per_page'] ?? 10 ) ) ), 'fields' => array( 'short_description' => true, 'icons' => false, 'banners' => false, 'sections' => false ) ) );
        if ( is_wp_error( $res ) ) {
            throw new BridgeError( 'search_failed', $res->get_error_message(), 502 );
        }

        return array( 'results' => array_map( static fn ( $p ) => array( 'slug' => $p->slug, 'name' => $p->name, 'version' => $p->version, 'rating' => $p->rating, 'active_installs' => $p->active_installs, 'tested_up_to' => $p->tested ?? null, 'description' => $p->short_description ?? '' ), array_slice( (array) $res->plugins, 0, 20 ) ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_install( array $a, Context $c ): array {
        self::load();
        $slug = sanitize_key( (string) $a['slug'] );
        $info = plugins_api( 'plugin_information', array( 'slug' => $slug, 'fields' => array( 'sections' => false ) ) );
        if ( is_wp_error( $info ) ) {
            throw new BridgeError( 'not_found', "WordPress.org has no plugin \"$slug\".", 404 );
        }

        return array( 'will_install' => $info->name, 'slug' => $slug, 'version' => $info->version, 'active_installs' => $info->active_installs, 'tested_up_to' => $info->tested ?? null, 'requires_php' => $info->requires_php ?? null, 'last_updated' => $info->last_updated ?? null, 'activate_after' => ! empty( $a['activate'] ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_install( array $a, Context $c ): array {
        self::load();
        $slug = sanitize_key( (string) $a['slug'] );
        $info = plugins_api( 'plugin_information', array( 'slug' => $slug, 'fields' => array( 'sections' => false ) ) );
        if ( is_wp_error( $info ) ) {
            throw new BridgeError( 'not_found', "WordPress.org has no plugin \"$slug\".", 404 );
        }
        Maintain::require_direct_fs();
        $upgrader = new \Plugin_Upgrader( new \Automatic_Upgrader_Skin() );
        $result   = $upgrader->install( $info->download_link );

        return self::finish_install( $upgrader, $result, ! empty( $a['activate'] ), $c, $info->name );
    }

    /**
     * @param mixed $result Upgrader result.
     * @return array<string, mixed>
     */
    private static function finish_install( \Plugin_Upgrader $upgrader, $result, bool $activate, Context $c, string $name ): array {
        if ( is_wp_error( $result ) || ! $result ) {
            throw new BridgeError( 'install_failed', is_wp_error( $result ) ? $result->get_error_message() : 'Installation failed.', 500 );
        }
        $file   = (string) $upgrader->plugin_info();
        $active = false;
        $note   = null;
        if ( $activate && '' !== $file ) {
            $before = self::snapshot();
            $act    = activate_plugin( $file, '', false, true );
            if ( is_wp_error( $act ) ) {
                $note = 'Installed but not activated: ' . $act->get_error_message();
            } else {
                $active = true;
                Revisions::record( $c, 'plugins', $file, array( 'active' => $before ) );
            }
        }
        $c->summary = "installed plugin $name ($file)" . ( $active ? ' and activated' : '' );

        return array( 'installed' => $file, 'name' => $name, 'active' => $active, 'note' => $note );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_install_zip( array $a, Context $c ): array {
        $problem = Policy::url_problem( (string) $a['url'] );

        return array( 'will_download' => (string) $a['url'], 'host' => wp_parse_url( (string) $a['url'], PHP_URL_HOST ), 'allowed' => null === $problem, 'problem' => $problem, 'warning' => 'A plugin runs PHP code with full access to this site. Only install from a source the person trusts.', 'rules' => 'https only, redirects re-checked, no private addresses, max 40 MB' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_install_zip( array $a, Context $c ): array {
        self::load();
        $url = (string) $a['url'];
        if ( null !== ( $problem = Policy::url_problem( $url ) ) ) {
            throw new BridgeError( 'blocked_url', $problem, 400 );
        }
        Maintain::require_direct_fs();
        $tmp = wp_tempnam( 'wpm-plugin.zip' );
        try {
            Util::download( $url, 41943040, $tmp );
        } catch ( BridgeError $e ) {
            @unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
            throw $e;
        }
        $head = (string) file_get_contents( $tmp, false, null, 0, 4 );
        if ( "PK\x03\x04" !== $head ) {
            @unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
            throw new BridgeError( 'not_zip', 'The download is not a zip file.', 400 );
        }
        $upgrader = new \Plugin_Upgrader( new \Automatic_Upgrader_Skin() );
        $result   = $upgrader->install( $tmp );
        @unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors

        return self::finish_install( $upgrader, $result, ! empty( $a['activate'] ), $c, basename( (string) wp_parse_url( $url, PHP_URL_PATH ) ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_activate( array $a, Context $c ): array {
        $file = (string) $a['plugin'];
        self::known( $file );
        $before = self::snapshot();
        $res    = activate_plugin( $file, '', false, true );
        if ( is_wp_error( $res ) ) {
            throw new BridgeError( 'activate_failed', $res->get_error_message(), 500 );
        }
        Revisions::record( $c, 'plugins', $file, array( 'active' => $before ) );
        $c->summary = "activated $file";

        return array( 'activated' => $file );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_deactivate( array $a, Context $c ): array {
        $file = (string) $a['plugin'];
        self::known( $file );
        self::not_self( $file );
        $before = self::snapshot();
        deactivate_plugins( $file, true );
        Revisions::record( $c, 'plugins', $file, array( 'active' => $before ) );
        $c->summary = "deactivated $file";

        return array( 'deactivated' => $file );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_delete( array $a, Context $c ): array {
        $file = (string) $a['plugin'];
        $p    = self::known( $file );

        return array( 'will_delete' => $p['Name'], 'version' => $p['Version'], 'active' => is_plugin_active( $file ), 'blocked_because_active' => is_plugin_active( $file ), 'permanent' => true, 'undo' => 'not possible (files and, for some plugins, their data are removed)' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_delete( array $a, Context $c ): array {
        $file = (string) $a['plugin'];
        $p    = self::known( $file );
        self::not_self( $file );
        if ( is_plugin_active( $file ) ) {
            throw new BridgeError( 'active', 'Deactivate the plugin first (plugins.deactivate).', 409 );
        }
        Maintain::require_direct_fs();
        $res = delete_plugins( array( $file ) );
        if ( is_wp_error( $res ) ) {
            throw new BridgeError( 'delete_failed', $res->get_error_message(), 500 );
        }
        $c->summary = "deleted plugin {$p['Name']} ($file)";

        return array( 'deleted' => $file, 'name' => $p['Name'] );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_settings_find( array $a, Context $c ): array {
        global $wpdb;
        $slug  = sanitize_key( str_replace( '-', '_', (string) $a['slug'] ) );
        $names = (array) $wpdb->get_results( $wpdb->prepare( "SELECT option_name AS name, LENGTH(option_value) AS bytes FROM {$wpdb->options} WHERE option_name LIKE %s AND option_name NOT LIKE %s AND option_name NOT LIKE %s ORDER BY option_name LIMIT 100", '%' . $wpdb->esc_like( $slug ) . '%', '\\_transient\\_%', '\\_site\\_transient\\_%' ), ARRAY_A ); // phpcs:ignore WordPress.DB
        $out   = array_map( static fn ( $r ) => array( 'option' => $r['name'], 'bytes' => (int) $r['bytes'], 'readable' => 'secret' !== Policy::option_tier( (string) $r['name'] ) ), $names );

        return array( 'options' => $out, 'hint' => 'Read values with options.get (secret-looking options are hidden). Many plugins also expose settings under rest.routes.' );
    }
}
