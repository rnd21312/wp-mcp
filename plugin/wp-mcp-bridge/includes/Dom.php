<?php
/**
 * HTML parsing helpers for the inspect and audit tools.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class Dom {

    public static function load( string $html ): \DOMDocument {
        $doc = new \DOMDocument();
        $prev = libxml_use_internal_errors( true );
        $doc->loadHTML( '<?xml encoding="utf-8" ?>' . $html, LIBXML_NOWARNING | LIBXML_NOERROR | LIBXML_COMPACT );
        libxml_clear_errors();
        libxml_use_internal_errors( $prev );

        return $doc;
    }

    public static function text( ?\DOMNode $node, int $max = 140 ): string {
        if ( ! $node ) {
            return '';
        }
        $text = trim( (string) preg_replace( '/\s+/u', ' ', $node->textContent ) );

        return mb_strlen( $text ) > $max ? mb_substr( $text, 0, $max ) . '…' : $text;
    }

    public static function meta( \DOMXPath $x, string $attr, string $name ): string {
        $n = $x->query( sprintf( '//meta[@%s="%s"]/@content', $attr, $name ) );

        return $n && $n->length ? trim( $n->item( 0 )->nodeValue ) : '';
    }

    /**
     * Short selector → XPath: #id, .class, tag, tag.class, tag#id.
     */
    public static function xpath_for( string $selector ): ?string {
        if ( ! preg_match( '/^([a-z][a-z0-9]*)?(#[\w-]+)?((?:\.[\w-]+)*)$/i', trim( $selector ), $m ) || '' === trim( $selector ) ) {
            return null;
        }
        $tag  = '' !== ( $m[1] ?? '' ) ? strtolower( $m[1] ) : '*';
        $expr = '//' . $tag;
        if ( ! empty( $m[2] ) ) {
            $expr .= '[@id="' . substr( $m[2], 1 ) . '"]';
        }
        foreach ( array_filter( explode( '.', (string) ( $m[3] ?? '' ) ) ) as $class ) {
            $expr .= '[contains(concat(" ", normalize-space(@class), " "), " ' . $class . ' ")]';
        }

        return $expr;
    }

    /**
     * Element tree with tag#id.class labels, bounded by depth and node count.
     *
     * @param array<string, int> $budget Remaining nodes, by reference.
     * @return array<string, mixed>
     */
    public static function tree( \DOMElement $el, int $depth, array &$budget ): array {
        --$budget['n'];
        $label = strtolower( $el->nodeName );
        if ( $el->hasAttribute( 'id' ) ) {
            $label .= '#' . $el->getAttribute( 'id' );
        }
        if ( $el->hasAttribute( 'class' ) ) {
            $label .= '.' . implode( '.', array_slice( preg_split( '/\s+/', trim( $el->getAttribute( 'class' ) ) ) ?: array(), 0, 4 ) );
        }
        $node = array( 'el' => $label );
        $kids = array();
        foreach ( $el->childNodes as $child ) {
            if ( $child instanceof \DOMElement && ! in_array( strtolower( $child->nodeName ), array( 'script', 'style', 'noscript', 'svg', 'path', 'link', 'meta' ), true ) ) {
                $kids[] = $child;
            }
        }
        if ( 0 === count( $kids ) ) {
            $text = self::text( $el, 60 );
            if ( '' !== $text ) {
                $node['text'] = $text;
            }

            return $node;
        }
        if ( $depth <= 0 ) {
            $node['children'] = count( $kids );

            return $node;
        }
        $node['kids'] = array();
        foreach ( $kids as $kid ) {
            if ( $budget['n'] <= 0 ) {
                $node['kids'][] = array( 'el' => '…truncated' );
                break;
            }
            $node['kids'][] = self::tree( $kid, $depth - 1, $budget );
        }

        return $node;
    }
}
