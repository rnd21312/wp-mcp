<?php
/**
 * fields.* operations: custom field groups and values for ACF and Meta Box.
 *
 * ACF values go through its API (so the hidden _field reference is kept); Meta Box stores plain meta.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Revisions;

defined( 'ABSPATH' ) || exit;

final class Fields {

    /** @return array<int, string> Active field plugins. */
    public static function providers(): array {
        return array_values( array_filter( array( function_exists( 'acf_get_field_groups' ) ? 'acf' : '', function_exists( 'rwmb_get_registry' ) ? 'metabox' : '' ) ) );
    }

    private static function provider( $want ): string {
        $have = self::providers();
        $pick = '' !== (string) $want ? (string) $want : ( $have[0] ?? '' );
        if ( ! in_array( $pick, $have, true ) ) {
            throw new BridgeError( 'no_fields_plugin', 'Neither ACF nor Meta Box is active' . ( $have ? ' (active: ' . implode( ', ', $have ) . ')' : '' ) . '.', 400 );
        }

        return $pick;
    }

    /** @return array{0: string, 1: int, 2: mixed} object kind, id, ACF post_id reference. */
    private static function target( array $a, Context $c ): array {
        $kind = (string) ( $a['object'] ?? 'post' );
        $id   = (int) ( $a['id'] ?? 0 );
        if ( 'option' === $kind ) {
            $c->need( 'admin' );

            return array( 'option', 0, 'option' );
        }
        if ( $id < 1 ) {
            throw new BridgeError( 'bad_args', 'id is required.', 400 );
        }
        if ( 'user' === $kind ) {
            $c->need( 'admin' );

            return array( 'user', $id, 'user_' . $id );
        }
        if ( 'term' === $kind ) {
            return array( 'term', $id, 'term_' . $id );
        }
        if ( ! get_post( $id ) ) {
            throw new BridgeError( 'not_found', 'No such post.', 404 );
        }

        return array( 'post', $id, $id );
    }

    private static function name_ok( string $name ): void {
        if ( '' === $name || '_' === $name[0] || Policy::is_secret_key( $name ) ) {
            throw new BridgeError( 'forbidden', 'That field name is not allowed.', 403 );
        }
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_groups( array $a, Context $c ): array {
        $p   = self::provider( $a['plugin'] ?? '' );
        $out = array();
        if ( 'acf' === $p ) {
            foreach ( acf_get_field_groups() as $g ) {
                $fields = array_map(
                    static fn( $f ) => array_intersect_key( $f, array_flip( array( 'key', 'name', 'label', 'type', 'required', 'choices', 'sub_fields', 'instructions' ) ) ),
                    (array) acf_get_fields( $g['key'] )
                );
                $out[]  = array( 'key' => $g['key'], 'title' => $g['title'], 'active' => ! empty( $g['active'] ), 'location' => $g['location'] ?? array(), 'fields' => $fields );
            }
        } else {
            foreach ( rwmb_get_registry( 'meta_box' )->all() as $box ) {
                $m     = $box->meta_box;
                $out[] = array( 'id' => $m['id'], 'title' => $m['title'] ?? '', 'post_types' => $m['post_types'] ?? array(), 'fields' => array_map( static fn( $f ) => array_intersect_key( $f, array_flip( array( 'id', 'name', 'type', 'required', 'options', 'clone', 'fields' ) ) ), (array) ( $m['fields'] ?? array() ) ) );
            }
        }

        return array( 'plugin' => $p, 'groups' => $out );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_get( array $a, Context $c ): array {
        $p = self::provider( $a['plugin'] ?? '' );
        [ $kind, $id, $ref ] = self::target( $a, $c );
        $field = (string) ( $a['field'] ?? '' );
        if ( '' !== $field ) {
            self::name_ok( $field );
            $value = 'acf' === $p ? get_field( $field, $ref, false ) : ( 'option' === $kind ? get_option( $field ) : get_metadata( $kind, $id, $field, true ) );

            return array( 'plugin' => $p, 'object' => $kind, 'id' => $id, 'field' => $field, 'value' => $value );
        }
        if ( 'acf' === $p ) {
            return array( 'plugin' => $p, 'object' => $kind, 'id' => $id, 'values' => get_fields( $ref, false ) ?: new \stdClass() );
        }
        $vals = array();
        foreach ( (array) get_metadata( $kind, $id ) as $k => $v ) {
            if ( '_' !== $k[0] && ! Policy::is_secret_key( (string) $k ) ) {
                $vals[ $k ] = maybe_unserialize( count( $v ) > 1 ? $v : $v[0] );
            }
        }

        return array( 'plugin' => $p, 'object' => $kind, 'id' => $id, 'values' => $vals ?: new \stdClass() );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_set( array $a, Context $c ): array {
        $p = self::provider( $a['plugin'] ?? '' );
        [ $kind, $id, $ref ] = self::target( $a, $c );
        $field = (string) $a['field'];
        self::name_ok( $field );
        $before = 'post' === $kind ? Revisions::snap_post( $id ) : null;
        $prev   = 'acf' === $p ? get_field( $field, $ref, false ) : ( 'option' === $kind ? get_option( $field ) : get_metadata( $kind, $id, $field, true ) );

        if ( 'acf' === $p ) {
            if ( ! update_field( $field, $a['value'] ?? '', $ref ) && get_field( $field, $ref, false ) !== ( $a['value'] ?? '' ) ) {
                throw new BridgeError( 'save_failed', 'ACF did not save the value. Check the field name or key with fields.groups.', 400 );
            }
        } elseif ( 'option' === $kind ) {
            update_option( $field, $a['value'] ?? '' );
        } else {
            update_metadata( $kind, $id, $field, wp_slash( $a['value'] ?? '' ) );
        }
        if ( $before ) {
            Revisions::record( $c, 'post', (string) $id, $before );
        }
        $c->summary = "set $p field $field on $kind #$id";

        return array( 'plugin' => $p, 'object' => $kind, 'id' => $id, 'field' => $field, 'previous' => $prev );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_group_save( array $a, Context $c ): array {
        if ( ! function_exists( 'acf_import_field_group' ) ) {
            throw new BridgeError( 'no_fields_plugin', 'Creating groups needs ACF (Meta Box groups are code or the Meta Box Builder plugin).', 400 );
        }
        $g = is_array( $a['group'] ?? null ) ? $a['group'] : array();
        if ( empty( $g['title'] ) || empty( $g['fields'] ) || empty( $g['location'] ) ) {
            throw new BridgeError( 'bad_data', 'group needs title, fields and location (ACF export format).', 400 );
        }
        $g['key']    = ! empty( $g['key'] ) ? (string) $g['key'] : 'group_' . substr( md5( uniqid( '', true ) ), 0, 13 );
        $g['active'] = true;
        $saved       = acf_import_field_group( $g );
        $c->summary  = 'ACF group ' . $g['title'];

        return array( 'key' => $g['key'], 'id' => $saved['ID'] ?? 0, 'note' => 'Saved. Change it later by sending the same key again.' );
    }
}
