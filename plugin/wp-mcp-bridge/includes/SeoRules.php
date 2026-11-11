<?php
/**
 * Pure SEO rules for the bulk actions: alt text from file names, link extraction. No WordPress calls.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class SeoRules {

    /**
     * A readable alt text from an attachment title or file name, or '' when there is nothing meaningful (camera names such as
     * IMG_1234 or DSC00045, hashes, only digits).
     */
    public static function alt_from( string $title, string $filename ): string {
        foreach ( array( $title, $filename ) as $source ) {
            $text = (string) preg_replace( '/\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?)$/i', '', trim( $source ) );
            $text = trim( (string) preg_replace( '/[-_.]+/', ' ', $text ) );
            $text = trim( (string) preg_replace( '/\s*\b\d{2,4}x\d{2,4}\b\s*$/', '', $text ) ); // size suffix: photo-300x200
            $text = trim( (string) preg_replace( '/\s+/u', ' ', $text ) );
            if ( '' === $text || mb_strlen( $text ) < 3 ) {
                continue;
            }
            if ( 1 === preg_match( '/^(img|dsc|dscn|dscf|pxl|mvimg|screenshot|image|photo|pic|picture|wp|download|untitled|scan)(?![a-z])[\s\d]*$/i', $text ) || 1 === preg_match( '/^[\d\s]+$/', $text ) || 1 === preg_match( '/^[0-9a-f]{16,}$/i', str_replace( ' ', '', $text ) ) ) {
                continue;
            }

            return mb_substr( $text, 0, 125 );
        }

        return '';
    }

    /**
     * Absolute, fragment-free links of an HTML page (a href), for the link check. mailto:, tel:, javascript: and data: are skipped.
     *
     * @return list<array{url: string, text: string}>
     */
    public static function links_from_html( string $html, string $base ): array {
        $doc  = Dom::load( $html );
        $x    = new \DOMXPath( $doc );
        $out  = array();
        $root = wp_parse_url( $base );
        $host = (string) ( $root['host'] ?? '' );
        $sch  = (string) ( $root['scheme'] ?? 'https' );
        foreach ( $x->query( '//a[@href]' ) as $a ) {
            $href = trim( $a->getAttribute( 'href' ) );
            if ( '' === $href || '#' === $href[0] || 1 === preg_match( '/^(mailto|tel|javascript|data|sms|whatsapp):/i', $href ) ) {
                continue;
            }
            if ( str_starts_with( $href, '//' ) ) {
                $href = $sch . ':' . $href;
            } elseif ( str_starts_with( $href, '/' ) ) {
                $href = $sch . '://' . $host . ( isset( $root['port'] ) ? ':' . $root['port'] : '' ) . $href;
            } elseif ( 1 !== preg_match( '#^[a-z][a-z0-9+.-]*://#i', $href ) ) {
                $dir  = rtrim( (string) preg_replace( '#/[^/]*$#', '/', (string) ( $root['path'] ?? '/' ) ), '/' );
                $href = $sch . '://' . $host . $dir . '/' . $href;
            }
            $href = (string) preg_replace( '/#.*$/', '', $href );
            if ( 1 !== preg_match( '#^https?://#i', $href ) ) {
                continue;
            }
            if ( ! isset( $out[ $href ] ) ) {
                $out[ $href ] = array( 'url' => $href, 'text' => Dom::text( $a, 60 ) );
            }
        }

        return array_values( $out );
    }

    /** Is this URL on the given host (case-insensitive, exact)? */
    public static function same_host( string $url, string $host ): bool {
        return strtolower( (string) wp_parse_url( $url, PHP_URL_HOST ) ) === strtolower( $host );
    }

    /** Status class of a link check answer: ok, redirect, broken or unknown (no answer). */
    public static function link_state( int $status ): string {
        if ( $status >= 200 && $status < 300 ) {
            return 'ok';
        }
        if ( $status >= 300 && $status < 400 ) {
            return 'redirect';
        }
        if ( 405 === $status || 429 === $status || 999 === $status ) {
            return 'unknown'; // the server refuses HEAD or rate limits: not proof of a broken link
        }

        return $status >= 400 ? 'broken' : 'unknown';
    }
}
