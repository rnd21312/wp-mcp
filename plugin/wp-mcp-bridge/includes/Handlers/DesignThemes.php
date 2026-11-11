<?php
/**
 * Part of Design: themes, theme files, scaffolds, the design system.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\PhpGuard;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Revisions;
use WPMCP\Bridge\Util;

defined( 'ABSPATH' ) || exit;

trait DesignThemes {

    /* ------------------------------------------------------------------ themes */

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_themes_list( array $a, Context $c ): array {
        $updates = (array) ( get_site_transient( 'update_themes' )->response ?? array() );
        $out     = array();
        foreach ( wp_get_themes() as $slug => $t ) {
            $out[] = array( 'slug' => $slug, 'name' => $t->get( 'Name' ), 'version' => $t->get( 'Version' ), 'active' => get_stylesheet() === $slug, 'parent' => $t->parent() ? $t->parent()->get_stylesheet() : null, 'update' => isset( $updates[ $slug ] ) ? ( $updates[ $slug ]['new_version'] ?? true ) : null, 'block_theme' => method_exists( $t, 'is_block_theme' ) && $t->is_block_theme() );
        }

        return array( 'themes' => $out );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_theme_activate( array $a, Context $c ): array {
        $t = wp_get_theme( sanitize_key( (string) $a['slug'] ) );
        if ( ! $t->exists() ) {
            throw new BridgeError( 'not_found', 'No such theme.', 404 );
        }

        return array( 'will_switch' => array( 'from' => get_stylesheet(), 'to' => $t->get_stylesheet() ), 'effect' => 'The whole site look changes immediately. Menus and widgets may need re-assigning.', 'undo' => 'possible' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_theme_activate( array $a, Context $c ): array {
        $slug = sanitize_key( (string) $a['slug'] );
        if ( ! wp_get_theme( $slug )->exists() ) {
            throw new BridgeError( 'not_found', 'No such theme.', 404 );
        }
        $from = get_stylesheet();
        switch_theme( $slug );
        Revisions::record( $c, 'theme', $slug, $from );
        $c->summary = "activated theme $slug (was $from)";

        return array( 'active' => $slug, 'previous' => $from );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_theme_install( array $a, Context $c ): array {
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/misc.php';
        require_once ABSPATH . 'wp-admin/includes/theme.php';
        require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
        $slug = sanitize_key( (string) $a['slug'] );
        $info = themes_api( 'theme_information', array( 'slug' => $slug, 'fields' => array( 'sections' => false ) ) );
        if ( is_wp_error( $info ) ) {
            throw new BridgeError( 'not_found', 'WordPress.org has no theme "' . $slug . '".', 404 );
        }
        Maintain::require_direct_fs();
        $upgrader = new \Theme_Upgrader( new \Automatic_Upgrader_Skin() );
        $result   = $upgrader->install( $info->download_link );
        if ( is_wp_error( $result ) || ! $result ) {
            throw new BridgeError( 'install_failed', is_wp_error( $result ) ? $result->get_error_message() : 'Installation failed.', 500 );
        }
        if ( ! empty( $a['activate'] ) ) {
            $from = get_stylesheet();
            switch_theme( $slug );
            Revisions::record( $c, 'theme', $slug, $from );
        }
        $c->summary = "installed theme $slug";

        return array( 'installed' => $slug, 'activated' => ! empty( $a['activate'] ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_theme_install_zip( array $a, Context $c ): array {
        $problem = Policy::url_problem( (string) $a['url'] );

        return array( 'will_download' => (string) $a['url'], 'host' => wp_parse_url( (string) $a['url'], PHP_URL_HOST ), 'allowed' => null === $problem, 'problem' => $problem, 'warning' => 'A theme runs PHP code with full access to this site.', 'rules' => 'https only, redirects re-checked, no private addresses, max 40 MB' );
    }

    /**
     * Installs a theme from an https zip URL (GitHub release, own server).
     *
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_theme_install_zip( array $a, Context $c ): array {
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/misc.php';
        require_once ABSPATH . 'wp-admin/includes/theme.php';
        require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
        Maintain::require_direct_fs();
        $tmp = wp_tempnam( 'wpm-theme.zip' );
        try {
            Util::download( (string) $a['url'], 41943040, $tmp );
            if ( "PK" !== (string) file_get_contents( $tmp, false, null, 0, 4 ) ) {
                throw new BridgeError( 'not_zip', 'The download is not a zip file.', 400 );
            }
            $upgrader = new \Theme_Upgrader( new \Automatic_Upgrader_Skin() );
            $result   = $upgrader->install( $tmp, array( 'overwrite_package' => ! empty( $a['overwrite'] ) ) );
        } finally {
            @unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        }
        if ( is_wp_error( $result ) || ! $result ) {
            throw new BridgeError( 'install_failed', is_wp_error( $result ) ? $result->get_error_message() : 'Installation failed (a theme with this folder may already exist: pass overwrite:true).', 500 );
        }
        $slug = (string) ( $upgrader->theme_info() ? $upgrader->theme_info()->get_stylesheet() : '' );
        if ( ! empty( $a['activate'] ) && '' !== $slug ) {
            $from = get_stylesheet();
            switch_theme( $slug );
            Revisions::record( $c, 'theme', $slug, $from );
        }
        $c->summary = "installed theme $slug from zip";

        return array( 'installed' => $slug, 'activated' => ! empty( $a['activate'] ) && '' !== $slug );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_theme_delete( array $a, Context $c ): array {
        $slug = sanitize_key( (string) $a['theme'] );

        return array( 'will_delete' => $slug, 'active' => get_stylesheet() === $slug || get_template() === $slug, 'warning' => 'Removes the theme folder and every file in it.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_theme_delete( array $a, Context $c ): array {
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/theme.php';
        $slug = sanitize_key( (string) $a['theme'] );
        if ( ! wp_get_theme( $slug )->exists() ) {
            throw new BridgeError( 'not_found', 'No such theme.', 404 );
        }
        if ( get_stylesheet() === $slug || get_template() === $slug ) {
            throw new BridgeError( 'active_theme', 'Activate another theme first; the active theme (or its parent) cannot be deleted.', 409 );
        }
        Maintain::require_direct_fs();
        $res = delete_theme( $slug );
        if ( is_wp_error( $res ) || ! $res ) {
            throw new BridgeError( 'delete_failed', is_wp_error( $res ) ? $res->get_error_message() : 'The theme could not be deleted.', 500 );
        }
        $c->summary = "deleted theme $slug";

        return array( 'deleted' => $slug );
    }

    /* ------------------------------------------------------------- theme files */

    private static function theme_dir( string $slug ): string {
        $theme = wp_get_theme( '' === $slug ? get_stylesheet() : sanitize_key( $slug ) );
        if ( ! $theme->exists() ) {
            throw new BridgeError( 'not_found', 'No such theme.', 404 );
        }

        return wp_normalize_path( $theme->get_stylesheet_directory() );
    }

    private static function resolve( string $dir, string $relative, bool $must_exist ): string {
        if ( ! Policy::theme_path_ok( $relative ) ) {
            throw new BridgeError( 'bad_path', 'Path must be inside the theme, with a known extension (php css js json html txt svg md twig), no dot files and no "..".', 400 );
        }
        $full = $dir . '/' . $relative;
        $real = realpath( $full );
        if ( $must_exist && ( false === $real || ! str_starts_with( wp_normalize_path( $real ), $dir . '/' ) ) ) {
            throw new BridgeError( 'not_found', 'No such file in the theme.', 404 );
        }
        $parent = realpath( dirname( $full ) );
        if ( ! $must_exist && false !== $parent && ! str_starts_with( wp_normalize_path( $parent ) . '/', $dir . '/' ) ) {
            throw new BridgeError( 'bad_path', 'Path escapes the theme directory.', 400 );
        }

        return $full;
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_theme_files( array $a, Context $c ): array {
        $dir   = self::theme_dir( (string) ( $a['theme'] ?? '' ) );
        $files = array();
        $it    = new \RecursiveIteratorIterator( new \RecursiveDirectoryIterator( $dir, \FilesystemIterator::SKIP_DOTS ), \RecursiveIteratorIterator::SELF_FIRST );
        $it->setMaxDepth( 4 );
        foreach ( $it as $file ) {
            if ( $file->isFile() && count( $files ) < 400 ) {
                $rel = ltrim( substr( wp_normalize_path( $file->getPathname() ), strlen( $dir ) ), '/' );
                if ( Policy::theme_path_ok( $rel ) && ! str_contains( $rel, 'node_modules/' ) ) {
                    $files[] = array( 'path' => $rel, 'bytes' => $file->getSize() );
                }
            }
        }
        sort( $files );

        return array( 'theme' => basename( $dir ), 'files' => $files );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_theme_file_read( array $a, Context $c ): array {
        $dir  = self::theme_dir( (string) ( $a['theme'] ?? '' ) );
        $full = self::resolve( $dir, (string) $a['path'], true );
        $size = (int) filesize( $full );
        $off  = max( 0, (int) ( $a['offset'] ?? 0 ) );
        $text = (string) file_get_contents( $full, false, null, $off, 100000 );

        return array( 'path' => (string) $a['path'], 'bytes' => $size, 'offset' => $off, 'truncated' => $off + strlen( $text ) < $size, 'content' => $text );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_theme_file_write( array $a, Context $c ): array {
        $dir  = self::theme_dir( (string) ( $a['theme'] ?? '' ) );
        $full = self::resolve( $dir, (string) $a['path'], false );

        return array( 'will_write' => (string) $a['path'], 'exists' => is_file( $full ), 'old_bytes' => is_file( $full ) ? filesize( $full ) : 0, 'new_bytes' => strlen( (string) $a['content'] ), 'syntax' => PhpGuard::file_problem( (string) $a['path'], (string) $a['content'] ) ?? 'ok', 'safety_net' => 'For PHP files the front page is checked afterwards and the change is reverted automatically if it causes a fatal error.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_theme_file_write( array $a, Context $c ): array {
        $slug    = (string) ( $a['theme'] ?? '' );
        $dir     = self::theme_dir( $slug );
        $rel     = (string) $a['path'];
        $content = (string) $a['content'];
        $full    = self::resolve( $dir, $rel, false );
        if ( strlen( $content ) > 500000 ) {
            throw new BridgeError( 'too_large', 'File is larger than 500 KB.', 400 );
        }
        $existed = is_file( $full );
        $old     = $existed ? (string) file_get_contents( $full ) : '';
        PhpGuard::write( $full, $rel, $content, fn () => $existed ? Util::write_atomic( $full, $old ) : @unlink( $full ) ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
        Revisions::record( $c, 'file', basename( $dir ) . '|' . $rel, array( 'theme' => basename( $dir ), 'path' => $rel, 'exists' => $existed, 'content' => $old ) );
        $c->summary = "wrote theme file $rel (" . strlen( $content ) . ' bytes)';

        return array( 'path' => $rel, 'bytes' => strlen( $content ), 'created' => ! $existed );
    }

    /**
     * @param array<string, mixed> $before Snapshot.
     */
    public static function restore_file( string $target, array $before ): string {
        $dir  = self::theme_dir( (string) ( $before['theme'] ?? '' ) );
        $rel  = (string) ( $before['path'] ?? '' );
        $full = self::resolve( $dir, $rel, false );
        if ( ! empty( $before['exists'] ) ) {
            Util::write_atomic( $full, (string) $before['content'] );

            return "Restored $rel.";
        }
        if ( is_file( $full ) ) {
            unlink( $full );
        }

        return "Removed $rel (it did not exist before).";
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_tokens_sync( array $a, Context $c ): array {
        return DesignSystem::preview_sync( $a, $c );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_tokens_sync( array $a, Context $c ): array {
        return DesignSystem::sync( $a, $c );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_tokens_audit( array $a, Context $c ): array {
        return DesignSystem::audit( $a, $c );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_patterns_list( array $a, Context $c ): array {
        return DesignSystem::patterns_list( $a, $c );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_pattern_get( array $a, Context $c ): array {
        return DesignSystem::pattern_get( $a, $c );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_theme_bases( array $a, Context $c ): array {
        return Scaffold::bases_info( $a, $c );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_theme_scaffold( array $a, Context $c ): array {
        return Scaffold::preview( $a, $c );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_theme_scaffold( array $a, Context $c ): array {
        return Scaffold::create( $a, $c );
    }
}
