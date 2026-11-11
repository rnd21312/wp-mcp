<?php
/**
 * Pure design-system rules: merging tokens into theme.json and the Elementor kit, finding colors and fonts outside the tokens in CSS,
 * filling block pattern text. No WordPress calls, so they are unit-tested directly.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class DesignRules {

    private static function label( string $slug ): string {
        return ucfirst( str_replace( array( '-', '_' ), ' ', $slug ) );
    }

    /**
     * Replace the entry with this slug in a list of presets, or add it.
     *
     * @param list<array<string, mixed>> $list  Presets.
     * @param array<string, mixed>       $entry New preset (with a slug).
     * @return list<array<string, mixed>>
     */
    private static function upsert( array $list, array $entry ): array {
        foreach ( $list as $i => $item ) {
            if ( is_array( $item ) && ( $item['slug'] ?? null ) === $entry['slug'] ) {
                $list[ $i ] = array_merge( $item, $entry );

                return array_values( $list );
            }
        }
        $list[] = $entry;

        return array_values( $list );
    }

    /**
     * Site tokens merged into the settings of a theme.json: palette, font families, font sizes, spacing sizes and content width.
     * Entries with the same slug are replaced, others are kept.
     *
     * @param array<string, mixed> $json   Decoded theme.json (may be empty).
     * @param array<string, mixed> $tokens wpm_tokens.
     * @return array<string, mixed>
     */
    public static function theme_json_merge( array $json, array $tokens ): array {
        $json['version'] = $json['version'] ?? 3;
        $s               = (array) ( $json['settings'] ?? array() );
        $groups          = array(
            'colors'     => array( array( 'color', 'palette' ), 'color' ),
            'fonts'      => array( array( 'typography', 'fontFamilies' ), 'fontFamily' ),
            'font_sizes' => array( array( 'typography', 'fontSizes' ), 'size' ),
            'spacing'    => array( array( 'spacing', 'spacingSizes' ), 'size' ),
        );
        foreach ( $groups as $group => $def ) {
            [ $path, $field ] = $def;
            foreach ( (array) ( $tokens[ $group ] ?? array() ) as $slug => $value ) {
                $slug = (string) $slug;
                $list = (array) ( $s[ $path[0] ][ $path[1] ] ?? array() );
                $s[ $path[0] ][ $path[1] ] = self::upsert( $list, array( 'slug' => $slug, 'name' => self::label( $slug ), $field => (string) $value ) );
            }
        }
        if ( ! empty( $tokens['content_width'] ) ) {
            $s['layout']['contentSize'] = (string) $tokens['content_width'];
        }
        $json['settings'] = $s;

        return $json;
    }

    /**
     * Site tokens merged into the settings of an Elementor kit (Global Colors and Global Fonts). The tokens primary, secondary, text and
     * accent fill Elementor's four system colors, body and heading fill the text and primary system fonts, the rest become custom
     * entries with the id wpm-<slug>.
     *
     * @param array<string, mixed> $settings Kit settings (_elementor_page_settings).
     * @param array<string, mixed> $tokens   wpm_tokens.
     * @return array<string, mixed>
     */
    public static function elementor_kit_merge( array $settings, array $tokens ): array {
        $system_colors = array( 'primary', 'secondary', 'text', 'accent' );
        foreach ( (array) ( $tokens['colors'] ?? array() ) as $slug => $value ) {
            $slug = (string) $slug;
            if ( in_array( $slug, $system_colors, true ) ) {
                $settings['system_colors'] = self::kit_upsert( (array) ( $settings['system_colors'] ?? array() ), $slug, array( '_id' => $slug, 'title' => self::label( $slug ), 'color' => (string) $value ) );
            } else {
                $settings['custom_colors'] = self::kit_upsert( (array) ( $settings['custom_colors'] ?? array() ), 'wpm-' . $slug, array( '_id' => 'wpm-' . $slug, 'title' => self::label( $slug ), 'color' => (string) $value ) );
            }
        }
        $system_fonts = array( 'heading' => 'primary', 'body' => 'text' );
        foreach ( (array) ( $tokens['fonts'] ?? array() ) as $slug => $value ) {
            $slug   = (string) $slug;
            $family = trim( explode( ',', (string) $value )[0], " \t\"'" );
            if ( isset( $system_fonts[ $slug ] ) ) {
                $id                          = $system_fonts[ $slug ];
                $settings['system_typography'] = self::kit_upsert( (array) ( $settings['system_typography'] ?? array() ), $id, array( '_id' => $id, 'title' => self::label( $id ), 'typography_typography' => 'custom', 'typography_font_family' => $family ) );
            } else {
                $settings['custom_typography'] = self::kit_upsert( (array) ( $settings['custom_typography'] ?? array() ), 'wpm-' . $slug, array( '_id' => 'wpm-' . $slug, 'title' => self::label( $slug ), 'typography_typography' => 'custom', 'typography_font_family' => $family ) );
            }
        }

        return $settings;
    }

    /**
     * @param list<array<string, mixed>> $list  Kit entries.
     * @param array<string, mixed>       $entry New entry.
     * @return list<array<string, mixed>>
     */
    private static function kit_upsert( array $list, string $id, array $entry ): array {
        foreach ( $list as $i => $item ) {
            if ( is_array( $item ) && ( $item['_id'] ?? null ) === $id ) {
                $list[ $i ] = array_merge( $item, $entry );

                return array_values( $list );
            }
        }
        $list[] = $entry;

        return array_values( $list );
    }

    /** A color in one comparable form: #rrggbb lowercase for hex and opaque rgb(), other notations trimmed and lowercased. */
    public static function normalize_color( string $color ): string {
        $c = strtolower( trim( $color ) );
        if ( 1 === preg_match( '/^#([0-9a-f])([0-9a-f])([0-9a-f])$/', $c, $m ) ) {
            return '#' . $m[1] . $m[1] . $m[2] . $m[2] . $m[3] . $m[3];
        }
        if ( 1 === preg_match( '/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/', $c, $m ) && max( (int) $m[1], (int) $m[2], (int) $m[3] ) <= 255 ) {
            return sprintf( '#%02x%02x%02x', (int) $m[1], (int) $m[2], (int) $m[3] );
        }

        return (string) preg_replace( '/\s+/', '', $c );
    }

    /** First font family of a stack, lowercase and without quotes. */
    public static function first_family( string $stack ): string {
        return strtolower( trim( explode( ',', $stack )[0], " \t\"'" ) );
    }

    /**
     * Colors and font families written directly in CSS instead of through the tokens.
     *
     * @param array<string, mixed> $tokens wpm_tokens.
     * @return array{colors: list<array<string, mixed>>, fonts: list<array<string, mixed>>, on_token: int, off_token: int}
     */
    public static function css_audit( string $css, array $tokens ): array {
        $css          = (string) preg_replace( '#/\*.*?\*/#s', '', $css );
        $known_colors = array();
        foreach ( (array) ( $tokens['colors'] ?? array() ) as $slug => $value ) {
            $known_colors[ self::normalize_color( (string) $value ) ] = (string) $slug;
        }
        $known_fonts = array();
        foreach ( (array) ( $tokens['fonts'] ?? array() ) as $slug => $value ) {
            $known_fonts[ self::first_family( (string) $value ) ] = (string) $slug;
        }
        $colors = array();
        $fonts  = array();
        preg_match_all( '/([^{}]+)\{([^{}]*)\}/', $css, $blocks, PREG_SET_ORDER );
        foreach ( $blocks as $block ) {
            $selector = trim( (string) preg_replace( '/\s+/', ' ', $block[1] ) );
            foreach ( explode( ';', $block[2] ) as $declaration ) {
                $pos = strpos( $declaration, ':' );
                if ( false === $pos ) {
                    continue;
                }
                $property = strtolower( trim( substr( $declaration, 0, $pos ) ) );
                $value    = trim( substr( $declaration, $pos + 1 ) );
                if ( '' === $property || str_starts_with( $property, '--' ) ) {
                    continue; // a variable definition, not a use
                }
                if ( 'font-family' === $property && ! str_starts_with( strtolower( $value ), 'var(' ) && 1 !== preg_match( '/^(inherit|initial|unset)$/i', $value ) ) {
                    $family                 = self::first_family( $value );
                    $fonts[ $family ]['n']  = ( $fonts[ $family ]['n'] ?? 0 ) + 1;
                    $fonts[ $family ]['at'] = $fonts[ $family ]['at'] ?? array( 'selector' => $selector, 'property' => $property );
                    $fonts[ $family ]['v']  = $fonts[ $family ]['v'] ?? trim( explode( ',', $value )[0] );
                }
                $plain = (string) preg_replace( '/var\([^)]*\)/i', '', $value );
                if ( preg_match_all( '/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|rgba?\([^)]*\)|hsla?\([^)]*\)/i', $plain, $found ) ) {
                    foreach ( $found[0] as $raw ) {
                        $norm                 = self::normalize_color( $raw );
                        $colors[ $norm ]['n'] = ( $colors[ $norm ]['n'] ?? 0 ) + 1;
                        $colors[ $norm ]['at'] = $colors[ $norm ]['at'] ?? array( 'selector' => $selector, 'property' => $property );
                    }
                }
            }
        }
        $out_colors = array();
        $on         = 0;
        $off        = 0;
        foreach ( $colors as $value => $info ) {
            $slug         = $known_colors[ $value ] ?? null;
            $out_colors[] = array( 'value' => $value, 'count' => $info['n'], 'token' => $slug, 'use' => null === $slug ? null : 'var(--wpm-color-' . $slug . ')', 'example' => $info['at'] );
            null === $slug ? $off += $info['n'] : $on += $info['n'];
        }
        $out_fonts = array();
        foreach ( $fonts as $family => $info ) {
            $slug        = $known_fonts[ $family ] ?? null;
            $out_fonts[] = array( 'value' => $info['v'], 'count' => $info['n'], 'token' => $slug, 'use' => null === $slug ? null : 'var(--wpm-font-' . $slug . ')', 'example' => $info['at'] );
            null === $slug ? $off += $info['n'] : $on += $info['n'];
        }
        $by_count = static fn ( array $x, array $y ): int => $y['count'] <=> $x['count'];
        usort( $out_colors, $by_count );
        usort( $out_fonts, $by_count );

        return array( 'colors' => $out_colors, 'fonts' => $out_fonts, 'on_token' => $on, 'off_token' => $off );
    }

    /**
     * Fills the {{text}} placeholders of a block pattern: defaults first, then the caller's plain text (HTML-escaped). Unknown names are refused.
     *
     * @param array<string, string> $defaults Text by placeholder name.
     * @param array<string, mixed>  $given    Caller's text.
     */
    public static function pattern_render( string $markup, array $defaults, array $given ): string {
        foreach ( $given as $name => $text ) {
            if ( ! isset( $defaults[ (string) $name ] ) ) {
                throw new BridgeError( 'bad_arguments', "This pattern has no text \"$name\". Texts: " . implode( ', ', array_keys( $defaults ) ) . '.', 400 );
            }
            if ( ! is_scalar( $text ) || mb_strlen( (string) $text ) > 300 ) {
                throw new BridgeError( 'bad_arguments', "Text \"$name\" must be plain text of up to 300 characters.", 400 );
            }
        }
        $values = array_map( static fn ( $v ): string => htmlspecialchars( (string) $v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8' ), array_merge( $defaults, array_map( 'strval', $given ) ) );

        return Policy::scaffold_render( $markup, $values );
    }
}
