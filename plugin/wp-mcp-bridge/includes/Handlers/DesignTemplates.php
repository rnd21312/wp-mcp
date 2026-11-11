<?php
/**
 * Part of Design: block templates and template parts.
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

trait DesignTemplates {

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
}
