<?php
/**
 * Design system: sync of the site tokens into theme.json and the Elementor kit, an audit of colors and fonts outside the tokens,
 * and the bundled block patterns.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\DesignRules;
use WPMCP\Bridge\Revisions;

defined( 'ABSPATH' ) || exit;

final class DesignSystem {

    /* ------------------------------------------------------------------ sync */

    /** @return array<string, mixed> */
    private static function tokens(): array {
        $tokens = get_option( 'wpm_tokens', array() );
        if ( ! is_array( $tokens ) || array() === $tokens ) {
            throw new BridgeError( 'no_tokens', 'The site has no design tokens yet. Set them with design.tokens_set first.', 409 );
        }

        return $tokens;
    }

    private static function kit_id(): int {
        return class_exists( '\Elementor\Plugin' ) ? (int) get_option( 'elementor_active_kit', 0 ) : 0;
    }

    private static function block_theme(): bool {
        return function_exists( 'wp_is_block_theme' ) && wp_is_block_theme();
    }

    /**
     * Which targets a sync touches: theme_json (block theme in use), elementor (kit present).
     *
     * @param array<string, mixed> $a Arguments.
     * @return list<string>
     */
    private static function targets( array $a ): array {
        $want = (string) ( $a['target'] ?? 'all' );
        $out  = array();
        if ( in_array( $want, array( 'all', 'theme_json' ), true ) && self::block_theme() ) {
            $out[] = 'theme_json';
        }
        if ( in_array( $want, array( 'all', 'elementor' ), true ) && self::kit_id() > 0 ) {
            $out[] = 'elementor';
        }
        if ( array() === $out ) {
            throw new BridgeError( 'nothing_to_sync', 'Nothing to sync: theme_json needs a block theme to be active, elementor needs Elementor with an active kit.', 409 );
        }

        return $out;
    }

    /** @return array<string, mixed> */
    private static function read_theme_json( string $file ): array {
        if ( ! is_file( $file ) ) {
            return array();
        }
        $json = json_decode( (string) file_get_contents( $file ), true );
        if ( ! is_array( $json ) ) {
            throw new BridgeError( 'bad_theme_json', 'The theme.json of the active theme is not valid JSON; fix it with files.read and files.write first.', 409 );
        }

        return $json;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_sync( array $a, Context $c ): array {
        $targets = self::targets( $a );
        $tokens  = self::tokens();
        $out     = array( 'targets' => $targets, 'needs_confirmation' => in_array( 'theme_json', $targets, true ), 'tokens' => array_keys( array_filter( $tokens ) ) );
        if ( in_array( 'theme_json', $targets, true ) ) {
            $out['theme_json'] = 'themes/' . get_stylesheet() . '/theme.json is rewritten with the palette, fonts, sizes, spacing and content width of the tokens (same slugs are replaced, other entries kept; the old file is kept for undo).';
        }
        if ( in_array( 'elementor', $targets, true ) ) {
            $out['elementor'] = 'Global Colors and Global Fonts of the active Elementor kit #' . self::kit_id() . ' are updated (primary, secondary, text, accent, body and heading fill the system entries, others are added as wpm-<slug>).';
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function sync( array $a, Context $c ): array {
        $targets = self::targets( $a );
        $tokens  = self::tokens();
        $done    = array();
        if ( in_array( 'theme_json', $targets, true ) ) {
            $c->need( 'admin', 'Writing theme.json needs admin level.' );
            $dir     = trailingslashit( get_stylesheet_directory() );
            $merged  = DesignRules::theme_json_merge( self::read_theme_json( $dir . 'theme.json' ), $tokens );
            $encoded = (string) wp_json_encode( $merged, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
            Files::op_write( array( 'root' => 'themes/' . get_stylesheet(), 'path' => 'theme.json', 'content' => $encoded . "\n" ), $c );
            $done['theme_json'] = 'themes/' . get_stylesheet() . '/theme.json';
        }
        if ( in_array( 'elementor', $targets, true ) ) {
            $id       = self::kit_id();
            $before   = Revisions::snap_post( $id );
            $settings = (array) get_post_meta( $id, '_elementor_page_settings', true );
            update_post_meta( $id, '_elementor_page_settings', DesignRules::elementor_kit_merge( $settings, $tokens ) );
            if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
                \Elementor\Plugin::$instance->files_manager->clear_cache();
            }
            Revisions::record( $c, 'post', (string) $id, $before, array( 'kit' => 'synced' ) );
            $done['elementor'] = "kit #$id";
        }
        $c->summary = 'synced design tokens to ' . implode( ' and ', array_keys( $done ) );

        return array( 'synced' => $done, 'note' => 'The tokens stay the single source: change them with design.tokens_set, then run tokens_sync again.' );
    }

    /* ----------------------------------------------------------------- audit */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function audit( array $a, Context $c ): array {
        $tokens  = (array) get_option( 'wpm_tokens', array() );
        $sources = array();
        foreach ( (array) get_option( 'wpm_css_sections', array() ) as $name => $css ) {
            $sources[ 'bridge css section "' . sanitize_key( (string) $name ) . '"' ] = (string) $css;
        }
        $custom = function_exists( 'wp_get_custom_css' ) ? (string) wp_get_custom_css() : '';
        if ( '' !== trim( $custom ) ) {
            $sources['Additional CSS (customizer)'] = $custom;
        }
        $themes = array( get_stylesheet() => get_stylesheet_directory() );
        if ( get_template() !== get_stylesheet() ) {
            $themes[ get_template() ] = get_template_directory();
        }
        foreach ( $themes as $slug => $dir ) {
            $file = trailingslashit( $dir ) . 'style.css';
            if ( is_file( $file ) && filesize( $file ) <= 400000 ) {
                $sources[ "theme $slug style.css" ] = (string) file_get_contents( $file );
            }
        }
        $report = array();
        $on     = 0;
        $off    = 0;
        foreach ( $sources as $name => $css ) {
            $found  = DesignRules::css_audit( $css, $tokens );
            $on    += $found['on_token'];
            $off   += $found['off_token'];
            $report[] = array(
                'source'   => $name,
                'bytes'    => strlen( $css ),
                'colors'   => array_slice( $found['colors'], 0, 40 ),
                'fonts'    => array_slice( $found['fonts'], 0, 20 ),
                'on_token' => $found['on_token'],
                'off_token' => $found['off_token'],
            );
        }

        return array(
            'tokens_set'    => array() !== $tokens,
            'summary'       => array( 'hard_coded_matching_a_token' => $on, 'not_in_tokens' => $off ),
            'sources'       => $report,
            'how_to_read'   => 'token set: the value equals a token, so replace it with the var() in "use". token null: not a token; add it with design.tokens_set or change it to a token color.',
            'not_checked'   => 'Plugin and page-builder CSS, inline styles and CSS files other than style.css. Check one page with inspect.styles.',
        );
    }

    /* -------------------------------------------------------------- patterns */

    private static function dir(): string {
        return WPMCP_DIR . 'scaffold/patterns/';
    }

    /**
     * @return array<string, array<string, mixed>> name => manifest
     */
    private static function manifests(): array {
        $out = array();
        foreach ( (array) glob( self::dir() . '*.json' ) as $file ) {
            $m = json_decode( (string) file_get_contents( $file ), true );
            if ( is_array( $m ) && is_file( preg_replace( '/\.json$/', '.html', $file ) ) ) {
                $out[ basename( $file, '.json' ) ] = $m;
            }
        }
        ksort( $out );

        return $out;
    }

    private static function lang( array $a ): string {
        $lang = (string) ( $a['lang'] ?? '' );
        if ( in_array( $lang, array( 'en', 'fa' ), true ) ) {
            return $lang;
        }

        return str_starts_with( (string) get_locale(), 'fa' ) ? 'fa' : 'en';
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function patterns_list( array $a, Context $c ): array {
        $lang = self::lang( $a );
        $out  = array();
        foreach ( self::manifests() as $name => $m ) {
            $out[] = array( 'name' => $name, 'title' => $m['title'] ?? $name, 'description' => $m['description'] ?? '', 'texts' => $m['text'][ $lang ] ?? array() );
        }

        return array( 'patterns' => $out, 'lang' => $lang, 'usage' => 'design.pattern_get {name, text?} returns block markup to use in content.save. The same patterns are in the editor inserter under "WP MCP". They use the token slugs (primary, secondary, surface, background, muted, xxl, xl, large, small), so they follow design.tokens_set.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function pattern_get( array $a, Context $c ): array {
        $name      = (string) ( $a['name'] ?? '' );
        $manifests = self::manifests();
        if ( ! isset( $manifests[ $name ] ) ) {
            throw new BridgeError( 'not_found', 'Patterns: ' . implode( ', ', array_keys( $manifests ) ) . '.', 404 );
        }
        $lang   = self::lang( $a );
        $markup = DesignRules::pattern_render( (string) file_get_contents( self::dir() . $name . '.html' ), (array) ( $manifests[ $name ]['text'][ $lang ] ?? array() ), (array) ( $a['text'] ?? array() ) );

        return array( 'name' => $name, 'lang' => $lang, 'content' => $markup, 'next' => 'Put it in a page with content.save (content), or join several patterns one after another.' );
    }

    /** Registers the patterns in the block editor (inserter category "WP MCP"), with the default text of the site language. */
    public static function register_patterns(): void {
        if ( ! function_exists( 'register_block_pattern' ) ) {
            return;
        }
        register_block_pattern_category( 'wpm', array( 'label' => 'WP MCP' ) );
        $lang = self::lang( array() );
        foreach ( self::manifests() as $name => $m ) {
            try {
                $content = DesignRules::pattern_render( (string) file_get_contents( self::dir() . $name . '.html' ), (array) ( $m['text'][ $lang ] ?? array() ), array() );
            } catch ( BridgeError $e ) {
                continue;
            }
            register_block_pattern( 'wpm/' . $name, array( 'title' => (string) ( $m['title'] ?? $name ), 'description' => (string) ( $m['description'] ?? '' ), 'categories' => array( 'wpm' ), 'keywords' => (array) ( $m['keywords'] ?? array() ), 'content' => $content ) );
        }
    }
}
