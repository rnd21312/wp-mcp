<?php
/**
 * design.theme_scaffold: builds a theme on the site from one of the base themes shipped in scaffold/themes.
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

final class Scaffold {

    private static function dir(): string {
        return WPMCP_DIR . 'scaffold/themes/';
    }

    /**
     * @return array<string, array<string, mixed>> base name => manifest
     */
    public static function bases(): array {
        $out = array();
        foreach ( (array) glob( self::dir() . '*/base.json' ) as $file ) {
            $manifest = json_decode( (string) file_get_contents( $file ), true );
            if ( is_array( $manifest ) ) {
                $out[ basename( dirname( $file ) ) ] = $manifest;
            }
        }
        ksort( $out );

        return $out;
    }

    /**
     * Template files of a base (an extending base overlays its parent), path => content.
     *
     * @return array<string, string>
     */
    private static function templates( string $base, array $manifests ): array {
        $files = array();
        if ( ! empty( $manifests[ $base ]['extends'] ) ) {
            $files = self::templates( (string) $manifests[ $base ]['extends'], $manifests );
        }
        $root = self::dir() . $base . '/files';
        if ( ! is_dir( $root ) ) {
            return $files;
        }
        $it = new \RecursiveIteratorIterator( new \RecursiveDirectoryIterator( $root, \FilesystemIterator::SKIP_DOTS ) );
        foreach ( $it as $file ) {
            if ( $file->isFile() ) {
                $rel           = ltrim( str_replace( '\\', '/', substr( $file->getPathname(), strlen( $root ) ) ), '/' );
                $files[ $rel ] = (string) file_get_contents( $file->getPathname() );
            }
        }
        ksort( $files );

        return $files;
    }

    /**
     * Everything a scaffold call needs, validated.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array{slug: string, name: string, base: string, tokens: array<string, mixed>, files: list<array{path: string, content: string}>}
     */
    public static function plan( array $a ): array {
        $manifests = self::bases();
        $base      = (string) ( $a['base'] ?? '' );
        if ( ! isset( $manifests[ $base ] ) ) {
            throw new BridgeError( 'bad_arguments', 'base must be one of: ' . implode( ', ', array_keys( $manifests ) ) . '.', 400 );
        }
        $slug   = Policy::scaffold_slug( (string) ( $a['slug'] ?? '' ) );
        $name   = Policy::scaffold_name( (string) ( $a['name'] ?? '' ) );
        $tokens = Policy::scaffold_tokens( (array) ( $manifests[ $base ]['tokens'] ?? array() ), (array) ( $a['tokens'] ?? array() ) );
        $vars   = Policy::scaffold_vars( $tokens, $slug, $name );
        $files  = array();
        foreach ( self::templates( $base, $manifests ) as $path => $content ) {
            $files[] = array( 'path' => $path, 'content' => Policy::scaffold_render( $content, $vars ) );
        }

        return array( 'slug' => $slug, 'name' => $name, 'base' => $base, 'tokens' => $tokens, 'files' => $files );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function bases_info( array $a, Context $c ): array {
        $out = array();
        foreach ( self::bases() as $name => $m ) {
            $out[] = array( 'base' => $name, 'title' => $m['title'] ?? $name, 'kind' => $m['kind'] ?? '', 'description' => $m['description'] ?? '', 'default_tokens' => $m['tokens'] ?? array() );
        }

        return array( 'bases' => $out, 'usage' => 'design.theme_scaffold {base, slug, name, tokens?}' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview( array $a, Context $c ): array {
        $p      = self::plan( $a );
        $exists = wp_get_theme( $p['slug'] )->exists();

        return array(
            'will_create'   => 'themes/' . $p['slug'],
            'base'          => $p['base'],
            'exists'        => $exists,
            'blocked'       => $exists && empty( $a['overwrite'] ) ? 'A theme with this slug exists; pass overwrite:true to replace its files.' : null,
            'files'         => array_map( static fn ( array $f ): array => array( 'path' => $f['path'], 'bytes' => strlen( $f['content'] ) ), $p['files'] ),
            'tokens'        => $p['tokens'],
            'sets_tokens'   => ! isset( $a['apply_tokens'] ) || (bool) $a['apply_tokens'],
            'will_activate' => ! empty( $a['activate'] ),
        );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function create( array $a, Context $c ): array {
        $p = self::plan( $a );
        if ( wp_get_theme( $p['slug'] )->exists() && empty( $a['overwrite'] ) ) {
            throw new BridgeError( 'exists', 'A theme with this slug already exists. Pass overwrite:true to replace its files, or choose another slug.', 409 );
        }
        $written = Files::op_write_many( array( 'root' => 'themes/' . $p['slug'], 'files' => $p['files'] ), $c );
        $notes   = array();
        if ( ! isset( $a['apply_tokens'] ) || (bool) $a['apply_tokens'] ) {
            Design::op_tokens_set( array_intersect_key( $p['tokens'], array_flip( array( 'colors', 'fonts', 'font_sizes', 'spacing', 'radius', 'content_width' ) ) ), $c );
            $notes[] = 'The tokens were also saved as the site design tokens (design.tokens_get).';
        }
        $active = get_stylesheet();
        if ( ! empty( $a['activate'] ) ) {
            if ( ! wp_get_theme( $p['slug'] )->exists() ) {
                throw new BridgeError( 'not_found', 'The theme was written but WordPress does not see it (check design.themes_list).', 500 );
            }
            switch_theme( $p['slug'] );
            Revisions::record( $c, 'theme', $p['slug'], $active );
            $active  = $p['slug'];
            $notes[] = 'The theme is now active.';
        }
        $c->summary = "scaffolded theme {$p['slug']} from {$p['base']} (" . count( $p['files'] ) . ' files)';

        return array( 'theme' => $p['slug'], 'base' => $p['base'], 'files' => array_map( static fn ( array $f ): string => (string) $f['path'], $written['files'] ), 'active_theme' => $active, 'notes' => $notes, 'next' => 'Add menu items with design.menu_save (location primary), the logo with design.branding_set, then check the front page with inspect.page. Fonts: files.fetch_many into themes/' . $p['slug'] . '/assets/fonts.' );
    }
}
