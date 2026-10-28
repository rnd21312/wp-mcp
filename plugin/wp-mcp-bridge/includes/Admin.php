<?php
/**
 * Tools → WP MCP Bridge. Tab "MCP": only for connecting the site to a gateway (pairing codes and connections).
 * Tab "Activity": what AI clients did. Tab "Media": image/video shrinking and files that are not in the library yet.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class Admin {

    private const TABS = array( 'mcp' => 'MCP', 'activity' => 'Activity', 'media' => 'Media' );

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
        $tab = sanitize_key( wp_unslash( (string) ( $_GET['tab'] ?? 'mcp' ) ) ); // phpcs:ignore WordPress.Security.NonceVerification
        $tab = isset( self::TABS[ $tab ] ) ? $tab : 'mcp';
        $out = array( 'code' => '', 'notice' => '' );
        if ( 'POST' === ( $_SERVER['REQUEST_METHOD'] ?? '' ) ) {
            check_admin_referer( 'wpm_bridge' );
            $out = self::handle( sanitize_key( wp_unslash( (string) ( $_POST['do'] ?? '' ) ) ) );
        }

        echo '<div class="wrap"><h1>WP MCP Bridge</h1><nav class="nav-tab-wrapper">';
        foreach ( self::TABS as $key => $label ) {
            echo '<a class="nav-tab' . ( $key === $tab ? ' nav-tab-active' : '' ) . '" href="' . esc_url( add_query_arg( array( 'page' => 'wp-mcp-bridge', 'tab' => $key ), admin_url( 'tools.php' ) ) ) . '">' . esc_html( $label ) . '</a>';
        }
        echo '</nav>';
        if ( '' !== $out['notice'] ) {
            echo '<div class="notice notice-success"><p>' . esc_html( $out['notice'] ) . '</p></div>';
        }
        'activity' === $tab ? self::tab_activity() : ( 'media' === $tab ? self::tab_media() : self::tab_mcp( $out['code'] ) );
        echo '</div>';
    }

    /** @return array{code: string, notice: string} */
    private static function handle( string $do ): array {
        $post = static fn ( string $k, string $d = '' ): string => sanitize_text_field( wp_unslash( (string) ( $_POST[ $k ] ?? $d ) ) ); // phpcs:ignore WordPress.Security.NonceVerification
        $code = '';
        $note = '';
        if ( 'pair' === $do ) {
            $code = Connections::create_pairing( get_current_user_id(), sanitize_key( $post( 'ceiling', 'admin' ) ) );
        } elseif ( 'revoke' === $do ) {
            Connections::revoke( $post( 'key' ) );
        } elseif ( 'ceiling' === $do ) {
            Connections::set_ceiling( $post( 'key' ), sanitize_key( $post( 'ceiling' ) ) );
        } elseif ( 'media_save' === $do ) {
            Optimizer::save_settings( array( 'auto' => ! empty( $_POST['auto'] ), 'max_width' => $post( 'max_width' ), 'quality' => $post( 'quality' ), 'format' => $post( 'format' ) ) ); // phpcs:ignore WordPress.Security.NonceVerification
            $note = 'Saved.';
        } elseif ( 'register' === $do ) {
            $r    = Handlers\Media::op_register( array( 'scan' => true, 'limit' => 50 ), new Context( 'draft', 'media.register', wp_get_current_user()->user_login, '', '', false ) );
            $note = count( $r['registered'] ) . ' file(s) added to the media library.' . ( ! empty( $r['more'] ) ? ' Press again for the rest.' : '' );
        } elseif ( 'optimize' === $do ) {
            $r    = Handlers\Media::op_optimize( array( 'ids' => array( (int) $post( 'id' ) ) ), new Context( 'live', 'media.optimize', wp_get_current_user()->user_login, '', '', false ) );
            $item = $r['items'][0] ?? array();
            $note = 'optimized' === ( $item['status'] ?? '' ) ? 'Smaller by ' . (int) $item['saved_pct'] . '%.' : (string) ( $item['reason'] ?? 'Nothing changed.' );
        }

        return array( 'code' => $code, 'notice' => $note );
    }

    private static function tab_mcp( string $code ): void {
        echo '<p>Connects this site to a WP MCP gateway so AI assistants can manage it. Every request is signed; levels, confirmations and undo are built in. Nothing is reachable until you pair a gateway.</p>';
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

            return;
        }
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

    private static function tab_activity(): void {
        $rows = Activity::list( array( 'per_page' => 50 ) )['entries'];
        if ( array() === $rows ) {
            echo '<p>Nothing yet.</p>';

            return;
        }
        echo '<table class="widefat striped"><thead><tr><th>When (UTC)</th><th>Operation</th><th>Level</th><th>Result</th><th>By</th><th>Details</th><th>Revision</th></tr></thead><tbody>';
        foreach ( $rows as $row ) {
            echo '<tr><td>' . esc_html( (string) $row['created'] ) . '</td><td><code>' . esc_html( (string) $row['op'] ) . '</code></td><td>' . esc_html( (string) $row['level'] ) . '</td><td>' . esc_html( (string) $row['status'] ) . '</td><td>' . esc_html( (string) $row['actor'] ) . '</td><td>' . esc_html( (string) $row['summary'] ) . '</td><td>' . ( $row['revision'] ? '#' . (int) $row['revision'] : '' ) . '</td></tr>';
        }
        echo '</tbody></table>';
    }

    private static function tab_media(): void {
        $s = Optimizer::settings();
        echo '<h2>Shrink and convert uploads</h2><p>When on, every image uploaded in the WordPress media library (and by AI assistants) is resized and re-encoded. Metadata such as GPS and camera data is removed. GIF and SVG are left alone.</p><form method="post">';
        wp_nonce_field( 'wpm_bridge' );
        echo '<input type="hidden" name="do" value="media_save"><table class="form-table"><tr><th>Automatic</th><td><label><input type="checkbox" name="auto" value="1"' . checked( $s['auto'], true, false ) . '> Optimize new image uploads</label></td></tr>';
        echo '<tr><th>Max width (px)</th><td><input type="number" name="max_width" min="0" value="' . (int) $s['max_width'] . '"> <span class="description">0 = keep size</span></td></tr>';
        echo '<tr><th>Quality</th><td><input type="number" name="quality" min="30" max="100" value="' . (int) $s['quality'] . '"> <span class="description">80-85 is visually lossless for most photos</span></td></tr>';
        echo '<tr><th>Format</th><td><select name="format">';
        foreach ( array( 'keep' => 'Keep original', 'webp' => 'WebP (recommended)', 'avif' => 'AVIF', 'jpeg' => 'JPEG' ) as $v => $label ) {
            echo '<option value="' . esc_attr( $v ) . '"' . selected( $s['format'], $v, false ) . '>' . esc_html( $label ) . '</option>';
        }
        echo '</select></td></tr></table><p><button class="button button-primary">Save</button></p></form>';
        echo '<p class="description">Videos: ask your AI assistant to run <code>media.optimize</code>; it needs ffmpeg on the server' . ( '' === Optimizer::ffmpeg() ? ' (not found here).' : ' (found).' ) . '</p>';

        echo '<h2>Files not in the media library</h2><p>Files copied into <code>wp-content/uploads</code> by FTP or a file manager do not appear in the library and cannot be featured images until they are registered.</p><form method="post">';
        wp_nonce_field( 'wpm_bridge' );
        echo '<input type="hidden" name="do" value="register"><button class="button">Add up to 50 unregistered files to the library</button></form>';

        echo '<h2>Largest images</h2>';
        $q     = new \WP_Query( array( 'post_type' => 'attachment', 'post_status' => 'inherit', 'post_mime_type' => 'image', 'posts_per_page' => 60, 'orderby' => 'date', 'order' => 'DESC', 'fields' => 'ids', 'no_found_rows' => true ) );
        $sizes = array();
        foreach ( $q->posts as $id ) {
            $f = get_attached_file( (int) $id );
            if ( $f && is_file( $f ) ) {
                $sizes[ (int) $id ] = (int) filesize( $f );
            }
        }
        arsort( $sizes );
        echo '<table class="widefat striped"><thead><tr><th>File</th><th>Size</th><th></th></tr></thead><tbody>';
        foreach ( array_slice( $sizes, 0, 15, true ) as $id => $bytes ) {
            echo '<tr><td>' . esc_html( basename( (string) get_attached_file( $id ) ) ) . '</td><td>' . esc_html( size_format( $bytes ) ) . '</td><td><form method="post">';
            wp_nonce_field( 'wpm_bridge' );
            echo '<input type="hidden" name="do" value="optimize"><input type="hidden" name="id" value="' . (int) $id . '"><button class="button">Optimize</button></form></td></tr>';
        }
        echo '</tbody></table><p class="description">Optimizing replaces the file with the settings above. It cannot be undone.</p>';
    }

    private static function select( string $name, string $current ): string {
        $out = '<select name="' . esc_attr( $name ) . '">';
        foreach ( Levels::ALL as $level ) {
            $out .= '<option value="' . esc_attr( $level ) . '"' . selected( $current, $level, false ) . '>' . esc_html( $level ) . '</option>';
        }

        return $out . '</select>';
    }
}
