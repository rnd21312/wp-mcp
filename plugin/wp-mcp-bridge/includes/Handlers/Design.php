<?php
/**
 * design.* operations: tokens, CSS sections, templates, menus, branding, themes and theme files.
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

final class Design {

    /* ------------------------------------------------------------------ tokens */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_tokens_get( array $a, Context $c ): array {
        $out = array( 'site_tokens' => get_option( 'wpm_tokens', array() ), 'css_variables' => \WPMCP\Bridge\Frontend::css_vars() );
        if ( function_exists( 'wp_get_global_settings' ) ) {
            $out['theme'] = array(
                'colors'     => array_map( static fn ( $p ) => array( 'slug' => $p['slug'] ?? '', 'color' => $p['color'] ?? '' ), (array) ( wp_get_global_settings( array( 'color', 'palette', 'theme' ) ) ?: array() ) ),
                'font_families' => array_map( static fn ( $f ) => array( 'slug' => $f['slug'] ?? '', 'family' => $f['fontFamily'] ?? '' ), (array) ( wp_get_global_settings( array( 'typography', 'fontFamilies', 'theme' ) ) ?: array() ) ),
                'font_sizes' => array_map( static fn ( $f ) => array( 'slug' => $f['slug'] ?? '', 'size' => $f['size'] ?? '' ), (array) ( wp_get_global_settings( array( 'typography', 'fontSizes', 'theme' ) ) ?: array() ) ),
                'layout'     => wp_get_global_settings( array( 'layout' ) ),
            );
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_tokens_set( array $a, Context $c ): array {
        $before  = Revisions::snap_option( 'wpm_tokens' );
        $tokens  = (array) get_option( 'wpm_tokens', array() );
        $changed = 0;
        foreach ( array( 'colors', 'fonts', 'font_sizes', 'spacing' ) as $group ) {
            foreach ( (array) ( $a[ $group ] ?? array() ) as $slug => $value ) {
                $slug = sanitize_key( (string) $slug );
                $text = trim( (string) $value );
                if ( '' === $slug || strlen( $text ) > 200 || preg_match( '/[;{}<>\\\\]/', $text ) ) {
                    throw new BridgeError( 'bad_token', "Invalid token \"$group.$slug\": no ; { } < > or backslash, max 200 characters.", 400 );
                }
                if ( '' === $text ) {
                    unset( $tokens[ $group ][ $slug ] );
                } else {
                    $tokens[ $group ][ $slug ] = $text;
                }
                ++$changed;
            }
        }
        foreach ( array( 'radius', 'content_width' ) as $single ) {
            if ( isset( $a[ $single ] ) ) {
                $text = trim( (string) $a[ $single ] );
                if ( strlen( $text ) > 60 || preg_match( '/[;{}<>\\\\]/', $text ) ) {
                    throw new BridgeError( 'bad_token', "Invalid $single.", 400 );
                }
                $tokens[ $single ] = $text;
                ++$changed;
            }
        }
        update_option( 'wpm_tokens', $tokens, false );
        Revisions::record( $c, 'options', 'wpm_tokens', array( $before ) );
        $c->summary = "design tokens updated ($changed values)";

        return array( 'tokens' => $tokens, 'css_variables' => \WPMCP\Bridge\Frontend::css_vars(), 'usage' => 'Use var(--wpm-color-<slug>), var(--wpm-font-<slug>), var(--wpm-size-<slug>), var(--wpm-space-<slug>), var(--wpm-radius), var(--wpm-content-width).' );
    }

    /* --------------------------------------------------------------------- CSS */

    private static function css_problem( string $css ): ?string {
        if ( strlen( $css ) > 200000 ) {
            return 'CSS is larger than 200 KB.';
        }
        if ( preg_match( '#</?\s*(style|script)#i', $css ) ) {
            return 'Remove <style>/<script> tags; send plain CSS only.';
        }
        if ( preg_match( '/javascript:|expression\s*\(|behavior\s*:|-moz-binding/i', $css ) ) {
            return 'This CSS contains a script-capable construct.';
        }
        if ( preg_match_all( '/@import\s+(?:url\()?\s*[\'"]?([^\'")\s;]+)/i', $css, $m ) ) {
            foreach ( $m[1] as $url ) {
                if ( ! preg_match( '#^https://fonts\.googleapis\.com/#i', $url ) ) {
                    return '@import is only allowed for fonts.googleapis.com.';
                }
            }
        }

        return null;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_css_get( array $a, Context $c ): array {
        $sections = (array) get_option( 'wpm_css_sections', array() );
        if ( ! empty( $a['section'] ) ) {
            $name = sanitize_key( (string) $a['section'] );

            return array( 'section' => $name, 'css' => $sections[ $name ] ?? null );
        }

        return array( 'sections' => $sections, 'theme_additional_css' => function_exists( 'wp_get_custom_css' ) ? wp_get_custom_css() : '', 'note' => 'Sections are printed in the page head in this order. Theme additional CSS is read-only here.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_css_set( array $a, Context $c ): array {
        $css = (string) $a['css'];
        if ( null !== ( $problem = self::css_problem( $css ) ) ) {
            throw new BridgeError( 'bad_css', $problem, 400 );
        }
        $name = sanitize_key( (string) ( $a['section'] ?? 'main' ) ) ?: 'main';
        $mode = (string) ( $a['mode'] ?? 'replace' );
        $all  = (array) get_option( 'wpm_css_sections', array() );
        if ( ! isset( $all[ $name ] ) && count( $all ) >= 30 ) {
            throw new BridgeError( 'too_many', 'At most 30 CSS sections. Remove one first.', 400 );
        }
        $before = Revisions::snap_option( 'wpm_css_sections' );
        $old    = (string) ( $all[ $name ] ?? '' );
        $all[ $name ] = 'append' === $mode ? $old . "\n" . $css : ( 'prepend' === $mode ? $css . "\n" . $old : $css );
        if ( strlen( $all[ $name ] ) > 200000 ) {
            throw new BridgeError( 'bad_css', 'The section would exceed 200 KB.', 400 );
        }
        update_option( 'wpm_css_sections', $all, false );
        Revisions::record( $c, 'options', 'wpm_css_sections', array( $before ) );
        $c->summary = "css section \"$name\" ($mode, " . strlen( $css ) . ' bytes)';

        return array( 'section' => $name, 'bytes' => strlen( $all[ $name ] ), 'sections' => array_keys( $all ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_css_remove( array $a, Context $c ): array {
        $name = sanitize_key( (string) $a['section'] );
        $all  = (array) get_option( 'wpm_css_sections', array() );
        if ( ! isset( $all[ $name ] ) ) {
            throw new BridgeError( 'not_found', "No CSS section \"$name\".", 404 );
        }
        $before = Revisions::snap_option( 'wpm_css_sections' );
        unset( $all[ $name ] );
        update_option( 'wpm_css_sections', $all, false );
        Revisions::record( $c, 'options', 'wpm_css_sections', array( $before ) );
        $c->summary = "removed css section \"$name\"";

        return array( 'removed' => $name, 'sections' => array_keys( $all ) );
    }

    /* --------------------------------------------------------------- templates */

    private static function is_block_theme(): bool {
        return function_exists( 'wp_is_block_theme' ) && wp_is_block_theme();
    }

    private static function kind_type( string $kind ): string {
        return 'part' === $kind ? 'wp_template_part' : 'wp_template';
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_templates_list( array $a, Context $c ): array {
        if ( ! self::is_block_theme() ) {
            $theme = wp_get_theme();
            $files = array();
            foreach ( (array) glob( $theme->get_stylesheet_directory() . '/*.php' ) as $file ) {
                $files[] = basename( (string) $file );
            }

            return array( 'block_theme' => false, 'theme_files' => $files, 'note' => 'Classic theme: edit header.php/footer.php with design.theme_file_read/theme_file_write (admin), or use menus and branding actions.' );
        }
        $kinds = ! empty( $a['kind'] ) ? array( (string) $a['kind'] ) : array( 'template', 'part' );
        $out   = array();
        foreach ( $kinds as $kind ) {
            foreach ( get_block_templates( array(), self::kind_type( $kind ) ) as $t ) {
                $out[] = array( 'kind' => $kind, 'slug' => $t->slug, 'title' => $t->title, 'source' => $t->source, 'customized' => 'custom' === $t->source || ! empty( $t->has_theme_file ) && 'custom' === $t->origin, 'area' => $t->area ?? null );
            }
        }

        return array( 'block_theme' => true, 'templates' => $out );
    }

    private static function find_template( string $slug, string $kind ): ?\WP_Block_Template {
        if ( ! self::is_block_theme() ) {
            throw new BridgeError( 'classic_theme', 'The active theme is not a block theme. Edit theme files (admin) instead.', 400 );
        }
        $t = get_block_template( get_stylesheet() . '//' . sanitize_key( $slug ), self::kind_type( $kind ) );

        return $t instanceof \WP_Block_Template ? $t : null;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_template_get( array $a, Context $c ): array {
        $t = self::find_template( (string) $a['slug'], (string) ( $a['kind'] ?? 'template' ) );
        if ( ! $t ) {
            throw new BridgeError( 'not_found', 'No such template. Use design.templates_list.', 404 );
        }

        return array( 'slug' => $t->slug, 'title' => $t->title, 'source' => $t->source, 'area' => $t->area ?? null, 'content' => $t->content, 'wp_id' => $t->wp_id ?: null );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_template_save( array $a, Context $c ): array {
        $kind = (string) ( $a['kind'] ?? 'template' );
        $slug = sanitize_key( (string) $a['slug'] );
        $t    = self::find_template( $slug, $kind );
        $type = self::kind_type( $kind );
        $post = array(
            'post_type'    => $type,
            'post_name'    => $slug,
            'post_title'   => (string) ( $a['title'] ?? ( $t->title ?? $slug ) ),
            'post_content' => Util::html( (string) $a['content'], $c ),
            'post_status'  => 'publish',
            'tax_input'    => array( 'wp_theme' => array( get_stylesheet() ) ),
        );
        if ( 'part' === $kind ) {
            $post['tax_input']['wp_template_part_area'] = array( (string) ( $a['area'] ?? ( $t->area ?? 'uncategorized' ) ) );
        }
        $existing = $t && $t->wp_id ? (int) $t->wp_id : 0;
        $before   = $existing ? Revisions::snap_post( $existing ) : null;
        if ( $existing ) {
            $post['ID'] = $existing;
        }
        $id = $existing ? wp_update_post( wp_slash( $post ), true ) : wp_insert_post( wp_slash( $post ), true );
        if ( is_wp_error( $id ) ) {
            throw new BridgeError( 'save_failed', $id->get_error_message(), 400 );
        }
        Revisions::record( $c, 'post', (string) $id, $before );
        $c->summary = "saved $kind \"$slug\"";

        return array( 'slug' => $slug, 'kind' => $kind, 'wp_id' => (int) $id );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_template_reset( array $a, Context $c ): array {
        $t = self::find_template( (string) $a['slug'], (string) ( $a['kind'] ?? 'template' ) );
        if ( ! $t || ! $t->wp_id ) {
            throw new BridgeError( 'not_customized', 'This template uses the theme file already.', 400 );
        }
        $before = Revisions::snap_post( (int) $t->wp_id );
        wp_trash_post( (int) $t->wp_id );
        Revisions::record( $c, 'post', (string) $t->wp_id, $before );
        $c->summary = "reset template \"{$t->slug}\" to the theme file";

        return array( 'reset' => $t->slug );
    }

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

    /* ------------------------------------------------------------------ themes */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_themes_list( array $a, Context $c ): array {
        $updates = (array) ( get_site_transient( 'update_themes' )->response ?? array() );
        $out     = array();
        foreach ( wp_get_themes() as $slug => $t ) {
            $out[] = array( 'slug' => $slug, 'name' => $t->get( 'Name' ), 'version' => $t->get( 'Version' ), 'active' => get_stylesheet() === $slug, 'parent' => $t->parent() ? $t->parent()->get_stylesheet() : null, 'update' => isset( $updates[ $slug ] ) ? ( $updates[ $slug ]['new_version'] ?? true ) : null, 'block_theme' => method_exists( $t, 'is_block_theme' ) && $t->is_block_theme() );
        }

        return array( 'themes' => $out );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_theme_activate( array $a, Context $c ): array {
        $t = wp_get_theme( sanitize_key( (string) $a['slug'] ) );
        if ( ! $t->exists() ) {
            throw new BridgeError( 'not_found', 'No such theme.', 404 );
        }

        return array( 'will_switch' => array( 'from' => get_stylesheet(), 'to' => $t->get_stylesheet() ), 'effect' => 'The whole site look changes immediately. Menus and widgets may need re-assigning.', 'undo' => 'possible' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_theme_activate( array $a, Context $c ): array {
        $slug = sanitize_key( (string) $a['slug'] );
        if ( ! wp_get_theme( $slug )->exists() ) {
            throw new BridgeError( 'not_found', 'No such theme.', 404 );
        }
        $from = get_stylesheet();
        switch_theme( $slug );
        Revisions::record( $c, 'theme', $slug, $from );
        $c->summary = "activated theme $slug (was $from)";

        return array( 'active' => $slug, 'previous' => $from );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_theme_install( array $a, Context $c ): array {
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/misc.php';
        require_once ABSPATH . 'wp-admin/includes/theme.php';
        require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
        $slug = sanitize_key( (string) $a['slug'] );
        $info = themes_api( 'theme_information', array( 'slug' => $slug, 'fields' => array( 'sections' => false ) ) );
        if ( is_wp_error( $info ) ) {
            throw new BridgeError( 'not_found', 'WordPress.org has no theme "' . $slug . '".', 404 );
        }
        Maintain::require_direct_fs();
        $upgrader = new \Theme_Upgrader( new \Automatic_Upgrader_Skin() );
        $result   = $upgrader->install( $info->download_link );
        if ( is_wp_error( $result ) || ! $result ) {
            throw new BridgeError( 'install_failed', is_wp_error( $result ) ? $result->get_error_message() : 'Installation failed.', 500 );
        }
        if ( ! empty( $a['activate'] ) ) {
            $from = get_stylesheet();
            switch_theme( $slug );
            Revisions::record( $c, 'theme', $slug, $from );
        }
        $c->summary = "installed theme $slug";

        return array( 'installed' => $slug, 'activated' => ! empty( $a['activate'] ) );
    }

    /* ------------------------------------------------------------- theme files */

    private static function theme_dir( string $slug ): string {
        $theme = wp_get_theme( '' === $slug ? get_stylesheet() : sanitize_key( $slug ) );
        if ( ! $theme->exists() ) {
            throw new BridgeError( 'not_found', 'No such theme.', 404 );
        }

        return wp_normalize_path( $theme->get_stylesheet_directory() );
    }

    private static function resolve( string $dir, string $relative, bool $must_exist ): string {
        if ( ! Policy::theme_path_ok( $relative ) ) {
            throw new BridgeError( 'bad_path', 'Path must be inside the theme, with a known extension (php css js json html txt svg md twig), no dot files and no "..".', 400 );
        }
        $full = $dir . '/' . $relative;
        $real = realpath( $full );
        if ( $must_exist && ( false === $real || ! str_starts_with( wp_normalize_path( $real ), $dir . '/' ) ) ) {
            throw new BridgeError( 'not_found', 'No such file in the theme.', 404 );
        }
        $parent = realpath( dirname( $full ) );
        if ( ! $must_exist && false !== $parent && ! str_starts_with( wp_normalize_path( $parent ) . '/', $dir . '/' ) ) {
            throw new BridgeError( 'bad_path', 'Path escapes the theme directory.', 400 );
        }

        return $full;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_theme_files( array $a, Context $c ): array {
        $dir   = self::theme_dir( (string) ( $a['theme'] ?? '' ) );
        $files = array();
        $it    = new \RecursiveIteratorIterator( new \RecursiveDirectoryIterator( $dir, \FilesystemIterator::SKIP_DOTS ), \RecursiveIteratorIterator::SELF_FIRST );
        $it->setMaxDepth( 4 );
        foreach ( $it as $file ) {
            if ( $file->isFile() && count( $files ) < 400 ) {
                $rel = ltrim( substr( wp_normalize_path( $file->getPathname() ), strlen( $dir ) ), '/' );
                if ( Policy::theme_path_ok( $rel ) && ! str_contains( $rel, 'node_modules/' ) ) {
                    $files[] = array( 'path' => $rel, 'bytes' => $file->getSize() );
                }
            }
        }
        sort( $files );

        return array( 'theme' => basename( $dir ), 'files' => $files );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_theme_file_read( array $a, Context $c ): array {
        $dir  = self::theme_dir( (string) ( $a['theme'] ?? '' ) );
        $full = self::resolve( $dir, (string) $a['path'], true );
        $size = (int) filesize( $full );
        $off  = max( 0, (int) ( $a['offset'] ?? 0 ) );
        $text = (string) file_get_contents( $full, false, null, $off, 100000 );

        return array( 'path' => (string) $a['path'], 'bytes' => $size, 'offset' => $off, 'truncated' => $off + strlen( $text ) < $size, 'content' => $text );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_theme_file_write( array $a, Context $c ): array {
        $dir  = self::theme_dir( (string) ( $a['theme'] ?? '' ) );
        $full = self::resolve( $dir, (string) $a['path'], false );

        return array( 'will_write' => (string) $a['path'], 'exists' => is_file( $full ), 'old_bytes' => is_file( $full ) ? filesize( $full ) : 0, 'new_bytes' => strlen( (string) $a['content'] ), 'syntax' => self::php_problem( (string) $a['path'], (string) $a['content'] ) ?? 'ok', 'safety_net' => 'For PHP files the front page is checked afterwards and the change is reverted automatically if it causes a fatal error.' );
    }

    private static function php_problem( string $path, string $content ): ?string {
        if ( 'php' !== strtolower( pathinfo( $path, PATHINFO_EXTENSION ) ) ) {
            return null;
        }
        try {
            token_get_all( $content, TOKEN_PARSE );
        } catch ( \ParseError $e ) {
            return 'PHP syntax error on line ' . $e->getLine() . ': ' . $e->getMessage();
        }

        return null;
    }

    private static function atomic_write( string $full, string $content ): void {
        wp_mkdir_p( dirname( $full ) );
        $tmp = $full . '.wpm-' . bin2hex( random_bytes( 4 ) );
        if ( false === file_put_contents( $tmp, $content ) || ! rename( $tmp, $full ) ) {
            @unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
            throw new BridgeError( 'write_failed', 'The file could not be written (permissions?).', 500 );
        }
        if ( function_exists( 'opcache_invalidate' ) ) {
            @opcache_invalidate( $full, true ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        }
    }

    /** True when the home page answers without a server error (null if it cannot be checked). */
    private static function front_ok(): ?bool {
        try {
            return Util::fetch_own( home_url( '/?wpm_check=' . time() ) )['status'] < 500;
        } catch ( BridgeError $e ) {
            return null;
        }
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_theme_file_write( array $a, Context $c ): array {
        $slug    = (string) ( $a['theme'] ?? '' );
        $dir     = self::theme_dir( $slug );
        $rel     = (string) $a['path'];
        $content = (string) $a['content'];
        $full    = self::resolve( $dir, $rel, false );
        if ( strlen( $content ) > 500000 ) {
            throw new BridgeError( 'too_large', 'File is larger than 500 KB.', 400 );
        }
        if ( null !== ( $problem = self::php_problem( $rel, $content ) ) ) {
            throw new BridgeError( 'syntax_error', $problem . ' Nothing was written.', 400 );
        }
        $existed = is_file( $full );
        $old     = $existed ? (string) file_get_contents( $full ) : '';
        $healthy = 'php' === strtolower( pathinfo( $rel, PATHINFO_EXTENSION ) ) ? self::front_ok() : null;

        self::atomic_write( $full, $content );
        if ( true === $healthy && false === self::front_ok() ) {
            $existed ? self::atomic_write( $full, $old ) : @unlink( $full ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
            throw new BridgeError( 'broke_site', 'The site returned a server error after this change, so it was reverted automatically.', 409 );
        }
        Revisions::record( $c, 'file', basename( $dir ) . '|' . $rel, array( 'theme' => basename( $dir ), 'path' => $rel, 'exists' => $existed, 'content' => $old ) );
        $c->summary = "wrote theme file $rel (" . strlen( $content ) . ' bytes)';

        return array( 'path' => $rel, 'bytes' => strlen( $content ), 'created' => ! $existed );
    }

    /**
     * @param array<string, mixed> $before Snapshot.
     */
    public static function restore_file( string $target, array $before ): string {
        $dir  = self::theme_dir( (string) ( $before['theme'] ?? '' ) );
        $rel  = (string) ( $before['path'] ?? '' );
        $full = self::resolve( $dir, $rel, false );
        if ( ! empty( $before['exists'] ) ) {
            self::atomic_write( $full, (string) $before['content'] );

            return "Restored $rel.";
        }
        if ( is_file( $full ) ) {
            unlink( $full );
        }

        return "Removed $rel (it did not exist before).";
    }
}
