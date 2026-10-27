<?php
/**
 * seo.* operations. Per-page fields go through Yoast, Rank Math or SEOPress when present, else a built-in layer.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\Dom;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Revisions;
use WPMCP\Bridge\Util;

defined( 'ABSPATH' ) || exit;

final class Seo {

    private const FIELDS = array( 'title', 'description', 'canonical', 'noindex', 'nofollow', 'og_title', 'og_description', 'og_image', 'focus_keyword' );

    private const KEYS = array(
        'yoast'    => array( 'title' => '_yoast_wpseo_title', 'description' => '_yoast_wpseo_metadesc', 'canonical' => '_yoast_wpseo_canonical', 'noindex' => '_yoast_wpseo_meta-robots-noindex', 'nofollow' => '_yoast_wpseo_meta-robots-nofollow', 'og_title' => '_yoast_wpseo_opengraph-title', 'og_description' => '_yoast_wpseo_opengraph-description', 'og_image' => '_yoast_wpseo_opengraph-image', 'focus_keyword' => '_yoast_wpseo_focuskw' ),
        'rankmath' => array( 'title' => 'rank_math_title', 'description' => 'rank_math_description', 'canonical' => 'rank_math_canonical_url', 'noindex' => 'rank_math_robots', 'nofollow' => 'rank_math_robots', 'og_title' => 'rank_math_facebook_title', 'og_description' => 'rank_math_facebook_description', 'og_image' => 'rank_math_facebook_image', 'focus_keyword' => 'rank_math_focus_keyword' ),
        'seopress' => array( 'title' => '_seopress_titles_title', 'description' => '_seopress_titles_desc', 'canonical' => '_seopress_robots_canonical', 'noindex' => '_seopress_robots_index', 'nofollow' => '_seopress_robots_follow', 'og_title' => '_seopress_social_fb_title', 'og_description' => '_seopress_social_fb_desc', 'og_image' => '_seopress_social_fb_img', 'focus_keyword' => '_seopress_analysis_target_kw' ),
        'native'   => array( 'title' => '_wpm_seo_title', 'description' => '_wpm_seo_description', 'canonical' => '_wpm_seo_canonical', 'noindex' => '_wpm_seo_noindex', 'nofollow' => '_wpm_seo_nofollow', 'og_title' => '_wpm_seo_og_title', 'og_description' => '_wpm_seo_og_description', 'og_image' => '_wpm_seo_og_image', 'focus_keyword' => '_wpm_seo_focus' ),
    );

    public static function provider(): string {
        if ( defined( 'WPSEO_VERSION' ) ) {
            return 'yoast';
        }
        if ( defined( 'RANK_MATH_VERSION' ) || class_exists( 'RankMath' ) ) {
            return 'rankmath';
        }
        if ( defined( 'SEOPRESS_VERSION' ) ) {
            return 'seopress';
        }
        if ( defined( 'AIOSEO_VERSION' ) ) {
            return 'aioseo';
        }

        return 'native';
    }

    /**
     * @return array<string, mixed>
     */
    public static function read( int $id ): array {
        $provider = self::provider();
        if ( 'aioseo' === $provider ) {
            return array( 'provider' => 'aioseo', 'note' => 'All in One SEO keeps its data in its own table. Use rest.call or the plugin screen.' );
        }
        $keys = self::KEYS[ $provider ];
        $out  = array( 'provider' => $provider );
        foreach ( self::FIELDS as $field ) {
            $raw = get_post_meta( $id, $keys[ $field ], true );
            if ( 'noindex' === $field || 'nofollow' === $field ) {
                $raw = self::robot_flag( $provider, $field, $raw );
            }
            $out[ $field ] = $raw;
        }

        return $out;
    }

    /** @param mixed $raw Stored value. */
    private static function robot_flag( string $provider, string $field, $raw ): bool {
        switch ( $provider ) {
            case 'yoast':
                return '1' === (string) $raw;
            case 'rankmath':
                return in_array( $field, (array) $raw, true );
            case 'seopress':
                return 'yes' === (string) $raw;
            default:
                return '1' === (string) $raw;
        }
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_get( array $a, Context $c ): array {
        $post = Util::find_post( $a['id'] ?? '' );
        if ( ! $post ) {
            throw new BridgeError( 'not_found', 'No such item.', 404 );
        }
        $c->need( Util::read_level( $post ) );

        return array( 'id' => $post->ID, 'title_of_page' => get_the_title( $post ), 'seo' => self::read( $post->ID ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_set( array $a, Context $c ): array {
        $post = get_post( (int) $a['id'] );
        if ( ! $post || in_array( $post->post_type, array( 'revision', 'nav_menu_item' ), true ) ) {
            throw new BridgeError( 'not_found', 'No such item.', 404 );
        }
        $c->need( Policy::level_for_status( $post->post_status ), 'SEO of published pages needs live level.' );
        $provider = self::provider();
        if ( 'aioseo' === $provider ) {
            throw new BridgeError( 'unsupported_provider', 'All in One SEO stores SEO data in its own table; the bridge cannot write it safely. Use the plugin screen or rest.call.', 400 );
        }
        $keys   = self::KEYS[ $provider ];
        $before = Revisions::snap_post( $post->ID );
        $set    = array();
        foreach ( self::FIELDS as $field ) {
            if ( ! array_key_exists( $field, $a ) ) {
                continue;
            }
            $value = $a[ $field ];
            if ( 'noindex' === $field || 'nofollow' === $field ) {
                self::write_flag( $provider, $post->ID, $field, (bool) $value, $keys[ $field ] );
            } else {
                $value = in_array( $field, array( 'canonical', 'og_image' ), true ) ? esc_url_raw( (string) $value ) : sanitize_text_field( (string) $value );
                '' === $value ? delete_post_meta( $post->ID, $keys[ $field ] ) : update_post_meta( $post->ID, $keys[ $field ], wp_slash( $value ) );
            }
            $set[] = $field;
        }
        if ( 'yoast' === $provider && $set ) {
            wp_update_post( array( 'ID' => $post->ID ) ); // Lets Yoast refresh its index for this page.
        }
        Revisions::record( $c, 'post', (string) $post->ID, $before );
        $c->summary = "seo on #{$post->ID} via $provider: " . implode( ',', $set );

        return array( 'id' => $post->ID, 'provider' => $provider, 'updated' => $set, 'seo' => self::read( $post->ID ) );
    }

    private static function write_flag( string $provider, int $id, string $field, bool $on, string $key ): void {
        switch ( $provider ) {
            case 'yoast':
                'noindex' === $field ? update_post_meta( $id, $key, $on ? '1' : '2' ) : update_post_meta( $id, $key, $on ? '1' : '0' );
                break;
            case 'rankmath':
                $robots = array_values( array_diff( (array) get_post_meta( $id, $key, true ), array( 'noindex', 'nofollow', 'index', 'follow' ) ) );
                $now    = array( 'noindex' => self::robot_flag( $provider, 'noindex', get_post_meta( $id, $key, true ) ), 'nofollow' => self::robot_flag( $provider, 'nofollow', get_post_meta( $id, $key, true ) ) );
                $now[ $field ] = $on;
                foreach ( $now as $name => $flag ) {
                    if ( $flag ) {
                        $robots[] = $name;
                    }
                }
                update_post_meta( $id, $key, array_values( array_unique( $robots ) ) );
                break;
            case 'seopress':
                $on ? update_post_meta( $id, $key, 'yes' ) : delete_post_meta( $id, $key );
                break;
            default:
                $on ? update_post_meta( $id, $key, '1' ) : delete_post_meta( $id, $key );
        }
    }

    /* ------------------------------------------------------------------ audit */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_audit( array $a, Context $c ): array {
        if ( ! empty( $a['id'] ) ) {
            $post = get_post( (int) $a['id'] );
            if ( ! $post || 'publish' !== $post->post_status ) {
                throw new BridgeError( 'not_public', 'Only published pages can be audited (the audit reads what visitors get).', 400 );
            }
            $url = (string) get_permalink( $post );
        } else {
            $url = Util::own_url( (string) ( $a['path'] ?? '/' ) );
        }
        $page   = Util::fetch_own( $url );
        $issues = array();
        $add    = static function ( string $sev, string $issue, string $fix ) use ( &$issues ): void {
            $issues[] = array( 'severity' => $sev, 'issue' => $issue, 'fix' => $fix );
        };
        if ( 200 !== $page['status'] ) {
            $add( 'high', 'The page answers HTTP ' . $page['status'] . '.', $page['status'] >= 300 && $page['status'] < 400 ? 'It redirects to ' . ( $page['headers']['location'] ?? '?' ) . '; audit the final URL.' : 'Fix the page so it returns 200.' );

            return array( 'url' => $url, 'status' => $page['status'], 'score' => 0, 'issues' => $issues );
        }
        $doc = Dom::load( $page['body'] );
        $x   = new \DOMXPath( $doc );

        $title = Dom::text( $x->query( '//title' )->item( 0 ), 300 );
        $len   = mb_strlen( $title );
        if ( '' === $title ) {
            $add( 'high', 'No <title>.', 'seo.set title (50-60 characters, main keyword first).' );
        } elseif ( $len < 25 || $len > 65 ) {
            $add( 'medium', "Title is $len characters.", 'Aim for 30-60 so it is not cut in results.' );
        }
        $desc = Dom::meta( $x, 'name', 'description' );
        if ( '' === $desc ) {
            $add( 'high', 'No meta description.', 'seo.set description (120-155 characters, a reason to click).' );
        } elseif ( mb_strlen( $desc ) < 70 || mb_strlen( $desc ) > 165 ) {
            $add( 'low', 'Meta description is ' . mb_strlen( $desc ) . ' characters.', 'Aim for 120-155.' );
        }
        $h1 = $x->query( '//h1' )->length;
        if ( 0 === $h1 ) {
            $add( 'high', 'No <h1>.', 'Use exactly one h1 that names the topic.' );
        } elseif ( $h1 > 1 ) {
            $add( 'medium', "$h1 <h1> elements.", 'Keep one h1; demote the others to h2.' );
        }
        $last = 0;
        foreach ( $x->query( '//h1|//h2|//h3|//h4|//h5|//h6' ) as $h ) {
            $lvl = (int) substr( $h->nodeName, 1 );
            if ( $last && $lvl > $last + 1 ) {
                $add( 'low', 'Heading levels skip (h' . $last . ' to h' . $lvl . ').', 'Do not skip levels.' );
                break;
            }
            $last = $lvl;
        }
        $imgs = $x->query( '//img' );
        $miss = 0;
        foreach ( $imgs as $img ) {
            if ( ! $img->hasAttribute( 'alt' ) || '' === trim( $img->getAttribute( 'alt' ) ) ) {
                ++$miss;
            }
        }
        if ( $miss ) {
            $add( 'medium', "$miss of {$imgs->length} images have no alt text.", 'media.update alt for each image (decorative images may stay empty).' );
        }
        $canon = $x->query( '//link[@rel="canonical"]/@href' );
        if ( 0 === $canon->length ) {
            $add( 'medium', 'No canonical link.', 'seo.set canonical, or check the SEO plugin.' );
        }
        $robots = strtolower( Dom::meta( $x, 'name', 'robots' ) . ' ' . ( $page['headers']['x-robots-tag'] ?? '' ) );
        if ( str_contains( $robots, 'noindex' ) ) {
            $add( 'high', 'The page is set to noindex.', 'If unintended: seo.set noindex=false and check Settings, Reading.' );
        }
        foreach ( array( 'og:title', 'og:description', 'og:image' ) as $prop ) {
            if ( '' === Dom::meta( $x, 'property', $prop ) ) {
                $add( 'low', "Missing $prop.", 'Set Open Graph fields with seo.set.' );
            }
        }
        if ( '' === Dom::meta( $x, 'name', 'viewport' ) ) {
            $add( 'high', 'No viewport meta (not mobile friendly).', 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> in the theme header.' );
        }
        $lang = $x->query( '//html/@lang' );
        if ( 0 === $lang->length ) {
            $add( 'low', 'No lang attribute on <html>.', 'Use language_attributes() in the theme.' );
        }
        $ld = $x->query( '//script[@type="application/ld+json"]' );
        if ( 0 === $ld->length ) {
            $add( 'low', 'No structured data (JSON-LD).', 'seo.schema_set (Article, Product, LocalBusiness, FAQ…).' );
        }
        $words = str_word_count( preg_replace( '/\s+/', ' ', wp_strip_all_tags( preg_replace( '#<(script|style)[^>]*>.*?</\1>#is', '', $page['body'] ) ) ) );
        if ( $words < 250 ) {
            $add( 'low', "Only about $words words of text.", 'Thin pages rank poorly unless the intent is brief.' );
        }
        $home = strtolower( (string) wp_parse_url( home_url(), PHP_URL_HOST ) );
        $int  = 0;
        $ext  = 0;
        $emp  = 0;
        foreach ( $x->query( '//a[@href]' ) as $link ) {
            $host = strtolower( (string) wp_parse_url( $link->getAttribute( 'href' ), PHP_URL_HOST ) );
            '' === $host || $host === $home ? ++$int : ++$ext;
            if ( '' === Dom::text( $link, 5 ) && 0 === $link->getElementsByTagName( 'img' )->length && ! $link->hasAttribute( 'aria-label' ) ) {
                ++$emp;
            }
        }
        if ( $emp ) {
            $add( 'low', "$emp links have no text or label.", 'Give links descriptive text or aria-label.' );
        }
        if ( 0 === $int ) {
            $add( 'low', 'No internal links.', 'Link to related pages.' );
        }
        if ( strlen( $page['body'] ) > 1500000 ) {
            $add( 'medium', 'HTML is over 1.5 MB.', 'Reduce inline CSS/JS and page builder bloat.' );
        }

        $penalty = array( 'high' => 18, 'medium' => 8, 'low' => 3 );
        $score   = 100;
        foreach ( $issues as $i ) {
            $score -= $penalty[ $i['severity'] ];
        }

        return array(
            'url'     => $url,
            'status'  => 200,
            'score'   => max( 0, $score ),
            'title'   => $title,
            'description' => $desc,
            'facts'   => array( 'h1' => $h1, 'images' => $imgs->length, 'images_without_alt' => $miss, 'internal_links' => $int, 'external_links' => $ext, 'json_ld_blocks' => $ld->length, 'words' => $words, 'html_bytes' => strlen( $page['body'] ), 'provider' => self::provider() ),
            'issues'  => $issues,
        );
    }

    /* ------------------------------------------------------------------- site */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_site_get( array $a, Context $c ): array {
        return array(
            'provider'          => self::provider(),
            'search_visibility' => get_option( 'blog_public' ) ? 'visible' : 'HIDDEN from search engines (Settings, Reading)',
            'robots_txt_custom' => (string) get_option( 'wpm_robots_txt', '' ),
            'robots_txt_url'    => home_url( '/robots.txt' ),
            'sitemap'           => self::sitemap_info(),
            'site'              => (array) get_option( 'wpm_seo_site', array() ),
            'permalinks'        => (string) get_option( 'permalink_structure' ) ?: 'plain (not SEO friendly)',
        );
    }

    /** @return array<string, mixed> */
    private static function sitemap_info(): array {
        $provider = self::provider();
        $path     = array( 'yoast' => '/sitemap_index.xml', 'rankmath' => '/sitemap_index.xml', 'seopress' => '/sitemaps.xml', 'aioseo' => '/sitemap.xml' )[ $provider ] ?? '/wp-sitemap.xml';

        return array( 'url' => home_url( $path ), 'by' => 'native' === $provider ? 'WordPress core' : $provider, 'core_enabled' => 'off' !== get_option( 'wpm_sitemap', 'default' ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_site_set( array $a, Context $c ): array {
        if ( array_key_exists( 'blog_public', $a ) ) {
            $c->need( 'admin', 'Changing search visibility affects the whole site.' );
        }
        $before = array_map( array( Revisions::class, 'snap_option' ), array( 'wpm_robots_txt', 'wpm_seo_site', 'blog_public' ) );
        if ( isset( $a['robots_txt'] ) ) {
            $text = (string) $a['robots_txt'];
            if ( strlen( $text ) > 20000 || str_contains( $text, '<' ) ) {
                throw new BridgeError( 'bad_robots', 'robots.txt must be plain text under 20 KB.', 400 );
            }
            '' === trim( $text ) ? delete_option( 'wpm_robots_txt' ) : update_option( 'wpm_robots_txt', $text, false );
        }
        $site = (array) get_option( 'wpm_seo_site', array() );
        foreach ( array( 'org_name' => 'sanitize_text_field', 'org_logo' => 'esc_url_raw', 'title_separator' => 'sanitize_text_field', 'default_og_image' => 'esc_url_raw' ) as $key => $fn ) {
            if ( isset( $a[ $key ] ) ) {
                $site[ $key ] = $fn( (string) $a[ $key ] );
            }
        }
        if ( isset( $a['org_same_as'] ) ) {
            $site['org_same_as'] = array_values( array_filter( array_map( 'esc_url_raw', array_map( 'strval', (array) $a['org_same_as'] ) ) ) );
        }
        update_option( 'wpm_seo_site', $site, false );
        if ( array_key_exists( 'blog_public', $a ) ) {
            update_option( 'blog_public', $a['blog_public'] ? 1 : 0 );
        }
        Revisions::record( $c, 'options', 'seo_site', $before );
        $c->summary = 'site-wide SEO changed';

        return self::op_site_get( array(), $c );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_sitemap( array $a, Context $c ): array {
        if ( array_key_exists( 'enable', $a ) ) {
            $c->need( 'live' );
            $before = Revisions::snap_option( 'wpm_sitemap' );
            update_option( 'wpm_sitemap', $a['enable'] ? 'default' : 'off', false );
            Revisions::record( $c, 'options', 'sitemap', array( $before ) );
        }
        $info = self::sitemap_info();
        try {
            $res          = Util::fetch_own( (string) $info['url'] );
            $info['http'] = $res['status'];
            if ( 200 === $res['status'] ) {
                $info['entries_in_index'] = preg_match_all( '#<loc>#', substr( $res['body'], 0, 2000000 ) );
            }
        } catch ( BridgeError $e ) {
            $info['http'] = null;
        }

        return $info;
    }

    /* -------------------------------------------------------------- redirects */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_redirects_list( array $a, Context $c ): array {
        [ $page, $per ] = Util::paging( $a );
        $all            = array_values( (array) get_option( 'wpm_redirects', array() ) );

        return array( 'total' => count( $all ), 'redirects' => array_slice( $all, ( $page - 1 ) * $per, $per ), 'page' => $page );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_redirect_save( array $a, Context $c ): array {
        $code  = (int) ( $a['code'] ?? 301 );
        $regex = ! empty( $a['regex'] );
        $from  = trim( (string) $a['from'] );
        $to    = trim( (string) $a['to'] );
        if ( ! in_array( $code, array( 301, 302, 307, 308, 410, 451 ), true ) ) {
            throw new BridgeError( 'bad_code', 'code must be 301, 302, 307, 308, 410 or 451.', 400 );
        }
        if ( '' === $from || strlen( $from ) > 300 || ( ! $regex && ! str_starts_with( $from, '/' ) ) ) {
            throw new BridgeError( 'bad_from', 'from must be a path starting with / (or a regex when regex=true).', 400 );
        }
        if ( $regex && false === @preg_match( '#' . str_replace( '#', '\#', $from ) . '#i', '' ) ) { // phpcs:ignore WordPress.PHP.NoSilencedErrors
            throw new BridgeError( 'bad_regex', 'from is not a valid regular expression.', 400 );
        }
        if ( ! in_array( $code, array( 410, 451 ), true ) ) {
            if ( '' === $to || ! ( str_starts_with( $to, '/' ) || str_starts_with( $to, 'https://' ) || str_starts_with( $to, 'http://' ) ) ) {
                throw new BridgeError( 'bad_to', 'to must be a path starting with / or a full http(s) URL.', 400 );
            }
            if ( ! $regex && strtolower( rtrim( $from, '/' ) ) === strtolower( rtrim( $to, '/' ) ) ) {
                throw new BridgeError( 'loop', 'from and to are the same, which would loop.', 400 );
            }
            if ( ! $regex && str_starts_with( $to, '/' ) ) {
                foreach ( (array) get_option( 'wpm_redirects', array() ) as $rule ) {
                    if ( empty( $rule['regex'] ) && strtolower( rtrim( (string) $rule['from'], '/' ) ) === strtolower( rtrim( $to, '/' ) ) && strtolower( rtrim( (string) $rule['to'], '/' ) ) === strtolower( rtrim( $from, '/' ) ) ) {
                        throw new BridgeError( 'loop', 'There is already a redirect back from the target; this would loop.', 400 );
                    }
                }
            }
        }
        $rules = array_values( (array) get_option( 'wpm_redirects', array() ) );
        $key   = null;
        foreach ( $rules as $i => $rule ) {
            if ( (string) $rule['from'] === $from ) {
                $key = $i;
            }
        }
        if ( null === $key && count( $rules ) >= 1000 ) {
            throw new BridgeError( 'too_many', 'At most 1000 redirects.', 400 );
        }
        $before = Revisions::snap_option( 'wpm_redirects' );
        $entry  = array( 'from' => $from, 'to' => in_array( $code, array( 410, 451 ), true ) ? '' : $to, 'code' => $code, 'regex' => $regex );
        null === $key ? $rules[] = $entry : $rules[ $key ] = $entry;
        update_option( 'wpm_redirects', $rules, false );
        Revisions::record( $c, 'options', 'redirects', array( $before ) );
        $c->summary = "redirect $from → " . ( '' === $entry['to'] ? $code : $to );

        return array( 'saved' => $entry, 'total' => count( $rules ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_redirect_delete( array $a, Context $c ): array {
        $rules = array_values( (array) get_option( 'wpm_redirects', array() ) );
        $left  = array_values( array_filter( $rules, static fn ( $r ) => (string) $r['from'] !== (string) $a['from'] ) );
        if ( count( $left ) === count( $rules ) ) {
            throw new BridgeError( 'not_found', 'No redirect with that from value.', 404 );
        }
        $before = Revisions::snap_option( 'wpm_redirects' );
        update_option( 'wpm_redirects', $left, false );
        Revisions::record( $c, 'options', 'redirects', array( $before ) );
        $c->summary = 'removed redirect ' . $a['from'];

        return array( 'removed' => $a['from'], 'total' => count( $left ) );
    }

    /* ----------------------------------------------------------------- schema */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_schema_get( array $a, Context $c ): array {
        $post = get_post( (int) $a['id'] );
        if ( ! $post ) {
            throw new BridgeError( 'not_found', 'No such item.', 404 );
        }
        $c->need( Util::read_level( $post ) );
        $raw = (string) get_post_meta( $post->ID, '_wpm_schema', true );

        return array( 'id' => $post->ID, 'json_ld' => '' === $raw ? null : json_decode( $raw, true ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_schema_set( array $a, Context $c ): array {
        $post = get_post( (int) $a['id'] );
        if ( ! $post ) {
            throw new BridgeError( 'not_found', 'No such item.', 404 );
        }
        $json = $a['json'];
        if ( is_string( $json ) ) {
            $json = '' === trim( $json ) ? null : json_decode( $json, true );
            if ( null === $json && '' !== trim( (string) $a['json'] ) ) {
                throw new BridgeError( 'bad_json', 'json is not valid JSON.', 400 );
            }
        }
        $before = Revisions::snap_post( $post->ID );
        if ( empty( $json ) ) {
            delete_post_meta( $post->ID, '_wpm_schema' );
            $state = 'removed';
        } else {
            if ( ! is_array( $json ) || ( ! isset( $json['@context'] ) && ! isset( $json['@graph'] ) && ! isset( $json[0] ) ) ) {
                throw new BridgeError( 'bad_schema', 'JSON-LD needs an @context (or @graph), e.g. {"@context":"https://schema.org","@type":"Article",…}.', 400 );
            }
            $encoded = (string) wp_json_encode( $json, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
            if ( strlen( $encoded ) > 50000 ) {
                throw new BridgeError( 'too_large', 'JSON-LD is larger than 50 KB.', 400 );
            }
            update_post_meta( $post->ID, '_wpm_schema', wp_slash( $encoded ) );
            $state = 'saved';
        }
        Revisions::record( $c, 'post', (string) $post->ID, $before );
        $c->summary = "schema $state on #{$post->ID}";

        return array( 'id' => $post->ID, 'schema' => $state );
    }
}
