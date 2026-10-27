<?php
/**
 * users.* operations. Everything except public author info is admin-only.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\Util;

defined( 'ABSPATH' ) || exit;

final class UserOps {

    /** @return array<string, mixed> */
    private static function view( \WP_User $u ): array {
        return array( 'id' => $u->ID, 'login' => $u->user_login, 'email' => $u->user_email, 'display_name' => $u->display_name, 'roles' => array_values( $u->roles ), 'registered' => $u->user_registered, 'posts' => (int) count_user_posts( $u->ID ) );
    }

    private static function find( $ref ): \WP_User {
        $user = is_numeric( $ref ) ? get_userdata( (int) $ref ) : ( is_email( (string) $ref ) ? get_user_by( 'email', (string) $ref ) : get_user_by( 'login', (string) $ref ) );
        if ( ! $user ) {
            throw new BridgeError( 'not_found', 'No such user.', 404 );
        }

        return $user;
    }

    private static function admins_left_without( int $id ): int {
        return count( get_users( array( 'role' => 'administrator', 'exclude' => array( $id ), 'fields' => 'ID' ) ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_authors( array $a, Context $c ): array {
        [ $page, $per ] = Util::paging( $a );
        $users          = get_users( array( 'has_published_posts' => true, 'number' => $per, 'paged' => $page, 'orderby' => 'post_count', 'order' => 'DESC' ) );

        return array( 'authors' => array_map( static fn ( $u ) => array( 'id' => $u->ID, 'name' => $u->display_name, 'slug' => $u->user_nicename, 'posts' => (int) count_user_posts( $u->ID, 'post', true ) ), $users ), 'page' => $page );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_list( array $a, Context $c ): array {
        [ $page, $per ] = Util::paging( $a );
        $args           = array( 'number' => $per, 'paged' => $page, 'orderby' => 'registered', 'order' => 'DESC' );
        if ( ! empty( $a['role'] ) ) {
            $args['role'] = sanitize_key( (string) $a['role'] );
        }
        if ( ! empty( $a['search'] ) ) {
            $args['search'] = '*' . sanitize_text_field( (string) $a['search'] ) . '*';
        }
        $q = new \WP_User_Query( $args );

        return array( 'users' => array_map( array( self::class, 'view' ), $q->get_results() ), 'total' => (int) $q->get_total(), 'page' => $page );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_get( array $a, Context $c ): array {
        return self::view( self::find( $a['id'] ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_create( array $a, Context $c ): array {
        return array( 'will_create' => array( 'login' => $a['login'], 'email' => $a['email'], 'role' => $a['role'] ?? 'subscriber' ), 'effect' => 'The person receives an email to set their own password.', 'warning' => 'administrator' === ( $a['role'] ?? '' ) ? 'This user will have full control of the site.' : null );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_create( array $a, Context $c ): array {
        $role = sanitize_key( (string) ( $a['role'] ?? 'subscriber' ) );
        if ( ! get_role( $role ) ) {
            throw new BridgeError( 'bad_role', 'Unknown role. See users.roles.', 400 );
        }
        $id = wp_insert_user( array( 'user_login' => sanitize_user( (string) $a['login'], true ), 'user_email' => sanitize_email( (string) $a['email'] ), 'user_pass' => wp_generate_password( 32 ), 'role' => $role, 'display_name' => sanitize_text_field( (string) ( $a['display_name'] ?? $a['login'] ) ) ) );
        if ( is_wp_error( $id ) ) {
            throw new BridgeError( 'create_failed', $id->get_error_message(), 400 );
        }
        wp_send_new_user_notifications( (int) $id, 'user' );
        $c->summary = "created user {$a['login']} ($role)";

        return array( 'id' => (int) $id, 'role' => $role, 'note' => 'A set-password email was sent. No password is ever returned.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_update( array $a, Context $c ): array {
        $u = self::find( $a['id'] );

        return array( 'user' => self::view( $u ), 'changes' => array_intersect_key( $a, array_flip( array( 'display_name', 'email', 'role' ) ) ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_update( array $a, Context $c ): array {
        $u    = self::find( $a['id'] );
        $args = array( 'ID' => $u->ID );
        if ( isset( $a['display_name'] ) ) {
            $args['display_name'] = sanitize_text_field( (string) $a['display_name'] );
        }
        if ( isset( $a['email'] ) ) {
            $args['user_email'] = sanitize_email( (string) $a['email'] );
        }
        if ( isset( $a['role'] ) ) {
            $role = sanitize_key( (string) $a['role'] );
            if ( ! get_role( $role ) ) {
                throw new BridgeError( 'bad_role', 'Unknown role.', 400 );
            }
            if ( $u->ID === get_current_user_id() ) {
                throw new BridgeError( 'protected', 'The account this connection acts as cannot change its own role.', 400 );
            }
            if ( in_array( 'administrator', $u->roles, true ) && 'administrator' !== $role && 0 === self::admins_left_without( $u->ID ) ) {
                throw new BridgeError( 'protected', 'This is the last administrator.', 400 );
            }
            $args['role'] = $role;
        }
        $res = wp_update_user( $args );
        if ( is_wp_error( $res ) ) {
            throw new BridgeError( 'update_failed', $res->get_error_message(), 400 );
        }
        $c->summary = "updated user #{$u->ID}: " . implode( ',', array_keys( array_diff_key( $args, array( 'ID' => 1 ) ) ) );

        return self::view( get_userdata( $u->ID ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_delete( array $a, Context $c ): array {
        $u = self::find( $a['id'] );

        return array( 'will_delete' => self::view( $u ), 'content_goes_to' => ! empty( $a['reassign'] ) ? (int) $a['reassign'] : 'deleted with the user', 'permanent' => true );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_delete( array $a, Context $c ): array {
        require_once ABSPATH . 'wp-admin/includes/user.php';
        $u = self::find( $a['id'] );
        if ( $u->ID === get_current_user_id() ) {
            throw new BridgeError( 'protected', 'The account this connection acts as cannot be deleted.', 400 );
        }
        if ( in_array( 'administrator', $u->roles, true ) && 0 === self::admins_left_without( $u->ID ) ) {
            throw new BridgeError( 'protected', 'This is the last administrator.', 400 );
        }
        $reassign = ! empty( $a['reassign'] ) ? (int) $a['reassign'] : null;
        if ( $reassign && ( $reassign === $u->ID || ! get_userdata( $reassign ) ) ) {
            throw new BridgeError( 'bad_reassign', 'reassign must be another existing user.', 400 );
        }
        wp_delete_user( $u->ID, $reassign );
        $c->summary = "deleted user #{$u->ID} ({$u->user_login})";

        return array( 'deleted' => $u->ID );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_send_reset( array $a, Context $c ): array {
        $u   = self::find( $a['id'] );
        $key = get_password_reset_key( $u );
        if ( is_wp_error( $key ) ) {
            throw new BridgeError( 'failed', $key->get_error_message(), 500 );
        }
        $url  = network_site_url( 'wp-login.php?action=rp&key=' . $key . '&login=' . rawurlencode( $u->user_login ), 'login' );
        $sent = wp_mail( $u->user_email, sprintf( '[%s] Password reset', wp_specialchars_decode( get_bloginfo( 'name' ), ENT_QUOTES ) ), "Someone asked to reset the password for your account.\n\n$url\n\nIf this was not you, ignore this email." );
        $c->summary = "sent password reset to user #{$u->ID}";

        return array( 'sent' => (bool) $sent );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_roles( array $a, Context $c ): array {
        $out = array();
        foreach ( wp_roles()->roles as $slug => $role ) {
            $out[] = array( 'role' => $slug, 'name' => $role['name'], 'capabilities' => count( array_filter( $role['capabilities'] ) ), 'users' => count( get_users( array( 'role' => $slug, 'fields' => 'ID' ) ) ) );
        }

        return array( 'roles' => $out );
    }
}
