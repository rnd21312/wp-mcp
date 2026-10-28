<?php
/**
 * What may be touched and at which level. Pure rules, no WordPress calls, so they are unit-tested directly.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class Policy {

    /** Option or meta names that look like secrets. Never returned, never written. */
    private const SECRET = '/(secret|passw(or)?d|passwd|token|api[_-]?key|apikey|private[_-]?key|auth_key|secure_auth|logged_in_(key|salt)|nonce_(key|salt)|_salt$|credential|licen[sc]e|webhook|bearer|client_secret|access_key|smtp|(^|[_-])pass($|[_-]))/i';

    private const SAFE_OPTIONS = array(
        'blogname', 'blogdescription', 'timezone_string', 'gmt_offset', 'date_format', 'time_format', 'start_of_week', 'WPLANG',
        'permalink_structure', 'category_base', 'tag_base', 'show_on_front', 'page_on_front', 'page_for_posts', 'posts_per_page',
        'posts_per_rss', 'rss_use_excerpt', 'default_category', 'default_comment_status', 'default_ping_status', 'comment_moderation',
        'require_name_email', 'thread_comments', 'thread_comments_depth', 'comments_per_page', 'page_comments', 'comment_registration',
        'close_comments_for_old_posts', 'close_comments_days_old', 'show_avatars', 'avatar_default', 'site_icon', 'comment_previously_approved',
        'default_pingback_flag', 'uploads_use_yearmonth_folders', 'thumbnail_size_w', 'thumbnail_size_h', 'medium_size_w', 'medium_size_h',
        'large_size_w', 'large_size_h', 'woocommerce_currency', 'woocommerce_price_num_decimals', 'woocommerce_default_country',
    );

    private const SENSITIVE_OPTIONS = array(
        'siteurl', 'home', 'admin_email', 'users_can_register', 'default_role', 'active_plugins', 'template', 'stylesheet', 'user_roles',
        'blog_public', 'db_version', 'initial_db_version', 'cron', 'rewrite_rules', 'sidebars_widgets', 'recently_activated', 'mailserver_url',
        'mailserver_login', 'mailserver_pass', 'mailserver_port', 'ping_sites', 'moderation_keys', 'disallowed_keys', 'upload_path', 'upload_url_path',
    );

    public static function is_secret_key( string $key ): bool {
        return 1 === preg_match( self::SECRET, $key ) || str_starts_with( $key, 'wpm_bridge_' );
    }

    /**
     * @return string safe (live to change, read to see), sensitive (admin), secret (never).
     */
    public static function option_tier( string $key ): string {
        if ( self::is_secret_key( $key ) ) {
            return 'secret';
        }
        if ( in_array( $key, self::SAFE_OPTIONS, true ) ) {
            return 'safe';
        }

        return 'sensitive';
    }

    public static function sensitive_option( string $key ): bool {
        return in_array( $key, self::SENSITIVE_OPTIONS, true );
    }

    /**
     * Replaces values under secret-looking keys, at any depth.
     *
     * @param mixed $value Any option or meta value.
     * @return mixed
     */
    public static function redact( $value ) {
        if ( is_object( $value ) ) {
            $value = (array) $value;
        }
        if ( ! is_array( $value ) ) {
            return $value;
        }
        $out = array();
        foreach ( $value as $k => $v ) {
            $out[ $k ] = is_string( $k ) && 1 === preg_match( self::SECRET, $k ) ? '***redacted***' : self::redact( $v );
        }

        return $out;
    }

    /** Meta keys the AI may set through content.save. */
    public static function meta_allowed( string $key ): bool {
        if ( '' === $key || strlen( $key ) > 191 || self::is_secret_key( $key ) ) {
            return false;
        }
        if ( ! str_starts_with( $key, '_' ) ) {
            return true;
        }
        foreach ( array( '_yoast_wpseo_', '_aioseo_', '_seopress_', '_wpm_', '_thumbnail_id', '_wp_page_template', '_wp_attachment_image_alt' ) as $prefix ) {
            if ( str_starts_with( $key, $prefix ) ) {
                return true;
            }
        }

        return false;
    }

    /* ------------------------------------------------------------- REST proxy */

    /** Cleans a REST path; null when it is unsafe. */
    public static function rest_path( string $path ): ?string {
        $path = rawurldecode( trim( $path ) );
        $path = (string) preg_replace( '#^/?wp-json#', '', $path );
        $path = '/' . ltrim( (string) preg_replace( '#/+#', '/', strtok( $path, '?' ) ?: '' ), '/' );
        if ( str_contains( $path, '..' ) || str_contains( $path, "\0" ) || '/' === $path ) {
            return null;
        }

        return rtrim( $path, '/' ) ?: null;
    }

    /**
     * Level needed for a REST call, and whether it needs confirmation. Null means never allowed.
     *
     * @return array{level: string, confirm: bool}|null
     */
    public static function rest_rule( string $method, string $path ): ?array {
        $method = strtoupper( $method );
        $path   = self::rest_path( $path );
        if ( null === $path || ! in_array( $method, array( 'GET', 'POST', 'PUT', 'PATCH', 'DELETE' ), true ) ) {
            return null;
        }
        if ( str_starts_with( $path, '/wp-mcp/' ) ) {
            return null;
        }

        $parts    = explode( '/', trim( $path, '/' ) );
        $ns       = ( $parts[0] ?? '' ) . '/' . ( $parts[1] ?? '' );
        $resource = $parts[2] ?? '';

        $level = 'admin';
        if ( 'wp/v2' === $ns ) {
            if ( in_array( $resource, array( 'posts', 'pages', 'categories', 'tags', 'media', 'types', 'taxonomies', 'statuses' ), true ) ) {
                $level = 'GET' === $method ? 'read' : 'live';
            } elseif ( 'comments' === $resource ) {
                $level = 'GET' === $method ? 'draft' : 'live';
            }
        } elseif ( 'wc/v3' === $ns ) {
            $second = $parts[3] ?? '';
            if ( 'products' === $resource && ! in_array( $second, array( 'reviews' ), true ) ) {
                $level = 'GET' === $method ? 'read' : 'live';
            } elseif ( 'coupons' === $resource ) {
                $level = 'live';
            }
        }
        $sensitive = array( 'users', 'settings', 'application-passwords', 'plugins', 'themes', 'site-health', 'block-editor', 'keys', 'webhooks', 'system_status', 'payment_gateways', 'customers', 'orders', 'refunds', 'reports', 'data', 'licenses', 'license' );
        foreach ( $parts as $segment ) {
            if ( in_array( $segment, $sensitive, true ) ) {
                $level = 'admin';
            }
        }

        $confirm = 'DELETE' === $method || ( 'GET' !== $method && 'admin' === $level );

        return array( 'level' => $level, 'confirm' => $confirm );
    }

    /* ------------------------------------------------------------------- URLs */

    public static function is_public_ip( string $ip ): bool {
        if ( false === filter_var( $ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE ) ) {
            return false;
        }
        if ( preg_match( '/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i', $ip, $m ) ) {
            return self::is_public_ip( $m[1] );
        }
        if ( filter_var( $ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4 ) ) {
            $long = ip2long( $ip );
            if ( false !== $long && ( $long & 0xFFC00000 ) === 0x64400000 ) {
                return false; // 100.64.0.0/10 (carrier-grade NAT).
            }
            if ( false !== $long && ( $long & 0xFFFE0000 ) === 0xC6120000 ) {
                return false; // 198.18.0.0/15.
            }
        } else {
            $packed = inet_pton( $ip );
            if ( false !== $packed && ( ord( $packed[0] ) & 0xFE ) === 0xFC ) {
                return false; // fc00::/7.
            }
        }

        return true;
    }

    /**
     * Error text when a URL must not be fetched (null = fine). Resolves the host to check every address.
     *
     * @param array<int, string>|null $resolved Addresses, injected by tests.
     */
    public static function url_problem( string $url, ?array $resolved = null ): ?string {
        $parts = wp_parse_url( $url );
        if ( ! is_array( $parts ) || empty( $parts['host'] ) ) {
            return 'Invalid URL.';
        }
        if ( 'https' !== strtolower( (string) ( $parts['scheme'] ?? '' ) ) ) {
            return 'Only https:// URLs are allowed.';
        }
        if ( isset( $parts['user'] ) || isset( $parts['pass'] ) ) {
            return 'URLs with credentials are not allowed.';
        }
        $host = strtolower( trim( (string) $parts['host'], '[]' ) );
        if ( 'localhost' === $host || str_ends_with( $host, '.localhost' ) || str_ends_with( $host, '.local' ) || str_ends_with( $host, '.internal' ) ) {
            return 'Local host names are not allowed.';
        }
        $addresses = $resolved;
        if ( null === $addresses ) {
            if ( false !== filter_var( $host, FILTER_VALIDATE_IP ) ) {
                $addresses = array( $host );
            } else {
                $addresses = array();
                foreach ( (array) @dns_get_record( $host, DNS_A | DNS_AAAA ) as $record ) { // phpcs:ignore WordPress.PHP.NoSilencedErrors
                    $addresses[] = (string) ( $record['ip'] ?? $record['ipv6'] ?? '' );
                }
            }
        }
        if ( array() === $addresses ) {
            return 'The host does not resolve.';
        }
        foreach ( $addresses as $ip ) {
            if ( ! self::is_public_ip( $ip ) ) {
                return 'The host resolves to a private or reserved address.';
            }
        }

        return null;
    }

    /* ------------------------------------------------------------------ files */

    /** A path inside a theme directory: no traversal, a known extension, no dotfiles. */
    public static function theme_path_ok( string $relative ): bool {
        if ( '' === $relative || strlen( $relative ) > 200 || str_contains( $relative, "\0" ) || str_contains( $relative, '\\' ) ) {
            return false;
        }
        if ( str_starts_with( $relative, '/' ) || preg_match( '#(^|/)\.\.?(/|$)#', $relative ) || preg_match( '#(^|/)\.#', $relative ) ) {
            return false;
        }
        $ext = strtolower( pathinfo( $relative, PATHINFO_EXTENSION ) );

        return in_array( $ext, array( 'php', 'css', 'js', 'json', 'html', 'txt', 'svg', 'md', 'twig' ), true );
    }

    /** Meta that travels with exported content: normal meta plus the builders' and SEO plugins' private keys. */
    public static function transfer_meta_ok( string $key ): bool {
        if ( self::is_secret_key( $key ) || '_thumbnail_id' === $key ) {
            return false;
        }
        if ( self::meta_allowed( $key ) ) {
            return true;
        }

        return 1 === preg_match( '/^_(elementor_|wpb_|et_pb_|fl_builder|fusion|yoast_wpseo_|aioseo_|seopress_|wpm_|oembed_|price$|regular_price$|sale_price$|sku$|stock$|stock_status$|manage_stock$|backorders$|virtual$|downloadable$|weight$|length$|width$|height$|product_attributes$|visibility$|featured$|sold_individually$|tax_status$|tax_class$|wc_)/', $key ) || 1 === preg_match( '/^(rank_math_|_wp_page_template$)/', $key );
    }

    /** A file path inside a files root. Text types are allowed everywhere; media types only matter for uploads. */
    public static function files_path_ok( string $relative, bool $uploads ): bool {
        if ( '' === $relative || strlen( $relative ) > 240 || str_contains( $relative, "\0" ) || str_contains( $relative, '\\' ) ) {
            return false;
        }
        if ( str_starts_with( $relative, '/' ) || preg_match( '#(^|/)\.\.?(/|$)#', $relative ) || preg_match( '#(^|/)\.#', $relative ) || str_contains( $relative, 'wpmcp-backups' ) ) {
            return false;
        }
        $ext  = strtolower( pathinfo( $relative, PATHINFO_EXTENSION ) );
        $text = array( 'php', 'css', 'js', 'json', 'html', 'htm', 'txt', 'svg', 'md', 'twig', 'xml', 'po', 'pot', 'mo', 'ini', 'yml', 'yaml', 'map' );
        $media = array( 'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm', 'mp3', 'ogg', 'pdf', 'zip' );

        return in_array( $ext, $text, true ) && ( ! $uploads || 'php' !== $ext ) || in_array( $ext, $media, true ) && ( $uploads || 'zip' !== $ext );
    }

    public static function level_for_status( string $status ): string {
        return in_array( $status, array( 'draft', 'pending', 'auto-draft', 'private', 'trash' ), true ) ? 'draft' : 'live';
    }
}
