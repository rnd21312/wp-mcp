<?php
/**
 * inspect.* operations: what visitors actually get.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\Dom;
use WPMCP\Bridge\Util;

defined( 'ABSPATH' ) || exit;

final class Inspect {

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_page( array $a, Context $c ): array {
        $url  = Util::own_url( (string) $a['path'] );
        $page = Util::fetch_own( $url );
        $max  = max( 1000, min( 200000, (int) ( $a['max_bytes'] ?? 60000 ) ) );
        $off  = max( 0, (int) ( $a['offset'] ?? 0 ) );
        $html = substr( $page['body'], $off, $max );

        return array( 'url' => $url, 'status' => $page['status'], 'headers' => $page['headers'], 'total_bytes' => strlen( $page['body'] ), 'offset' => $off, 'truncated' => $off + strlen( $html ) < strlen( $page['body'] ), 'html' => $html );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_render( array $a, Context $c ): array {
        $post = get_post( (int) $a['id'] );
        if ( ! $post ) {
            throw new BridgeError( 'not_found', 'No such item.', 404 );
        }
        global $wp_query;
        $GLOBALS['post'] = $post; // phpcs:ignore WordPress.WP.GlobalVariablesOverride
        setup_postdata( $post );
        $html = (string) apply_filters( 'the_content', $post->post_content ); // phpcs:ignore WordPress.NamingConventions
        wp_reset_postdata();
        $max = max( 1000, min( 200000, (int) ( $a['max_bytes'] ?? 60000 ) ) );

        return array( 'id' => $post->ID, 'status' => $post->post_status, 'total_bytes' => strlen( $html ), 'truncated' => strlen( $html ) > $max, 'html' => substr( $html, 0, $max ), 'note' => 'Rendered content only, without header, footer or theme CSS.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_outline( array $a, Context $c ): array {
        $url  = Util::own_url( (string) $a['path'] );
        $page = Util::fetch_own( $url );
        $doc  = Dom::load( $page['body'] );
        $x    = new \DOMXPath( $doc );

        $headings = array();
        foreach ( $x->query( '//h1|//h2|//h3|//h4|//h5|//h6' ) as $h ) {
            if ( count( $headings ) < 80 ) {
                $headings[] = array( 'level' => (int) substr( $h->nodeName, 1 ), 'text' => Dom::text( $h, 120 ) );
            }
        }
        $images = array();
        $noalt  = 0;
        foreach ( $x->query( '//img' ) as $i => $img ) {
            if ( '' === trim( $img->getAttribute( 'alt' ) ) ) {
                ++$noalt;
            }
            if ( $i < 30 ) {
                $images[] = array( 'src' => $img->getAttribute( 'src' ) ?: $img->getAttribute( 'data-src' ), 'alt' => $img->getAttribute( 'alt' ), 'w' => $img->getAttribute( 'width' ), 'h' => $img->getAttribute( 'height' ), 'loading' => $img->getAttribute( 'loading' ) );
            }
        }
        $home  = strtolower( (string) wp_parse_url( home_url(), PHP_URL_HOST ) );
        $links = array();
        $count = array( 'internal' => 0, 'external' => 0 );
        foreach ( $x->query( '//a[@href]' ) as $link ) {
            $href = $link->getAttribute( 'href' );
            $host = strtolower( (string) wp_parse_url( $href, PHP_URL_HOST ) );
            $kind = '' === $host || $host === $home ? 'internal' : 'external';
            ++$count[ $kind ];
            if ( count( $links ) < 40 ) {
                $links[] = array( 'href' => $href, 'text' => Dom::text( $link, 60 ), 'kind' => $kind );
            }
        }
        $forms = array();
        foreach ( $x->query( '//form' ) as $f ) {
            $forms[] = array( 'action' => $f->getAttribute( 'action' ), 'method' => strtolower( $f->getAttribute( 'method' ) ?: 'get' ), 'fields' => $f->getElementsByTagName( 'input' )->length + $f->getElementsByTagName( 'textarea' )->length + $f->getElementsByTagName( 'select' )->length );
        }
        $scripts = array();
        foreach ( $x->query( '//script[@src]' ) as $s ) {
            if ( count( $scripts ) < 25 ) {
                $scripts[] = $s->getAttribute( 'src' );
            }
        }
        $styles = array();
        foreach ( $x->query( '//link[@rel="stylesheet"]' ) as $l ) {
            $styles[] = $l->getAttribute( 'href' );
        }
        $landmarks = array();
        foreach ( array( 'header', 'nav', 'main', 'aside', 'footer' ) as $tag ) {
            $landmarks[ $tag ] = $x->query( "//$tag" )->length;
        }

        $out = array(
            'url'       => $url,
            'status'    => $page['status'],
            'lang'      => (string) ( $x->query( '//html/@lang' )->item( 0 )->nodeValue ?? '' ),
            'title'     => Dom::text( $x->query( '//title' )->item( 0 ), 200 ),
            'meta'      => array( 'description' => Dom::meta( $x, 'name', 'description' ), 'robots' => Dom::meta( $x, 'name', 'robots' ), 'viewport' => Dom::meta( $x, 'name', 'viewport' ), 'og:title' => Dom::meta( $x, 'property', 'og:title' ), 'og:image' => Dom::meta( $x, 'property', 'og:image' ), 'canonical' => (string) ( $x->query( '//link[@rel="canonical"]/@href' )->item( 0 )->nodeValue ?? '' ) ),
            'headings'  => $headings,
            'landmarks' => $landmarks,
            'images'    => array( 'total' => $x->query( '//img' )->length, 'without_alt' => $noalt, 'list' => $images ),
            'links'     => $count + array( 'list' => $links ),
            'forms'     => $forms,
            'scripts'   => $scripts,
            'stylesheets' => $styles,
        );

        $root = $x->query( '//body' )->item( 0 );
        if ( ! empty( $a['selector'] ) ) {
            $expr = Dom::xpath_for( (string) $a['selector'] );
            if ( null === $expr ) {
                throw new BridgeError( 'bad_selector', 'Supported selectors: #id, .class, tag, tag.class, tag#id.class.', 400 );
            }
            $found = $x->query( $expr );
            if ( ! $found || 0 === $found->length ) {
                throw new BridgeError( 'not_found', 'No element matches ' . $a['selector'] . '.', 404 );
            }
            $root                = $found->item( 0 );
            $out['selector_matches'] = $found->length;
        }
        if ( $root instanceof \DOMElement ) {
            $budget       = array( 'n' => 400 );
            $out['tree']  = Dom::tree( $root, max( 1, min( 8, (int) ( $a['depth'] ?? 4 ) ) ), $budget );
            if ( ! empty( $a['selector'] ) ) {
                $out['outer_html'] = substr( $doc->saveHTML( $root ) ?: '', 0, 6000 );
            }
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_styles( array $a, Context $c ): array {
        if ( ! empty( $a['css_url'] ) ) {
            $url  = Util::own_url( (string) $a['css_url'] );
            $page = Util::fetch_own( $url );
            $off  = max( 0, (int) ( $a['offset'] ?? 0 ) );
            $max  = max( 1000, min( 200000, (int) ( $a['max_bytes'] ?? 60000 ) ) );
            $css  = substr( $page['body'], $off, $max );

            return array( 'url' => $url, 'status' => $page['status'], 'total_bytes' => strlen( $page['body'] ), 'offset' => $off, 'truncated' => $off + strlen( $css ) < strlen( $page['body'] ), 'css' => $css );
        }
        $page = Util::fetch_own( Util::own_url( (string) ( $a['path'] ?? '/' ) ) );
        $doc  = Dom::load( $page['body'] );
        $x    = new \DOMXPath( $doc );
        $links = array();
        foreach ( $x->query( '//link[@rel="stylesheet"]' ) as $l ) {
            $links[] = array( 'href' => $l->getAttribute( 'href' ), 'media' => $l->getAttribute( 'media' ) ?: 'all', 'id' => $l->getAttribute( 'id' ) );
        }
        $inline = array();
        foreach ( $x->query( '//style' ) as $s ) {
            if ( count( $inline ) < 10 ) {
                $inline[] = array( 'id' => $s->getAttribute( 'id' ), 'bytes' => strlen( $s->textContent ), 'start' => substr( trim( $s->textContent ), 0, 400 ) );
            }
        }

        return array( 'stylesheets' => $links, 'inline_styles' => $inline, 'hint' => 'Pass css_url to read one local stylesheet. Our own CSS sections are in design.css_get.' );
    }
}
