<?php
/**
 * options.* operations. Safe settings at live, other settings at admin, secrets never.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Revisions;
use WPMCP\Bridge\Util;

defined( 'ABSPATH' ) || exit;

final class OptionOps {

    /** Options with a dedicated tool: writing them here could lock the site or bypass a safeguard. */
    private const DEDICATED = array( 'active_plugins', 'template', 'stylesheet', 'user_roles', 'cron', 'rewrite_rules', 'db_version', 'initial_db_version', 'recently_activated', 'wpm_maintenance', 'wpm_backups' );

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_get( array $a, Context $c ): array {
        $out    = array();
        $denied = array();
        foreach ( array_slice( array_map( 'strval', (array) $a['keys'] ), 0, 50 ) as $key ) {
            $tier = Policy::option_tier( $key );
            if ( 'secret' === $tier ) {
                $out[ $key ] = array( 'redacted' => true, 'reason' => 'looks like a secret' );
                continue;
            }
            if ( 'safe' !== $tier && ! $c->can( 'admin' ) ) {
                $denied[] = $key;
                continue;
            }
            $sentinel = new \stdClass();
            $value    = get_option( $key, $sentinel );
            if ( $value === $sentinel ) {
                $out[ $key ] = array( 'exists' => false );
                continue;
            }
            $value = Policy::redact( $value );
            [ , $cut ] = Util::clip( (string) wp_json_encode( $value ), 20000 );
            $out[ $key ] = $cut ? array( 'truncated' => true, 'note' => 'Value over 20 KB; read narrower options.' ) : $value;
        }
        if ( $denied ) {
            $out['_denied'] = array( 'keys' => $denied, 'reason' => 'Not a public setting; needs admin level.' );
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_list( array $a, Context $c ): array {
        global $wpdb;
        if ( ! $c->can( 'admin' ) ) {
            return array( 'options' => array_values( array_filter( array( 'blogname', 'blogdescription', 'timezone_string', 'date_format', 'time_format', 'permalink_structure', 'show_on_front', 'page_on_front', 'page_for_posts', 'posts_per_page', 'default_comment_status', 'comment_moderation', 'WPLANG' ), static fn ( $k ) => ! str_starts_with( $k, (string) ( $a['prefix'] ?? '' ) ) ? false : true ) ), 'note' => 'Public settings only at this level.' );
        }
        [ $page, $per ] = Util::paging( $a, 200 );
        $rows           = (array) $wpdb->get_results( $wpdb->prepare( "SELECT option_name AS name, LENGTH(option_value) AS bytes FROM {$wpdb->options} WHERE option_name LIKE %s AND option_name NOT LIKE %s AND option_name NOT LIKE %s ORDER BY option_name LIMIT %d OFFSET %d", $wpdb->esc_like( (string) ( $a['prefix'] ?? '' ) ) . '%', '\\_transient\\_%', '\\_site\\_transient\\_%', $per, ( $page - 1 ) * $per ), ARRAY_A ); // phpcs:ignore WordPress.DB

        return array( 'options' => array_map( static fn ( $r ) => array( 'name' => $r['name'], 'bytes' => (int) $r['bytes'], 'tier' => Policy::option_tier( (string) $r['name'] ) ), $rows ), 'page' => $page );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, array<string, mixed>> Per key: tier, whether admin is needed, and the plan.
     */
    private static function plan( array $a ): array {
        $values = (array) $a['values'];
        if ( count( $values ) > 30 ) {
            throw new BridgeError( 'too_many', 'At most 30 options per call.', 400 );
        }
        $plan = array();
        foreach ( $values as $key => $value ) {
            $key  = (string) $key;
            $tier = Policy::option_tier( $key );
            if ( 'secret' === $tier ) {
                throw new BridgeError( 'forbidden', "Option \"$key\" looks like a secret and cannot be written here.", 403 );
            }
            if ( in_array( $key, self::DEDICATED, true ) || str_starts_with( $key, 'wpm_' ) ) {
                throw new BridgeError( 'use_tool', "Option \"$key\" is managed by a dedicated tool (plugins, design, maintain…).", 400 );
            }
            if ( 'default_role' === $key && 'administrator' === $value ) {
                throw new BridgeError( 'forbidden', 'default_role cannot be administrator.', 403 );
            }
            if ( in_array( $key, array( 'siteurl', 'home' ), true ) && ! preg_match( '#^https?://[^\s]+$#', (string) $value ) ) {
                throw new BridgeError( 'bad_value', "$key must be a full http(s) URL.", 400 );
            }
            $sensitive = 'safe' !== $tier;
            $plan[ $key ] = array( 'sensitive' => $sensitive, 'current' => Policy::redact( get_option( $key, null ) ), 'new' => $value );
        }

        return $plan;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_set( array $a, Context $c ): array {
        $plan = self::plan( $a );
        $risk = array_keys( array_filter( $plan, static fn ( $p ) => $p['sensitive'] ) );
        if ( $risk ) {
            $c->need( 'admin', 'These options are not public settings: ' . implode( ', ', $risk ) . '.' );
        }

        return array( 'changes' => $plan, 'needs_confirmation' => (bool) $risk, 'warning' => $risk ? 'Changing ' . implode( ', ', $risk ) . ' can lock you out or break the site.' : null );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_set( array $a, Context $c ): array {
        $plan = self::plan( $a );
        foreach ( $plan as $key => $p ) {
            if ( $p['sensitive'] ) {
                $c->need( 'admin', "Option \"$key\" is not a public setting." );
            }
        }
        $before = array_map( array( Revisions::class, 'snap_option' ), array_map( 'strval', array_keys( $plan ) ) );
        foreach ( $plan as $key => $p ) {
            update_option( (string) $key, $p['new'] );
        }
        if ( isset( $plan['permalink_structure'] ) || isset( $plan['category_base'] ) || isset( $plan['tag_base'] ) ) {
            delete_option( 'rewrite_rules' );
        }
        Revisions::record( $c, 'options', implode( ',', array_keys( $plan ) ), $before );
        $c->summary = 'set options: ' . implode( ', ', array_keys( $plan ) );

        return array( 'updated' => array_keys( $plan ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_delete( array $a, Context $c ): array {
        $key = (string) $a['key'];
        if ( 'secret' === Policy::option_tier( $key ) || in_array( $key, self::DEDICATED, true ) || Policy::sensitive_option( $key ) || str_starts_with( $key, 'wpm_' ) ) {
            throw new BridgeError( 'forbidden', "Option \"$key\" cannot be deleted from here.", 403 );
        }
        $before = Revisions::snap_option( $key );
        if ( empty( $before['exists'] ) ) {
            throw new BridgeError( 'not_found', 'No such option.', 404 );
        }
        delete_option( $key );
        Revisions::record( $c, 'options', $key, array( $before ) );
        $c->summary = "deleted option $key";

        return array( 'deleted' => $key );
    }
}
