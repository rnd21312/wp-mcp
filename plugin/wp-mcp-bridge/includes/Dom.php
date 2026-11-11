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
     * CSS selector subset → XPath. Supports tag, #id, .class, [attr], [attr=v] (also ^= $= *= ~= |=), compounds such as
     * a.btn[target=_blank], the descendant (space) and child (>) combinators, and comma lists (at most 10). Null when unsupported.
     */
    public static function xpath_for( string $selector ): ?string {
        $parts = array();
        $buf   = '';
        $depth = 0;
        $quote = '';
        foreach ( str_split( $selector ) as $ch ) {
            if ( '' !== $quote ) {
                $quote = $ch === $quote ? '' : $quote;
            } elseif ( $depth > 0 && ( '"' === $ch || "'" === $ch ) ) {
                $quote = $ch;
            } elseif ( '[' === $ch ) {
                ++$depth;
            } elseif ( ']' === $ch ) {
                --$depth;
            } elseif ( ',' === $ch && 0 === $depth ) {
                $parts[] = $buf;
                $buf     = '';
                continue;
            }
            $buf .= $ch;
        }
        $parts[] = $buf;
        if ( 0 !== $depth || '' !== $quote || count( $parts ) > 10 ) {
            return null;
        }
        $out = array();
        foreach ( $parts as $part ) {
            $expr = self::complex_xpath( $part );
            if ( null === $expr ) {
                return null;
            }
            $out[] = $expr;
        }

        return implode( ' | ', $out );
    }

    /** One selector without commas: compounds joined by spaces or ">". */
    private static function complex_xpath( string $sel ): ?string {
        $tokens = array();
        $buf    = '';
        $depth  = 0;
        $quote  = '';
        foreach ( str_split( trim( $sel ) ) as $ch ) {
            if ( '' !== $quote ) {
                $quote = $ch === $quote ? '' : $quote;
            } elseif ( $depth > 0 && ( '"' === $ch || "'" === $ch ) ) {
                $quote = $ch;
            } elseif ( '[' === $ch ) {
                ++$depth;
            } elseif ( ']' === $ch ) {
                --$depth;
            } elseif ( 0 === $depth && ( ' ' === $ch || '>' === $ch || "\t" === $ch ) ) {
                if ( '' !== $buf ) {
                    $tokens[] = $buf;
                    $buf      = '';
                }
                if ( '>' === $ch ) {
                    $tokens[] = '>';
                }
                continue;
            }
            $buf .= $ch;
        }
        if ( '' !== $buf ) {
            $tokens[] = $buf;
        }
        if ( ! $tokens || '>' === $tokens[0] || '>' === end( $tokens ) ) {
            return null;
        }
        $expr = '';
        $axis = '//';
        foreach ( $tokens as $token ) {
            if ( '>' === $token ) {
                $axis = '/';
                continue;
            }
            $compound = self::compound_xpath( $token );
            if ( null === $compound ) {
                return null;
            }
            $expr .= $axis . $compound;
            $axis  = '//';
        }

        return $expr;
    }

    /** tag#id.class[attr=value]… as one XPath step with predicates. */
    private static function compound_xpath( string $c ): ?string {
        if ( ! preg_match( '/^([a-z][a-z0-9]*|\*)?/i', $c, $m ) ) {
            return null;
        }
        $tag  = '' !== ( $m[1] ?? '' ) ? strtolower( $m[1] ) : '*';
        $expr = $tag;
        $rest = substr( $c, strlen( $m[0] ) );
        $rest = false === $rest ? '' : $rest;
        $attr_re = '/^\[\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|\'([^\']*)\'|([^\]\s]*))\s*)?\]/';
        while ( '' !== $rest ) {
            if ( preg_match( '/^#([\w-]+)/', $rest, $m ) ) {
                $expr .= '[@id="' . $m[1] . '"]';
            } elseif ( preg_match( '/^\.([\w-]+)/', $rest, $m ) ) {
                $expr .= '[contains(concat(" ", normalize-space(@class), " "), " ' . $m[1] . ' ")]';
            } elseif ( preg_match( $attr_re, $rest, $m ) ) {
                $name = strtolower( $m[1] );
                if ( '' === ( $m[2] ?? '' ) ) {
                    $expr .= '[@' . $name . ']';
                } else {
                    $value = (string) ( '' !== ( $m[3] ?? '' ) ? $m[3] : ( '' !== ( $m[4] ?? '' ) ? $m[4] : ( $m[5] ?? '' ) ) );
                    $lit   = self::xpath_literal( $value );
                    if ( null === $lit ) {
                        return null;
                    }
                    $a    = '@' . $name;
                    $expr .= '[' . match ( $m[2] ) {
                        '='  => "$a=$lit",
                        '^=' => "starts-with($a,$lit)",
                        '$=' => "substring($a,string-length($a)-string-length($lit)+1)=$lit",
                        '*=' => "contains($a,$lit)",
                        '~=' => "contains(concat(\" \",normalize-space($a),\" \"),concat(\" \",$lit,\" \"))",
                        default => "($a=$lit or starts-with($a,concat($lit,\"-\")))",
                    } . ']';
                }
            } else {
                return null;
            }
            $rest = substr( $rest, strlen( $m[0] ) );
            $rest = false === $rest ? '' : $rest;
        }

        return $expr;
    }

    /** A quoted XPath string, or null when the text holds both kinds of quote. */
    private static function xpath_literal( string $v ): ?string {
        if ( ! str_contains( $v, '"' ) ) {
            return '"' . $v . '"';
        }

        return str_contains( $v, "'" ) ? null : "'" . $v . "'";
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
