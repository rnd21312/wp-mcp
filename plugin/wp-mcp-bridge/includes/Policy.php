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

    /** CSS that can run code in some browser: javascript: URLs, IE expression() and behavior, Firefox -moz-binding. */
    public static function css_runs_code( string $css ): bool {
        return 1 === preg_match( '/javascript:|expression\s*\(|(?<![\w-])behavior\s*:|-moz-binding/i', $css );
    }

    /** True when the SQL holds one statement: no ";" outside quoted text (a trailing one is fine). */
    public static function sql_is_single( string $sql ): bool {
        $bare = preg_replace( '/\'(?:[^\'\\\\]|\\\\.|\'\')*\'|"(?:[^"\\\\]|\\\\.|"")*"|`[^`]*`/s', '', $sql );

        return is_string( $bare ) && ! str_contains( rtrim( $bare, "; \t\n\r" ), ';' );
    }

    /**
     * Applies exact text replacements to a file. Each edit is {old, new, all?}: "old" must occur exactly once, unless "all" is set.
     * Line endings follow the file, so an edit written with \n matches a \r\n file.
     *
     * @param list<mixed> $edits Edits.
     * @return array{0: string, 1: int} The new text and how many replacements were made.
     */
    public static function apply_edits( string $text, array $edits ): array {
        if ( array() === $edits || count( $edits ) > 50 ) {
            throw new BridgeError( 'bad_arguments', 'edits must be a list of 1-50 items like {old, new}.', 400 );
        }
        $crlf  = str_contains( $text, "\r\n" );
        $eol   = static fn ( string $s ): string => $crlf ? str_replace( "\n", "\r\n", str_replace( "\r\n", "\n", $s ) ) : $s;
        $total = 0;
        foreach ( array_values( $edits ) as $i => $edit ) {
            $n = $i + 1;
            if ( ! is_array( $edit ) || ! is_string( $edit['old'] ?? null ) || '' === $edit['old'] || ! is_string( $edit['new'] ?? null ) ) {
                throw new BridgeError( 'bad_arguments', "Edit $n needs a non-empty \"old\" and a \"new\" (both text).", 400 );
            }
            $old   = $eol( $edit['old'] );
            $count = substr_count( $text, $old );
            if ( 0 === $count ) {
                throw new BridgeError( 'no_match', "Edit $n: \"old\" was not found in the file. Read the file again and copy the text exactly, including spaces. Nothing was written.", 409 );
            }
            if ( $count > 1 && empty( $edit['all'] ) ) {
                throw new BridgeError( 'ambiguous', "Edit $n: \"old\" occurs $count times. Add surrounding lines to make it unique, or set all:true. Nothing was written.", 409 );
            }
            $text   = str_replace( $old, $eol( $edit['new'] ), $text );
            $total += $count;
        }

        return array( $text, $total );
    }

    /** wp-config constants that may be read and set: anything but database credentials, keys, salts and paths. */
    public static function config_name_ok( string $name ): bool {
        if ( 1 !== preg_match( '/^[A-Z][A-Z0-9_]{1,60}$/', $name ) ) {
            return false;
        }

        return 1 !== preg_match( '/^(DB_|WPMCP_|ABSPATH$|WP_CONTENT_DIR$|WP_PLUGIN_DIR$|WPMU_PLUGIN_DIR$|UPLOADS$)|(_KEY|_SALT|_SECRET|_PASSWORD|_TOKEN)$/', $name );
    }

    /**
     * Sets one define() in the text of wp-config.php: replaces the existing line, or adds one above "stop editing".
     *
     * @param bool|int|float|string $value Value.
     */
    public static function config_set( string $source, string $name, $value ): string {
        if ( ! self::config_name_ok( $name ) || ! is_scalar( $value ) ) {
            throw new BridgeError( 'bad_arguments', 'That constant cannot be set here (credentials, keys, salts and paths are off limits), or the value is not text, a number or true/false.', 400 );
        }
        $eol  = str_contains( $source, "\r\n" ) ? "\r\n" : "\n";
        $line = "define( '$name', " . var_export( $value, true ) . ' );';
        $seen = 0;
        $out  = preg_replace_callback( '/^[ \t]*define\s*\(\s*([\'"])' . $name . '\1\s*,[^\r\n]*\)\s*;[^\r\n]*$/m', static fn (): string => $line, $source, 1, $seen );
        if ( ! is_string( $out ) ) {
            throw new BridgeError( 'config_unreadable', 'wp-config.php could not be parsed.', 500 );
        }
        if ( $seen > 0 ) {
            return $out;
        }
        foreach ( array( '/^[^\r\n]*stop editing[^\r\n]*$/mi', '/^[^\r\n]*require(_once)?[^\r\n]*wp-settings\.php[^\r\n]*$/m' ) as $anchor ) {
            $out = preg_replace_callback( $anchor, static fn ( array $m ): string => $line . $eol . $m[0], $source, 1, $seen );
            if ( is_string( $out ) && $seen > 0 ) {
                return $out;
            }
        }
        throw new BridgeError( 'config_unreadable', 'wp-config.php has no "stop editing" line and does not load wp-settings.php, so there is no safe place for a new constant.', 409 );
    }

    /**
     * Which page template to hand to wp_insert_post/wp_update_post. WordPress re-validates the template already stored on a page
     * every time it is saved, so a page whose template file vanished (theme switched) cannot be saved at all until it is reset.
     *
     * @param string|null          $given   The template argument ("" means the default template), or null when not sent.
     * @param string               $current Template stored on the page now ("" for a new page).
     * @param array<string,string> $valid   Templates the active theme offers for this post type, file or slug => name.
     * @return array{template: string|null, note: string|null} template null = leave WordPress to keep what is stored.
     */
    public static function template_plan( ?string $given, string $current, array $valid ): array {
        if ( null !== $given ) {
            $want = trim( $given );
            $want = '' === $want ? 'default' : $want;
            if ( 'default' !== $want && ! isset( $valid[ $want ] ) ) {
                $names = array_keys( $valid );
                throw new BridgeError( 'bad_template', "Template \"$want\" does not exist in the active theme" . ( $names ? '. Available: ' . implode( ', ', array_slice( $names, 0, 20 ) ) . '. Use "" or "default" for the default template.' : ' (it offers no page templates here). Use "" or "default".' ), 400 );
            }

            return array( 'template' => $want, 'note' => null );
        }
        if ( '' === $current || 'default' === $current || isset( $valid[ $current ] ) ) {
            return array( 'template' => null, 'note' => null );
        }

        return array( 'template' => 'default', 'note' => "the page template \"$current\" no longer exists in the active theme; reset to the default template" );
    }

    /** An IndexNow key: 8-128 letters, digits and dashes. */
    public static function indexnow_key_ok( string $key ): bool {
        return 1 === preg_match( '/^[A-Za-z0-9-]{8,128}$/', $key );
    }

    /**
     * Splits URLs into those IndexNow accepts for this site (https or http on exactly this host, no credentials, no fragment) and
     * the rest with a reason. Duplicates are dropped.
     *
     * @param mixed  $urls List of URLs.
     * @param string $host Host of the site.
     * @return array{ok: list<string>, rejected: list<array{url: string, reason: string}>}
     */
    public static function indexnow_urls( $urls, string $host ): array {
        $ok       = array();
        $rejected = array();
        foreach ( (array) $urls as $url ) {
            $url   = trim( (string) $url );
            $parts = wp_parse_url( $url );
            if ( ! is_array( $parts ) || empty( $parts['host'] ) || ! in_array( strtolower( (string) ( $parts['scheme'] ?? '' ) ), array( 'http', 'https' ), true ) ) {
                $rejected[] = array( 'url' => $url, 'reason' => 'not a full http(s) address' );
            } elseif ( strtolower( (string) $parts['host'] ) !== strtolower( $host ) ) {
                $rejected[] = array( 'url' => $url, 'reason' => 'not on ' . $host );
            } elseif ( isset( $parts['user'] ) || isset( $parts['pass'] ) || isset( $parts['fragment'] ) ) {
                $rejected[] = array( 'url' => $url, 'reason' => 'credentials or a #fragment' );
            } else {
                $same = strtolower( (string) $parts['scheme'] ) . '://' . strtolower( (string) $parts['host'] ) . ( isset( $parts['port'] ) ? ':' . $parts['port'] : '' ) . ( $parts['path'] ?? '/' ) . ( isset( $parts['query'] ) ? '?' . $parts['query'] : '' );
                if ( ! isset( $ok[ $same ] ) ) {
                    $ok[ $same ] = $url;
                }
            }
        }

        return array( 'ok' => array_values( $ok ), 'rejected' => $rejected );
    }

    /** A theme or plugin folder name: lowercase letters, digits and dashes, 3-40 characters. */
    public static function scaffold_slug( string $slug ): string {
        $slug = trim( $slug );
        if ( 1 !== preg_match( '/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/', $slug ) || str_contains( $slug, '--' ) ) {
            throw new BridgeError( 'bad_arguments', 'slug must be 3-40 characters: lowercase letters, digits and single dashes (for example my-shop).', 400 );
        }

        return $slug;
    }

    /** A display name that is safe inside a PHP comment, a CSS comment and HTML. */
    public static function scaffold_name( string $name ): string {
        $name = trim( $name );
        if ( 1 !== preg_match( '/^[\p{L}\p{N} _.&()\-]{1,60}$/u', $name ) ) {
            throw new BridgeError( 'bad_arguments', 'name must be 1-60 letters, digits, spaces and . _ - & ( ).', 400 );
        }

        return $name;
    }

    /** Free text for a plugin header (description, author): no comment end, tags or quotes. Empty gives the default. */
    public static function scaffold_text( string $text, string $default ): string {
        $text = trim( $text );
        if ( '' === $text ) {
            return $default;
        }
        if ( 1 !== preg_match( '/^[\p{L}\p{N} _.,&()\-:!?]{1,200}$/u', $text ) ) {
            throw new BridgeError( 'bad_arguments', 'description and author must be plain text of up to 200 letters, digits, spaces and . , & ( ) - : ! ?', 400 );
        }

        return $text;
    }

    /**
     * Default tokens with the caller's changes on top. Groups: colors, fonts, font_sizes, spacing (slug => value), plus radius and content_width.
     *
     * @param array<string, mixed> $defaults Tokens of the base theme.
     * @param array<string, mixed> $given    Caller's tokens.
     * @return array<string, mixed>
     */
    public static function scaffold_tokens( array $defaults, array $given ): array {
        $out = $defaults;
        foreach ( array( 'colors', 'fonts', 'font_sizes', 'spacing' ) as $group ) {
            foreach ( (array) ( $given[ $group ] ?? array() ) as $slug => $value ) {
                $slug = (string) $slug;
                $text = trim( (string) $value );
                if ( 1 !== preg_match( '/^[a-z0-9_-]{1,40}$/', $slug ) || '' === $text || strlen( $text ) > 200 || 1 === preg_match( '/[;{}<>\\\\"`]/', $text ) ) {
                    throw new BridgeError( 'bad_token', "Invalid token \"$group.$slug\": a lowercase slug and a value without ; { } < > \" ` or backslash, max 200 characters.", 400 );
                }
                $out[ $group ][ $slug ] = $text;
            }
        }
        foreach ( array( 'radius', 'content_width' ) as $single ) {
            if ( isset( $given[ $single ] ) ) {
                $text = trim( (string) $given[ $single ] );
                if ( '' === $text || strlen( $text ) > 60 || 1 === preg_match( '/[;{}<>\\\\"`]/', $text ) ) {
                    throw new BridgeError( 'bad_token', "Invalid $single.", 400 );
                }
                $out[ $single ] = $text;
            }
        }

        return $out;
    }

    /**
     * Placeholders for the theme templates: {{slug}}, {{name}}, {{color_primary}}, {{font_body}}, {{size_base}}, {{space_m}}, {{radius}}, {{content_width}}.
     *
     * @param array<string, mixed> $tokens Final tokens.
     * @return array<string, string>
     */
    public static function scaffold_vars( array $tokens, string $slug, string $name ): array {
        $vars = array( 'slug' => $slug, 'name' => $name, 'radius' => (string) ( $tokens['radius'] ?? '8px' ), 'content_width' => (string) ( $tokens['content_width'] ?? '1100px' ) );
        foreach ( array( 'colors' => 'color', 'fonts' => 'font', 'font_sizes' => 'size', 'spacing' => 'space' ) as $group => $prefix ) {
            foreach ( (array) ( $tokens[ $group ] ?? array() ) as $key => $value ) {
                $vars[ $prefix . '_' . str_replace( '-', '_', (string) $key ) ] = (string) $value;
            }
        }

        return $vars;
    }

    /**
     * Fills {{placeholders}}. A placeholder without a value is an error (a token the base theme needs was removed).
     *
     * @param array<string, string> $vars Values.
     */
    public static function scaffold_render( string $template, array $vars ): string {
        return (string) preg_replace_callback(
            '/\{\{([a-z0-9_]+)\}\}/',
            static function ( array $m ) use ( $vars ): string {
                if ( ! isset( $vars[ $m[1] ] ) ) {
                    throw new BridgeError( 'bad_token', "The theme needs the value \"{$m[1]}\", but it is missing (a token was removed?).", 400 );
                }

                return $vars[ $m[1] ];
            },
            $template
        );
    }

    /**
     * Is this checksum entry part of what core_verify checks? wp-content, wp-config.php and the loose documentation files that
     * hardening guides tell people to delete are left out.
     */
    public static function core_checked( string $path ): bool {
        $low = strtolower( $path );
        if ( '' === $path || str_contains( $path, '..' ) || str_contains( $path, '\\' ) || str_starts_with( $path, '/' ) ) {
            return false;
        }

        return ! str_starts_with( $low, 'wp-content/' ) && ! in_array( $low, array( 'wp-config.php', 'wp-config-sample.php', 'readme.html', 'license.txt' ), true );
    }

    /**
     * Compares official checksums with the files on disk.
     *
     * @param array<string, string>        $sums   path => md5.
     * @param callable(string): ?string    $md5_of md5 of the file now, null when it does not exist.
     * @return array{modified: list<string>, missing: list<string>}
     */
    public static function core_compare( array $sums, callable $md5_of ): array {
        $modified = array();
        $missing  = array();
        foreach ( $sums as $path => $sum ) {
            $now = $md5_of( (string) $path );
            if ( null === $now ) {
                $missing[] = (string) $path;
            } elseif ( ! hash_equals( strtolower( $sum ), strtolower( $now ) ) ) {
                $modified[] = (string) $path;
            }
        }

        return array( 'modified' => $modified, 'missing' => $missing );
    }

    /**
     * Files found in wp-admin or wp-includes that WordPress does not ship. Server files that hosts and PHP put there are ignored.
     *
     * @param array<string, string> $sums  Official checksums.
     * @param list<string>          $found Paths found on disk, relative to the install folder.
     * @return list<string>
     */
    public static function core_unexpected( array $sums, array $found ): array {
        $out = array();
        foreach ( $found as $path ) {
            if ( ! isset( $sums[ $path ] ) && ! in_array( strtolower( basename( $path ) ), array( '.htaccess', '.user.ini', 'php.ini', 'error_log', '.ds_store', 'thumbs.db' ), true ) ) {
                $out[] = $path;
            }
        }
        sort( $out );

        return $out;
    }

    /** Scopes of Code Snippets, and which of them run PHP. */
    public const SNIPPET_SCOPES = array( 'global', 'admin', 'front-end', 'single-use', 'content', 'head-content', 'footer-content', 'admin-css', 'site-css', 'site-head-js', 'site-footer-js' );

    public static function snippet_scope_is_php( string $scope ): bool {
        return in_array( $scope, array( 'global', 'admin', 'front-end', 'single-use' ), true );
    }

    /** A valid scope (the default when none is given), or a clear error. */
    public static function snippet_scope( ?string $scope, string $default = 'global' ): string {
        $scope = null === $scope || '' === trim( $scope ) ? $default : strtolower( trim( $scope ) );
        if ( ! in_array( $scope, self::SNIPPET_SCOPES, true ) ) {
            throw new BridgeError( 'bad_arguments', "Unknown snippet scope \"$scope\". Scopes: " . implode( ', ', self::SNIPPET_SCOPES ) . '.', 400 );
        }

        return $scope;
    }

    /** Snippet code as the Code Snippets plugin stores it: PHP without the opening and closing tags. */
    public static function snippet_code( string $code ): string {
        $code = (string) preg_replace( '/^\s*<\?(?:php)?[ \t]*\r?\n?/i', '', $code, 1 );
        $code = (string) preg_replace( '/\?>\s*$/', '', $code, 1 );

        return trim( $code, "\r\n" ) . "\n";
    }

    /** Tags as a clean list: an array or a comma separated text. */
    public static function snippet_tags( $tags ): array {
        $list = is_array( $tags ) ? $tags : explode( ',', (string) $tags );
        $out  = array();
        foreach ( $list as $tag ) {
            $tag = trim( (string) $tag );
            if ( '' !== $tag && mb_strlen( $tag ) <= 60 && ! in_array( $tag, $out, true ) ) {
                $out[] = $tag;
            }
        }

        return array_slice( $out, 0, 20 );
    }

    /**
     * Checks the list of a files.fetch_many call: 1-25 items {url, path}, https URLs, no path used twice.
     *
     * @param mixed $items The items argument.
     * @return list<array{url: string, path: string}>
     */
    public static function fetch_plan( $items ): array {
        if ( ! is_array( $items ) || array() === $items || count( $items ) > 25 ) {
            throw new BridgeError( 'bad_arguments', 'items must be a list of 1-25 entries like {url, path}.', 400 );
        }
        $out  = array();
        $seen = array();
        foreach ( array_values( $items ) as $i => $item ) {
            $url  = is_array( $item ) ? trim( (string) ( $item['url'] ?? '' ) ) : '';
            $path = is_array( $item ) ? trim( str_replace( '\\', '/', (string) ( $item['path'] ?? '' ) ), '/' ) : '';
            if ( '' === $url || '' === $path ) {
                throw new BridgeError( 'bad_arguments', 'Item ' . ( $i + 1 ) . ' needs both url and path.', 400 );
            }
            if ( isset( $seen[ strtolower( $path ) ] ) ) {
                throw new BridgeError( 'bad_arguments', "The path \"$path\" appears twice in items.", 400 );
            }
            $seen[ strtolower( $path ) ] = true;
            $out[]                       = array( 'url' => $url, 'path' => $path );
        }

        return $out;
    }

    public static function level_for_status( string $status ): string {
        return in_array( $status, array( 'draft', 'pending', 'auto-draft', 'private', 'trash' ), true ) ? 'draft' : 'live';
    }
}
