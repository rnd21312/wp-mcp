<?php
/**
 * Public-side effects of the settings the AI changed: CSS sections, design tokens, redirects, built-in SEO, robots.txt,
 * maintenance mode. Everything here is cheap and does nothing until an option is set.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class Frontend {

    public static function init(): void {
        add_action( 'template_redirect', array( self::class, 'maintenance' ), 0 );
        add_action( 'template_redirect', array( self::class, 'redirects' ), 1 );
        add_action( 'wp_head', array( self::class, 'head_css' ), 99 );
        add_action( 'wp_head', array( self::class, 'head_seo' ), 1 );
        add_filter( 'pre_get_document_title', array( self::class, 'title' ), 20 );
        add_filter( 'wp_robots', array( self::class, 'robots' ), 20 );
        add_filter( 'robots_txt', array( self::class, 'robots_txt' ), 20, 2 );
        add_filter( 'wp_theme_json_data_user', array( self::class, 'theme_json' ) );
        add_filter( 'wp_sitemaps_enabled', static fn ( $on ) => 'off' === get_option( 'wpm_sitemap', 'default' ) ? false : $on );
    }

    /* ---------------------------------------------------------------- CSS/tokens */

    public static function css_vars(): string {
        $tokens = get_option( 'wpm_tokens', array() );
        if ( ! is_array( $tokens ) || array() === $tokens ) {
            return '';
        }
        $vars = array();
        foreach ( array( 'colors' => 'color', 'fonts' => 'font', 'font_sizes' => 'size', 'spacing' => 'space' ) as $group => $prefix ) {
            foreach ( (array) ( $tokens[ $group ] ?? array() ) as $slug => $value ) {
                $vars[] = '--wpm-' . $prefix . '-' . sanitize_key( (string) $slug ) . ':' . self::clean_value( (string) $value );
            }
        }
        foreach ( array( 'radius' => 'radius', 'content_width' => 'content-width' ) as $key => $name ) {
            if ( ! empty( $tokens[ $key ] ) ) {
                $vars[] = '--wpm-' . $name . ':' . self::clean_value( (string) $tokens[ $key ] );
            }
        }

        return array() === $vars ? '' : ':root{' . implode( ';', $vars ) . '}';
    }

    private static function clean_value( string $value ): string {
        return trim( (string) preg_replace( '/[;{}<>\\\\]/', '', $value ) );
    }

    public static function head_css(): void {
        $css = self::css_vars();
        foreach ( (array) get_option( 'wpm_css_sections', array() ) as $name => $section ) {
            $css .= "\n/* wpm:" . sanitize_key( (string) $name ) . " */\n" . (string) $section;
        }
        if ( '' !== trim( $css ) ) {
            echo '<style id="wpm-css">' . str_ireplace( '</style', '<\/style', $css ) . "</style>\n"; // phpcs:ignore WordPress.Security.EscapeOutput
        }
    }

    /**
     * Adds the tokens to Global Styles (block themes) without touching the database.
     *
     * @param mixed $data WP_Theme_JSON_Data.
     * @return mixed
     */
    public static function theme_json( $data ) {
        $tokens = get_option( 'wpm_tokens', array() );
        if ( ! is_object( $data ) || ! method_exists( $data, 'update_with' ) || ! is_array( $tokens ) || array() === $tokens ) {
            return $data;
        }
        $settings = array();
        $palette  = array();
        foreach ( (array) ( $tokens['colors'] ?? array() ) as $slug => $value ) {
            $palette[] = array( 'slug' => sanitize_key( (string) $slug ), 'name' => ucfirst( str_replace( '-', ' ', sanitize_key( (string) $slug ) ) ), 'color' => self::clean_value( (string) $value ) );
        }
        if ( $palette ) {
            $settings['color']['palette']['custom'] = $palette;
        }
        $fonts = array();
        foreach ( (array) ( $tokens['fonts'] ?? array() ) as $slug => $value ) {
            $fonts[] = array( 'slug' => sanitize_key( (string) $slug ), 'name' => ucfirst( sanitize_key( (string) $slug ) ), 'fontFamily' => self::clean_value( (string) $value ) );
        }
        if ( $fonts ) {
            $settings['typography']['fontFamilies']['custom'] = $fonts;
        }
        $sizes = array();
        foreach ( (array) ( $tokens['font_sizes'] ?? array() ) as $slug => $value ) {
            $sizes[] = array( 'slug' => sanitize_key( (string) $slug ), 'name' => ucfirst( sanitize_key( (string) $slug ) ), 'size' => self::clean_value( (string) $value ) );
        }
        if ( $sizes ) {
            $settings['typography']['fontSizes']['custom'] = $sizes;
        }
        if ( ! empty( $tokens['content_width'] ) ) {
            $settings['layout']['contentSize'] = self::clean_value( (string) $tokens['content_width'] );
        }
        if ( array() === $settings ) {
            return $data;
        }

        return $data->update_with( array( 'version' => 3, 'settings' => $settings ) );
    }

    /* ---------------------------------------------------------------- redirects */

    public static function redirects(): void {
        $rules = get_option( 'wpm_redirects', array() );
        if ( ! is_array( $rules ) || array() === $rules || is_admin() ) {
            return;
        }
        $uri  = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_unslash( $_SERVER['REQUEST_URI'] ) : ''; // phpcs:ignore WordPress.Security
        $path = rawurldecode( (string) wp_parse_url( $uri, PHP_URL_PATH ) );
        $home = (string) wp_parse_url( home_url(), PHP_URL_PATH );
        if ( '' !== $home && str_starts_with( $path, $home ) ) {
            $path = substr( $path, strlen( $home ) );
        }
        $path = '/' . trim( $path, '/' );
        foreach ( $rules as $rule ) {
            $from = (string) ( $rule['from'] ?? '' );
            $to   = (string) ( $rule['to'] ?? '' );
            $code = (int) ( $rule['code'] ?? 301 );
            $hit  = false;
            if ( ! empty( $rule['regex'] ) ) {
                $hit = 1 === @preg_match( '#' . str_replace( '#', '\#', $from ) . '#i', $path, $m ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
                if ( $hit ) {
                    $to = (string) preg_replace( '#' . str_replace( '#', '\#', $from ) . '#i', $to, $path );
                }
            } else {
                $hit = strtolower( '/' . trim( $from, '/' ) ) === strtolower( $path );
            }
            if ( ! $hit ) {
                continue;
            }
            if ( in_array( $code, array( 410, 451 ), true ) ) {
                status_header( $code );
                nocache_headers();
                echo 410 === $code ? 'Gone' : 'Unavailable for legal reasons';
                exit;
            }
            $target = str_starts_with( $to, '/' ) ? home_url( $to ) : $to;
            wp_redirect( $target, $code, 'WP MCP Bridge' ); // phpcs:ignore WordPress.Security.SafeRedirect
            exit;
        }
    }

    /* --------------------------------------------------------------------- SEO */

    private static function post_id(): int {
        return is_singular() ? (int) get_queried_object_id() : 0;
    }

    private static function native(): bool {
        return 'native' === Handlers\Seo::provider();
    }

    public static function title( $title ) {
        $id = self::post_id();
        if ( $id && self::native() ) {
            $custom = (string) get_post_meta( $id, '_wpm_seo_title', true );
            if ( '' !== $custom ) {
                return $custom;
            }
        }

        return $title;
    }

    public static function robots( $robots ) {
        $id = self::post_id();
        if ( $id && self::native() ) {
            if ( '1' === (string) get_post_meta( $id, '_wpm_seo_noindex', true ) ) {
                $robots['noindex'] = true;
                unset( $robots['max-image-preview'] );
            }
            if ( '1' === (string) get_post_meta( $id, '_wpm_seo_nofollow', true ) ) {
                $robots['nofollow'] = true;
            }
        }

        return $robots;
    }

    public static function head_seo(): void {
        $id = self::post_id();
        if ( $id && self::native() ) {
            $desc  = (string) get_post_meta( $id, '_wpm_seo_description', true );
            $canon = (string) get_post_meta( $id, '_wpm_seo_canonical', true );
            $site  = (array) get_option( 'wpm_seo_site', array() );
            if ( '' !== $desc ) {
                echo '<meta name="description" content="' . esc_attr( $desc ) . "\">\n";
            }
            if ( '' !== $canon ) {
                remove_action( 'wp_head', 'rel_canonical' );
                echo '<link rel="canonical" href="' . esc_url( $canon ) . "\">\n";
            }
            $og_title = (string) get_post_meta( $id, '_wpm_seo_og_title', true );
            $og_desc  = (string) get_post_meta( $id, '_wpm_seo_og_description', true );
            $og_image = (string) get_post_meta( $id, '_wpm_seo_og_image', true );
            $og_image = '' !== $og_image ? $og_image : (string) ( $site['default_og_image'] ?? '' );
            foreach ( array( 'og:title' => '' !== $og_title ? $og_title : (string) get_post_meta( $id, '_wpm_seo_title', true ), 'og:description' => '' !== $og_desc ? $og_desc : $desc, 'og:image' => $og_image ) as $prop => $content ) {
                if ( '' !== $content ) {
                    echo '<meta property="' . esc_attr( $prop ) . '" content="' . esc_attr( $content ) . "\">\n";
                }
            }
        }
        if ( $id ) {
            $schema = (string) get_post_meta( $id, '_wpm_schema', true );
            if ( '' !== $schema ) {
                self::print_ld( $schema );
            }
        }
        if ( is_front_page() ) {
            $site = (array) get_option( 'wpm_seo_site', array() );
            if ( ! empty( $site['org_name'] ) ) {
                $org = array( '@context' => 'https://schema.org', '@type' => 'Organization', 'name' => $site['org_name'], 'url' => home_url( '/' ) );
                if ( ! empty( $site['org_logo'] ) ) {
                    $org['logo'] = $site['org_logo'];
                }
                if ( ! empty( $site['org_same_as'] ) ) {
                    $org['sameAs'] = array_values( (array) $site['org_same_as'] );
                }
                self::print_ld( (string) wp_json_encode( $org, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) );
            }
        }
    }

    private static function print_ld( string $json ): void {
        echo '<script type="application/ld+json">' . str_ireplace( '</script', '<\/script', $json ) . "</script>\n"; // phpcs:ignore WordPress.Security.EscapeOutput
    }

    public static function robots_txt( $output, $public ) {
        $custom = (string) get_option( 'wpm_robots_txt', '' );

        return '' !== trim( $custom ) ? $custom : $output;
    }

    /* ------------------------------------------------------------- maintenance */

    /** Header the bridge sends when it fetches its own pages, so it can still see the site in maintenance mode. */
    public static function inspect_header(): string {
        $ts = (string) time();

        return $ts . '.' . hash_hmac( 'sha256', 'inspect' . $ts, wp_salt( 'auth' ) );
    }

    private static function inspect_header_ok(): bool {
        $given = isset( $_SERVER['HTTP_X_WPM_INSPECT'] ) ? (string) wp_unslash( $_SERVER['HTTP_X_WPM_INSPECT'] ) : ''; // phpcs:ignore WordPress.Security
        [ $ts, $mac ] = array_pad( explode( '.', $given, 2 ), 2, '' );

        return ctype_digit( $ts ) && abs( time() - (int) $ts ) < 60 && hash_equals( hash_hmac( 'sha256', 'inspect' . $ts, wp_salt( 'auth' ) ), $mac );
    }

    public static function maintenance(): void {
        $state = get_option( 'wpm_maintenance', array() );
        if ( empty( $state['on'] ) || current_user_can( 'manage_options' ) || is_admin() || self::inspect_header_ok() ) {
            return;
        }
        status_header( 503 );
        header( 'Retry-After: 600' );
        nocache_headers();
        $message = (string) ( $state['message'] ?? 'We are doing some maintenance and will be back shortly.' );
        echo '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>' . esc_html( get_bloginfo( 'name' ) ) . '</title></head><body style="font:18px/1.6 system-ui;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center"><p>' . esc_html( $message ) . '</p></body></html>'; // phpcs:ignore WordPress.Security.EscapeOutput
        exit;
    }
}
