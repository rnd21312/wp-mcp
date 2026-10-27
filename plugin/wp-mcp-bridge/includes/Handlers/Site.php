<?php
/**
 * site.* operations.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\Context;
use WPMCP\Bridge\Spec;

defined( 'ABSPATH' ) || exit;

final class Site {

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_overview( array $a, Context $c ): array {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
        $theme  = wp_get_theme();
        $active = array();
        $all    = get_plugins();
        foreach ( (array) get_option( 'active_plugins', array() ) as $file ) {
            $active[] = $all[ $file ]['Name'] ?? $file;
        }
        $types = array();
        foreach ( get_post_types( array( 'public' => true ), 'objects' ) as $obj ) {
            if ( 'attachment' === $obj->name ) {
                continue;
            }
            $counts  = wp_count_posts( $obj->name );
            $types[] = array( 'name' => $obj->name, 'label' => $obj->label, 'published' => (int) ( $counts->publish ?? 0 ), 'hierarchical' => (bool) $obj->hierarchical );
        }
        $taxes = array();
        foreach ( get_taxonomies( array( 'public' => true ), 'objects' ) as $tax ) {
            $taxes[] = array( 'name' => $tax->name, 'label' => $tax->label, 'types' => array_values( $tax->object_type ) );
        }
        $menus = array();
        foreach ( wp_get_nav_menus() as $menu ) {
            $menus[] = $menu->name;
        }
        $ops = 0;
        foreach ( Spec::all() as $op ) {
            if ( \WPMCP\Bridge\Levels::at_least( $c->level, (string) $op['level'] ) ) {
                ++$ops;
            }
        }

        return array(
            'name'        => get_bloginfo( 'name' ),
            'tagline'     => get_bloginfo( 'description' ),
            'url'         => home_url(),
            'language'    => get_locale(),
            'timezone'    => wp_timezone_string(),
            'wordpress'   => get_bloginfo( 'version' ),
            'theme'       => array( 'name' => $theme->get( 'Name' ), 'slug' => $theme->get_stylesheet(), 'block_theme' => function_exists( 'wp_is_block_theme' ) && wp_is_block_theme(), 'child_of' => $theme->parent() ? $theme->parent()->get_stylesheet() : null ),
            'plugins'     => $active,
            'content'     => array( 'types' => $types, 'taxonomies' => $taxes ),
            'menus'       => $menus,
            'menu_locations' => array_keys( get_registered_nav_menus() ),
            'front_page'  => array( 'show_on_front' => get_option( 'show_on_front' ), 'front_page_id' => (int) get_option( 'page_on_front' ), 'posts_page_id' => (int) get_option( 'page_for_posts' ) ),
            'permalinks'  => (string) get_option( 'permalink_structure' ),
            'seo_plugin'  => Seo::provider(),
            'woocommerce' => class_exists( 'WooCommerce' ),
            'forms'       => Forms::providers(),
            'search_visibility' => get_option( 'blog_public' ) ? 'visible' : 'hidden from search engines',
            'maintenance_mode'  => ! empty( ( (array) get_option( 'wpm_maintenance', array() ) )['on'] ),
            'multisite'   => is_multisite(),
            'bridge'      => array( 'version' => WPMCP_VERSION, 'your_level_here' => $c->level, 'actions_available' => $ops ),
        );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_ping( array $a, Context $c ): array {
        return array( 'ok' => true, 'wp_version' => get_bloginfo( 'version' ), 'plugin_version' => WPMCP_VERSION, 'php_version' => PHP_VERSION, 'title' => get_bloginfo( 'name' ), 'time_utc' => gmdate( 'c' ), 'level_here' => $c->level );
    }
}
