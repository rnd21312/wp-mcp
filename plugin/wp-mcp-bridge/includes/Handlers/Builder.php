<?php
/**
 * builder.* operations: read and edit pages made with Elementor, Bricks, Divi, WPBakery, Avada, Beaver Builder or Breakdance.
 *
 * Elementor and Bricks keep a JSON element tree in post meta and get element-level editing.
 * Divi, WPBakery and Avada keep shortcodes in post_content and are read/written as text.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\Revisions;
use WPMCP\Bridge\Util;

defined( 'ABSPATH' ) || exit;

final class Builder {

    /** @return array<string, bool> builder => plugin/theme active. */
    public static function active(): array {
        $theme = get_template();

        return array(
            'elementor'  => defined( 'ELEMENTOR_VERSION' ),
            'bricks'     => defined( 'BRICKS_VERSION' ) || 'bricks' === $theme,
            'divi'       => defined( 'ET_BUILDER_VERSION' ) || 'Divi' === $theme,
            'wpbakery'   => defined( 'WPB_VC_VERSION' ),
            'avada'      => class_exists( 'FusionBuilder' ) || 'Avada' === $theme,
            'beaver'     => class_exists( 'FLBuilder' ),
            'breakdance' => defined( '__BREAKDANCE_VERSION' ),
            'gutenberg'  => true,
        );
    }

    /** Which builder made this post. */
    private static function used_by( \WP_Post $p ): string {
        if ( 'builder' === get_post_meta( $p->ID, '_elementor_edit_mode', true ) ) {
            return 'elementor';
        }
        if ( 'bricks' === get_post_meta( $p->ID, '_bricks_editor_mode', true ) || get_post_meta( $p->ID, '_bricks_page_content_2', true ) ) {
            return 'bricks';
        }
        if ( get_post_meta( $p->ID, '_fl_builder_enabled', true ) ) {
            return 'beaver';
        }
        if ( get_post_meta( $p->ID, '_breakdance_data', true ) ) {
            return 'breakdance';
        }
        if ( 'on' === get_post_meta( $p->ID, '_et_pb_use_builder', true ) || str_contains( $p->post_content, '[et_pb_section' ) || str_contains( $p->post_content, '<!-- wp:divi/' ) ) {
            return 'divi';
        }
        if ( str_contains( $p->post_content, '[vc_row' ) ) {
            return 'wpbakery';
        }
        if ( str_contains( $p->post_content, '[fusion_builder_container' ) ) {
            return 'avada';
        }

        return str_contains( $p->post_content, '<!-- wp:' ) ? 'gutenberg' : 'classic';
    }

    private static function post( $ref ): \WP_Post {
        $p = Util::find_post( $ref );
        if ( ! $p ) {
            throw new BridgeError( 'not_found', 'No such post.', 404 );
        }

        return $p;
    }

    /* ------------------------------------------------------------ storage */

    /** @return array<int, array<string, mixed>> */
    private static function load( \WP_Post $p, string $b ): array {
        if ( 'elementor' === $b ) {
            $raw = get_post_meta( $p->ID, '_elementor_data', true );
            $arr = is_string( $raw ) ? json_decode( $raw, true ) : $raw;
        } else {
            $arr = maybe_unserialize( get_post_meta( $p->ID, '_bricks_page_content_2', true ) );
        }

        return is_array( $arr ) ? $arr : array();
    }

    /** @param array<int, array<string, mixed>> $tree */
    private static function store( \WP_Post $p, string $b, array $tree ): void {
        if ( 'elementor' === $b ) {
            update_post_meta( $p->ID, '_elementor_data', wp_slash( (string) wp_json_encode( $tree, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES ) ) );
            update_post_meta( $p->ID, '_elementor_edit_mode', 'builder' );
            if ( defined( 'ELEMENTOR_VERSION' ) ) {
                update_post_meta( $p->ID, '_elementor_version', ELEMENTOR_VERSION );
            }
        } else {
            update_post_meta( $p->ID, '_bricks_page_content_2', $tree );
            update_post_meta( $p->ID, '_bricks_editor_mode', 'bricks' );
        }
        self::flush( $p->ID, $b );
    }

    private static function flush( int $id, string $b ): void {
        clean_post_cache( $id );
        if ( 'elementor' === $b && class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
            delete_post_meta( $id, '_elementor_css' );
            \Elementor\Plugin::$instance->files_manager->clear_cache();
        }
    }

    private static function pick( \WP_Post $p, $builder ): string {
        $b = '' !== (string) $builder ? strtolower( (string) $builder ) : self::used_by( $p );
        if ( ! in_array( $b, array( 'elementor', 'bricks' ), true ) ) {
            throw new BridgeError( 'not_a_tree_builder', "This page uses \"$b\". Element-level editing exists for elementor and bricks; for other builders read and write the markup with builder.get / builder.set (content field).", 400 );
        }

        return $b;
    }

    private static function new_id(): string {
        return substr( md5( uniqid( '', true ) ), 0, 7 );
    }

    /* ---------------------------------------------------------------- ops */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_detect( array $a, Context $c ): array {
        $out = array( 'active' => array_keys( array_filter( self::active() ) ) );
        if ( isset( $a['id'] ) ) {
            $p              = self::post( $a['id'] );
            $out['post']    = $p->ID;
            $out['builder'] = self::used_by( $p );
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_get( array $a, Context $c ): array {
        $p = self::post( $a['id'] );
        if ( 'publish' !== $p->post_status ) {
            $c->need( 'draft' );
        }
        $b = self::used_by( $p );
        if ( ! in_array( $b, array( 'elementor', 'bricks' ), true ) ) {
            return array( 'post' => $p->ID, 'builder' => $b, 'content' => Util::clip( $p->post_content, 200000 ), 'note' => 'Markup builder: edit the text and save it with builder.set {content}.' );
        }
        $tree = self::load( $p, $b );
        if ( ! empty( $a['element'] ) ) {
            $found = self::find( $tree, (string) $a['element'], $b );
            if ( null === $found ) {
                throw new BridgeError( 'not_found', 'No element with that id.', 404 );
            }

            return array( 'post' => $p->ID, 'builder' => $b, 'element' => 'bricks' === $b ? $found : $found['node'] );
        }

        return array( 'post' => $p->ID, 'builder' => $b, 'data' => ! empty( $a['outline'] ) ? self::outline( $tree, $b ) : $tree );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_set( array $a, Context $c ): array {
        $p = self::post( $a['id'] );
        $c->need( 'publish' === $p->post_status ? 'live' : 'draft' );
        $before = Revisions::snap_post( $p->ID );
        $b      = self::used_by( $p );

        if ( isset( $a['content'] ) ) {
            $r = wp_update_post( wp_slash( array( 'ID' => $p->ID, 'post_content' => (string) $a['content'] ) ), true );
            if ( is_wp_error( $r ) ) {
                throw new BridgeError( 'save_failed', $r->get_error_message(), 500 );
            }
            $b = self::used_by( get_post( $p->ID ) );
        } else {
            $b    = self::pick( $p, $a['builder'] ?? ( 'classic' === $b || 'gutenberg' === $b ? ( self::active()['elementor'] ? 'elementor' : 'bricks' ) : $b ) );
            $tree = is_string( $a['data'] ?? null ) ? json_decode( (string) $a['data'], true ) : ( $a['data'] ?? null );
            if ( ! is_array( $tree ) ) {
                throw new BridgeError( 'bad_data', 'data must be an array of elements (or its JSON string).', 400 );
            }
            self::check_tree( $tree, $b );
            self::store( $p, $b, $tree );
        }
        Revisions::record( $c, 'post', (string) $p->ID, $before );
        $c->summary = "builder data of #{$p->ID} ($b)";

        return array( 'post' => $p->ID, 'builder' => $b, 'url' => get_permalink( $p ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_element_update( array $a, Context $c ): array {
        return self::edit( $a, $c, function ( array &$tree, string $b ) use ( $a ): string {
            $id    = (string) $a['element'];
            $patch = is_array( $a['settings'] ?? null ) ? $a['settings'] : array();
            $hit   = &self::find_ref( $tree, $id, $b );
            if ( null === $hit ) {
                throw new BridgeError( 'not_found', 'No element with that id.', 404 );
            }
            foreach ( $patch as $k => $v ) {
                if ( null === $v ) {
                    unset( $hit['settings'][ $k ] );
                } else {
                    $hit['settings'][ $k ] = $v;
                }
            }
            if ( empty( $hit['settings'] ) ) {
                $hit['settings'] = array(); // Elementor wants [] not null.
            }

            return "updated $id";
        } );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_element_add( array $a, Context $c ): array {
        return self::edit( $a, $c, function ( array &$tree, string $b ) use ( $a ): string {
            $el = is_array( $a['element'] ?? null ) ? $a['element'] : array();
            if ( empty( $el ) ) {
                throw new BridgeError( 'bad_data', 'element must be an object.', 400 );
            }
            $el['id'] = ! empty( $el['id'] ) ? (string) $el['id'] : self::new_id();
            $pos      = isset( $a['position'] ) ? (int) $a['position'] : null;
            $parent   = (string) ( $a['parent'] ?? '' );

            if ( 'elementor' === $b ) {
                $el += array( 'settings' => array(), 'elements' => array() );
                if ( empty( $el['elType'] ) ) {
                    throw new BridgeError( 'bad_data', 'element.elType is required (container, section, column or widget).', 400 );
                }
                if ( '' === $parent ) {
                    array_splice( $tree, $pos ?? count( $tree ), 0, array( $el ) );
                } else {
                    $hit = &self::find_ref( $tree, $parent, $b );
                    if ( null === $hit ) {
                        throw new BridgeError( 'not_found', 'Parent element not found.', 404 );
                    }
                    $hit['elements'] = $hit['elements'] ?? array();
                    array_splice( $hit['elements'], $pos ?? count( $hit['elements'] ), 0, array( $el ) );
                }
            } else {
                if ( empty( $el['name'] ) ) {
                    throw new BridgeError( 'bad_data', 'element.name is required (section, container, heading, text-basic…).', 400 );
                }
                $el += array( 'settings' => array(), 'children' => array(), 'parent' => 0 );
                $el['parent'] = '' === $parent ? 0 : $parent;
                $tree[]       = $el;
                if ( '' !== $parent ) {
                    foreach ( $tree as &$n ) {
                        if ( ( $n['id'] ?? '' ) === $parent ) {
                            $n['children'] = $n['children'] ?? array();
                            array_splice( $n['children'], $pos ?? count( $n['children'] ), 0, array( $el['id'] ) );
                        }
                    }
                    unset( $n );
                }
            }

            return 'added ' . $el['id'];
        } );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_element_remove( array $a, Context $c ): array {
        return self::edit( $a, $c, function ( array &$tree, string $b ) use ( $a ): string {
            $id = (string) $a['element'];
            if ( 'elementor' === $b ) {
                if ( ! self::drop( $tree, $id ) ) {
                    throw new BridgeError( 'not_found', 'No element with that id.', 404 );
                }
            } else {
                $gone = array( $id );
                do {
                    $n = count( $gone );
                    foreach ( $tree as $node ) {
                        if ( in_array( $node['parent'] ?? 0, $gone, true ) && ! in_array( $node['id'], $gone, true ) ) {
                            $gone[] = $node['id'];
                        }
                    }
                } while ( count( $gone ) > $n );
                $tree = array_values( array_filter( $tree, static fn( $node ) => ! in_array( $node['id'], $gone, true ) ) );
                foreach ( $tree as &$node ) {
                    $node['children'] = array_values( array_diff( (array) ( $node['children'] ?? array() ), $gone ) );
                }
                unset( $node );
            }

            return "removed $id";
        } );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_regenerate( array $a, Context $c ): array {
        $p = isset( $a['id'] ) ? self::post( $a['id'] ) : null;
        if ( $p ) {
            self::flush( $p->ID, self::used_by( $p ) );
        } elseif ( class_exists( '\Elementor\Plugin' ) ) {
            \Elementor\Plugin::$instance->files_manager->clear_cache();
        }
        $c->summary = 'builder css cache cleared';

        return array( 'cleared' => true );
    }

    /* ------------------------------------------------------------ helpers */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    private static function edit( array $a, Context $c, callable $fn ): array {
        $p = self::post( $a['id'] );
        $b = self::pick( $p, $a['builder'] ?? '' );
        $before = Revisions::snap_post( $p->ID );
        $tree   = self::load( $p, $b );
        $what   = $fn( $tree, $b );
        self::store( $p, $b, $tree );
        Revisions::record( $c, 'post', (string) $p->ID, $before );
        $c->summary = "$b #{$p->ID}: $what";

        return array( 'post' => $p->ID, 'builder' => $b, 'done' => $what, 'elements' => self::count( $tree ) );
    }

    /** @param array<int, array<string, mixed>> $tree */
    private static function check_tree( array $tree, string $b ): void {
        $seen = array();
        $walk = function ( array $nodes ) use ( &$walk, &$seen, $b ): void {
            foreach ( $nodes as $n ) {
                if ( ! is_array( $n ) || empty( $n['id'] ) ) {
                    throw new BridgeError( 'bad_data', 'Every element needs an id.', 400 );
                }
                if ( isset( $seen[ $n['id'] ] ) ) {
                    throw new BridgeError( 'bad_data', 'Duplicate element id ' . $n['id'] . '.', 400 );
                }
                $seen[ $n['id'] ] = true;
                if ( 'elementor' === $b ) {
                    if ( empty( $n['elType'] ) ) {
                        throw new BridgeError( 'bad_data', 'Element ' . $n['id'] . ' has no elType.', 400 );
                    }
                    $walk( (array) ( $n['elements'] ?? array() ) );
                } elseif ( empty( $n['name'] ) ) {
                    throw new BridgeError( 'bad_data', 'Element ' . $n['id'] . ' has no name.', 400 );
                }
            }
        };
        $walk( $tree );
    }

    /** @param array<int, array<string, mixed>> $tree */
    private static function count( array $tree ): int {
        $n = 0;
        foreach ( $tree as $node ) {
            $n += 1 + self::count( (array) ( $node['elements'] ?? array() ) );
        }

        return $n;
    }

    /**
     * @param array<int, array<string, mixed>> $tree
     * @return array<string, mixed>|null
     */
    private static function find( array $tree, string $id, string $b ): ?array {
        foreach ( $tree as $node ) {
            if ( (string) ( $node['id'] ?? '' ) === $id ) {
                return 'bricks' === $b ? $node : array( 'node' => $node );
            }
            if ( 'elementor' === $b ) {
                $sub = self::find( (array) ( $node['elements'] ?? array() ), $id, $b );
                if ( $sub ) {
                    return $sub;
                }
            }
        }

        return null;
    }

    /**
     * @param array<int, array<string, mixed>> $tree
     * @return array<string, mixed>|null
     */
    private static function &find_ref( array &$tree, string $id, string $b ) {
        $null = null;
        foreach ( $tree as &$node ) {
            if ( (string) ( $node['id'] ?? '' ) === $id ) {
                return $node;
            }
            if ( 'elementor' === $b && ! empty( $node['elements'] ) ) {
                $sub = &self::find_ref( $node['elements'], $id, $b );
                if ( null !== $sub ) {
                    return $sub;
                }
            }
        }

        return $null;
    }

    /** @param array<int, array<string, mixed>> $tree */
    private static function drop( array &$tree, string $id ): bool {
        foreach ( $tree as $i => &$node ) {
            if ( (string) ( $node['id'] ?? '' ) === $id ) {
                array_splice( $tree, $i, 1 );

                return true;
            }
            if ( ! empty( $node['elements'] ) && self::drop( $node['elements'], $id ) ) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param array<int, array<string, mixed>> $tree
     * @return array<int, array<string, mixed>>
     */
    private static function outline( array $tree, string $b ): array {
        $out = array();
        foreach ( $tree as $n ) {
            if ( 'bricks' === $b && ! empty( $n['parent'] ) ) {
                continue; // Children are listed under their parent below.
            }
            $row = array( 'id' => $n['id'], 'type' => $n['widgetType'] ?? $n['elType'] ?? $n['name'] ?? '' );
            foreach ( array( 'title', 'text', 'editor', 'heading_title' ) as $k ) {
                if ( ! empty( $n['settings'][ $k ] ) && is_string( $n['settings'][ $k ] ) ) {
                    $row['text'] = mb_substr( wp_strip_all_tags( $n['settings'][ $k ] ), 0, 80 );
                    break;
                }
            }
            $kids = 'elementor' === $b ? (array) ( $n['elements'] ?? array() ) : array_values( array_filter( $tree, static fn( $x ) => ( $x['parent'] ?? 0 ) === $n['id'] ) );
            if ( $kids ) {
                $row['children'] = self::outline( $kids, 'elementor' === $b ? $b : 'flat' );
            }
            $out[] = $row;
        }

        return $out;
    }
}
