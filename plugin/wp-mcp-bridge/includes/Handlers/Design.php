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
use WPMCP\Bridge\PhpGuard;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Revisions;
use WPMCP\Bridge\Util;

defined( 'ABSPATH' ) || exit;

final class Design {

    use DesignTemplates, DesignMenus, DesignThemes;

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
        if ( Policy::css_runs_code( $css ) ) {
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

}
