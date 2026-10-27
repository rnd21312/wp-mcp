<?php
/**
 * Tools → WP MCP Bridge: create pairing codes, see and revoke connections, read the activity log.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class Admin {

    public static function init(): void {
        add_action( 'admin_menu', array( self::class, 'menu' ) );
    }

    public static function menu(): void {
        add_management_page( 'WP MCP Bridge', 'WP MCP Bridge', 'manage_options', 'wp-mcp-bridge', array( self::class, 'page' ) );
    }

    public static function page(): void {
        if ( ! current_user_can( 'manage_options' ) ) {
            return;
        }
        $code = '';
        if ( 'POST' === ( $_SERVER['REQUEST_METHOD'] ?? '' ) ) {
            check_admin_referer( 'wpm_bridge' );
            $do = sanitize_key( wp_unslash( (string) ( $_POST['do'] ?? '' ) ) );
            if ( 'pair' === $do ) {
                $code = Connections::create_pairing( get_current_user_id(), sanitize_key( wp_unslash( (string) ( $_POST['ceiling'] ?? 'admin' ) ) ) );
            } elseif ( 'revoke' === $do ) {
                Connections::revoke( sanitize_text_field( wp_unslash( (string) ( $_POST['key'] ?? '' ) ) ) );
            } elseif ( 'ceiling' === $do ) {
                Connections::set_ceiling( sanitize_text_field( wp_unslash( (string) ( $_POST['key'] ?? '' ) ) ), sanitize_key( wp_unslash( (string) ( $_POST['ceiling'] ?? '' ) ) ) );
            }
        }

        echo '<div class="wrap"><h1>WP MCP Bridge</h1>';
        echo '<p>Lets the WP MCP gateway manage this site for AI assistants. Every request is signed; levels, confirmations, undo and an activity log are built in. Nothing is reachable until you pair a gateway.</p>';

        if ( '' !== $code ) {
            echo '<div class="notice notice-success"><p><strong>Pairing code (valid 15 minutes, one use):</strong></p><p><code style="font-size:20px">' . esc_html( $code ) . '</code></p><p>Paste it in the gateway admin panel under "Connect a site", with this site\'s URL: <code>' . esc_html( home_url() ) . '</code></p></div>';
        }

        echo '<h2>Connect a gateway</h2><form method="post">';
        wp_nonce_field( 'wpm_bridge' );
        echo '<input type="hidden" name="do" value="pair"><p><label>Highest level this connection may ever use on this site: ';
        echo self::select( 'ceiling', 'admin' );
        echo '</label></p><p class="description">read: public data only. draft: + drafts and uploads. live: + publishing and design. admin: + plugins, updates, users, database. You can lower it later.</p>';
        echo '<p><button class="button button-primary">Create pairing code</button></p></form>';

        echo '<h2>Connections</h2>';
        $connections = Connections::all();
        if ( array() === $connections ) {
            echo '<p>None.</p>';
        } else {
            echo '<table class="widefat striped"><thead><tr><th>Gateway</th><th>Acts as</th><th>Ceiling</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>';
            foreach ( $connections as $id => $conn ) {
                $user = get_userdata( (int) $conn['user'] );
                echo '<tr><td>' . esc_html( (string) $conn['label'] ) . '<br><code>' . esc_html( (string) $id ) . '</code></td><td>' . esc_html( $user ? $user->user_login : 'missing' ) . '</td>';
                echo '<td><form method="post">';
                wp_nonce_field( 'wpm_bridge' );
                echo '<input type="hidden" name="do" value="ceiling"><input type="hidden" name="key" value="' . esc_attr( (string) $id ) . '">' . self::select( 'ceiling', (string) $conn['ceiling'] ) . ' <button class="button">Set</button></form></td>';
                echo '<td>' . esc_html( wp_date( 'Y-m-d H:i', (int) $conn['created'] ) ) . '</td><td>' . ( $conn['last_used'] ? esc_html( wp_date( 'Y-m-d H:i', (int) $conn['last_used'] ) ) : 'never' ) . '</td>';
                echo '<td><form method="post" onsubmit="return confirm(\'Revoke this connection?\')">';
                wp_nonce_field( 'wpm_bridge' );
                echo '<input type="hidden" name="do" value="revoke"><input type="hidden" name="key" value="' . esc_attr( (string) $id ) . '"><button class="button button-link-delete">Revoke</button></form></td></tr>';
            }
            echo '</tbody></table>';
        }

        echo '<h2>Recent activity</h2>';
        $rows = Activity::list( array( 'per_page' => 25 ) )['entries'];
        if ( array() === $rows ) {
            echo '<p>Nothing yet.</p>';
        } else {
            echo '<table class="widefat striped"><thead><tr><th>When (UTC)</th><th>Operation</th><th>Level</th><th>Result</th><th>By</th><th>Details</th><th>Revision</th></tr></thead><tbody>';
            foreach ( $rows as $row ) {
                echo '<tr><td>' . esc_html( (string) $row['created'] ) . '</td><td><code>' . esc_html( (string) $row['op'] ) . '</code></td><td>' . esc_html( (string) $row['level'] ) . '</td><td>' . esc_html( (string) $row['status'] ) . '</td><td>' . esc_html( (string) $row['actor'] ) . '</td><td>' . esc_html( (string) $row['summary'] ) . '</td><td>' . ( $row['revision'] ? '#' . (int) $row['revision'] : '' ) . '</td></tr>';
            }
            echo '</tbody></table>';
        }
        echo '</div>';
    }

    private static function select( string $name, string $current ): string {
        $out = '<select name="' . esc_attr( $name ) . '">';
        foreach ( Levels::ALL as $level ) {
            $out .= '<option value="' . esc_attr( $level ) . '"' . selected( $current, $level, false ) . '>' . esc_html( $level ) . '</option>';
        }

        return $out . '</select>';
    }
}
