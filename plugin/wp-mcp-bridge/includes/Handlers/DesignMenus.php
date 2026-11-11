<?php
/**
 * Part of Design: menus, home page and branding.
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

trait DesignMenus {

    /* ------------------------------------------------------------------- menus */

    /** @return array<int, array<string, mixed>> */
    public static function tree( int $menu_id ): array {
        $items = wp_get_nav_menu_items( $menu_id ) ?: array();
        $nodes = array();
        foreach ( $items as $i ) {
            $nodes[ (int) $i->ID ] = array( 'id' => (int) $i->ID, 'title' => $i->title, 'url' => $i->url, 'object' => $i->object, 'object_id' => (int) $i->object_id, 'type' => $i->type, 'parent' => (int) $i->menu_item_parent, 'children' => array() );
        }
        $root = array();
        foreach ( $nodes as $id => &$n ) {
            if ( $n['parent'] && isset( $nodes[ $n['parent'] ] ) ) {
                $nodes[ $n['parent'] ]['children'][] = &$n;
            } else {
                $root[] = &$n;
            }
        }
        unset( $n );

        return json_decode( (string) wp_json_encode( $root ), true ) ?: array();
    }

    private static function menu_obj( $ref ): ?\WP_Term {
        $menu = wp_get_nav_menu_object( is_numeric( $ref ) ? (int) $ref : (string) $ref );

        return $menu instanceof \WP_Term ? $menu : null;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_menus_list( array $a, Context $c ): array {
        $locations = get_nav_menu_locations();
        $menus     = array();
        foreach ( wp_get_nav_menus() as $m ) {
            $menus[] = array( 'id' => $m->term_id, 'name' => $m->name, 'slug' => $m->slug, 'items' => (int) $m->count, 'locations' => array_keys( array_filter( $locations, static fn ( $id ) => (int) $id === (int) $m->term_id ) ) );
        }

        return array( 'menus' => $menus, 'locations' => get_registered_nav_menus() );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_menu_get( array $a, Context $c ): array {
        $m = self::menu_obj( $a['menu'] );
        if ( ! $m ) {
            throw new BridgeError( 'not_found', 'No such menu.', 404 );
        }

        return array( 'id' => $m->term_id, 'name' => $m->name, 'items' => self::tree( $m->term_id ) );
    }

    /**
     * @param array<int, mixed> $items Tree.
     */
    private static function add_items( int $menu_id, array $items, int $parent = 0 ): int {
        $count = 0;
        foreach ( $items as $pos => $item ) {
            $item = (array) $item;
            $args = array( 'menu-item-title' => sanitize_text_field( (string) ( $item['title'] ?? '' ) ), 'menu-item-status' => 'publish', 'menu-item-parent-id' => $parent, 'menu-item-position' => $pos + 1 );
            if ( ! empty( $item['object'] ) && ! empty( $item['object_id'] ) ) {
                $object = sanitize_key( (string) $item['object'] );
                $is_tax = taxonomy_exists( $object );
                $args  += array( 'menu-item-type' => $is_tax ? 'taxonomy' : 'post_type', 'menu-item-object' => $object, 'menu-item-object-id' => (int) $item['object_id'] );
            } else {
                $url = (string) ( $item['url'] ?? '#' );
                $args += array( 'menu-item-type' => 'custom', 'menu-item-url' => str_starts_with( $url, '/' ) ? home_url( $url ) : esc_url_raw( $url ) );
            }
            $id = wp_update_nav_menu_item( $menu_id, 0, $args );
            if ( is_wp_error( $id ) ) {
                throw new BridgeError( 'menu_item_failed', $id->get_error_message(), 400 );
            }
            ++$count;
            if ( ! empty( $item['children'] ) ) {
                $count += self::add_items( $menu_id, (array) $item['children'], (int) $id );
            }
        }

        return $count;
    }

    /**
     * @param array<int, mixed> $items Tree.
     * @param array<int, string> $locations Theme locations.
     * @return array<string, mixed>
     */
    public static function build_menu( string $name, array $items, array $locations ): array {
        $menu = self::menu_obj( $name );
        if ( $menu ) {
            foreach ( wp_get_nav_menu_items( $menu->term_id ) ?: array() as $old ) {
                wp_delete_post( (int) $old->ID, true );
            }
            $menu_id = $menu->term_id;
        } else {
            $menu_id = wp_create_nav_menu( $name );
            if ( is_wp_error( $menu_id ) ) {
                throw new BridgeError( 'menu_failed', $menu_id->get_error_message(), 400 );
            }
        }
        $count = self::add_items( (int) $menu_id, $items );
        if ( $locations ) {
            $registered = get_registered_nav_menus();
            $current    = get_theme_mod( 'nav_menu_locations', array() );
            foreach ( $locations as $location ) {
                if ( isset( $registered[ $location ] ) ) {
                    $current[ $location ] = (int) $menu_id;
                }
            }
            set_theme_mod( 'nav_menu_locations', $current );
        }

        return array( 'id' => (int) $menu_id, 'items' => $count );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_menu_save( array $a, Context $c ): array {
        $name   = sanitize_text_field( (string) $a['name'] );
        $old    = self::menu_obj( $name );
        $before = $old ? array( 'name' => $old->name, 'items' => self::tree( $old->term_id ), 'locations' => array_keys( array_filter( get_nav_menu_locations(), static fn ( $id ) => (int) $id === (int) $old->term_id ) ) ) : null;
        $result = self::build_menu( $name, (array) $a['items'], array_map( 'strval', (array) ( $a['locations'] ?? array() ) ) );
        Revisions::record( $c, 'menu', (string) $result['id'], $before );
        $c->summary = "saved menu \"$name\" ({$result['items']} items)";

        return $result + array( 'name' => $name );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_menu_delete( array $a, Context $c ): array {
        $m = self::menu_obj( $a['menu'] );
        if ( ! $m ) {
            throw new BridgeError( 'not_found', 'No such menu.', 404 );
        }

        return array( 'will_delete' => $m->name, 'items' => (int) $m->count, 'undo' => 'possible' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_menu_delete( array $a, Context $c ): array {
        $m = self::menu_obj( $a['menu'] );
        if ( ! $m ) {
            throw new BridgeError( 'not_found', 'No such menu.', 404 );
        }
        $before = array( 'name' => $m->name, 'items' => self::tree( $m->term_id ), 'locations' => array_keys( array_filter( get_nav_menu_locations(), static fn ( $id ) => (int) $id === (int) $m->term_id ) ) );
        wp_delete_nav_menu( $m->term_id );
        Revisions::record( $c, 'menu', (string) $m->term_id, $before );
        $c->summary = "deleted menu \"{$m->name}\"";

        return array( 'deleted' => $m->name );
    }

    /**
     * @param mixed $before Snapshot or null.
     */
    public static function restore_menu( string $target, $before ): string {
        if ( null === $before ) {
            $menu = self::menu_obj( (int) $target );
            if ( $menu ) {
                wp_delete_nav_menu( $menu->term_id );
            }

            return 'The menu that was created is deleted.';
        }
        $before = (array) $before;
        self::build_menu( (string) $before['name'], (array) ( $before['items'] ?? array() ), (array) ( $before['locations'] ?? array() ) );

        return 'Menu restored from the snapshot.';
    }

    /* ---------------------------------------------------------- homepage/brand */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_homepage_set( array $a, Context $c ): array {
        $keys   = array( 'show_on_front', 'page_on_front', 'page_for_posts' );
        $before = array_map( array( Revisions::class, 'snap_option' ), $keys );
        if ( isset( $a['show_on_front'] ) ) {
            update_option( 'show_on_front', 'page' === $a['show_on_front'] ? 'page' : 'posts' );
        }
        foreach ( array( 'front_page_id' => 'page_on_front', 'posts_page_id' => 'page_for_posts' ) as $arg => $option ) {
            if ( isset( $a[ $arg ] ) ) {
                $page = get_post( (int) $a[ $arg ] );
                if ( (int) $a[ $arg ] && ( ! $page || 'page' !== $page->post_type || 'publish' !== $page->post_status ) ) {
                    throw new BridgeError( 'bad_page', "$arg must be a published page.", 400 );
                }
                update_option( $option, (int) $a[ $arg ] );
            }
        }
        Revisions::record( $c, 'options', 'homepage', $before );
        $c->summary = 'homepage settings changed';

        return array( 'show_on_front' => get_option( 'show_on_front' ), 'front_page_id' => (int) get_option( 'page_on_front' ), 'posts_page_id' => (int) get_option( 'page_for_posts' ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_branding_set( array $a, Context $c ): array {
        $mods   = 'theme_mods_' . get_option( 'stylesheet' );
        $before = array_map( array( Revisions::class, 'snap_option' ), array( 'blogname', 'blogdescription', 'site_icon', 'site_logo', $mods ) );
        foreach ( array( 'title' => 'blogname', 'tagline' => 'blogdescription' ) as $arg => $option ) {
            if ( isset( $a[ $arg ] ) ) {
                update_option( $option, sanitize_text_field( (string) $a[ $arg ] ) );
            }
        }
        foreach ( array( 'logo_id', 'icon_id' ) as $arg ) {
            if ( isset( $a[ $arg ] ) && (int) $a[ $arg ] && 'attachment' !== get_post_type( (int) $a[ $arg ] ) ) {
                throw new BridgeError( 'bad_media', "$arg must be a media library item.", 400 );
            }
        }
        if ( isset( $a['logo_id'] ) ) {
            set_theme_mod( 'custom_logo', (int) $a['logo_id'] );
            update_option( 'site_logo', (int) $a['logo_id'] );
        }
        if ( isset( $a['icon_id'] ) ) {
            update_option( 'site_icon', (int) $a['icon_id'] );
        }
        Revisions::record( $c, 'options', 'branding', $before );
        $c->summary = 'branding changed';

        return array( 'title' => get_option( 'blogname' ), 'tagline' => get_option( 'blogdescription' ), 'logo_id' => (int) get_theme_mod( 'custom_logo' ), 'icon_id' => (int) get_option( 'site_icon' ) );
    }
}
