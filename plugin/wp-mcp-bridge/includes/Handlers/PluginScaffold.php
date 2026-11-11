<?php
/**
 * plugins.scaffold: the skeleton of a new plugin from the files in scaffold/plugin, written to the site and/or packed as a zip.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\Policy;

defined( 'ABSPATH' ) || exit;

final class PluginScaffold {

    public const FEATURES = array( 'admin_page', 'shortcode', 'rest', 'cpt' );

    /**
     * Files of one template folder, relative path => content.
     *
     * @return array<string, string>
     */
    private static function read( string $folder ): array {
        $root = WPMCP_DIR . 'scaffold/plugin/' . $folder;
        $out  = array();
        if ( ! is_dir( $root ) ) {
            return $out;
        }
        $it = new \RecursiveIteratorIterator( new \RecursiveDirectoryIterator( $root, \FilesystemIterator::SKIP_DOTS ) );
        foreach ( $it as $file ) {
            if ( $file->isFile() ) {
                $rel         = (string) preg_replace( '/\.tpl$/', '', ltrim( str_replace( '\\', '/', substr( $file->getPathname(), strlen( $root ) ) ), '/' ) ); // stored as *.php.tpl so they are not linted or run as PHP
                $out[ $rel ] = (string) file_get_contents( $file->getPathname() );
            }
        }

        return $out;
    }

    /**
     * Validated arguments and the rendered files.
     *
     * @param array<string, mixed> $a Arguments.
     * @return array{slug: string, name: string, features: list<string>, files: list<array{path: string, content: string}>}
     */
    public static function plan( array $a ): array {
        $slug     = Policy::scaffold_slug( (string) ( $a['slug'] ?? '' ) );
        $name     = Policy::scaffold_name( (string) ( $a['name'] ?? '' ) );
        $features = array();
        foreach ( (array) ( $a['features'] ?? array() ) as $feature ) {
            $feature = (string) $feature;
            if ( ! in_array( $feature, self::FEATURES, true ) ) {
                throw new BridgeError( 'bad_arguments', "Unknown feature \"$feature\". Features: " . implode( ', ', self::FEATURES ) . '.', 400 );
            }
            $features[ $feature ] = $feature;
        }
        $features = array_values( $features );
        $prefix   = str_replace( '-', '_', $slug );
        $vars     = array(
            'slug'        => $slug,
            'name'        => $name,
            'description' => Policy::scaffold_text( (string) ( $a['description'] ?? '' ), $name . ' plugin.' ),
            'author'      => Policy::scaffold_text( (string) ( $a['author'] ?? '' ), 'Site owner' ),
            'prefix'      => $prefix,
            'class'       => implode( '_', array_map( 'ucfirst', explode( '_', $prefix ) ) ),
            'const'       => strtoupper( $prefix ),
        );
        $templates = self::read( 'base' );
        foreach ( $features as $feature ) {
            $templates += self::read( 'feature-' . $feature );
        }
        $files = array();
        foreach ( $templates as $path => $content ) {
            $target  = 'plugin.php' === $path ? $slug . '.php' : ( 'includes/class-plugin.php' === $path ? 'includes/class-' . $slug . '.php' : $path );
            $files[] = array( 'path' => $target, 'content' => Policy::scaffold_render( $content, $vars ) );
        }
        usort( $files, static fn ( array $x, array $y ): int => strcmp( $x['path'], $y['path'] ) );

        return array( 'slug' => $slug, 'name' => $name, 'features' => $features, 'files' => $files );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview( array $a, Context $c ): array {
        $p       = self::plan( $a );
        $install = ! empty( $a['install'] );
        $zip     = ! empty( $a['zip'] );

        return array(
            'files'              => array_map( static fn ( array $f ): array => array( 'path' => $f['path'], 'bytes' => strlen( $f['content'] ) ), $p['files'] ),
            'features'           => $p['features'],
            'installs_into'      => $install ? 'plugins/' . $p['slug'] : null,
            'exists'             => $install && is_dir( WP_PLUGIN_DIR . '/' . $p['slug'] ),
            'makes_zip'          => $zip,
            'needs_confirmation' => $install || $zip,
            'note'               => $install || $zip ? 'The plugin is only written, never activated. Activate it with plugins.activate when it is ready.' : 'Nothing is written: the files are only returned. Pass install:true to put the plugin on the site, zip:true to also get a zip.',
        );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function create( array $a, Context $c ): array {
        $p      = self::plan( $a );
        $result = array( 'plugin' => $p['slug'], 'features' => $p['features'], 'files' => array_column( $p['files'], 'path' ) );
        if ( empty( $a['install'] ) && empty( $a['zip'] ) ) {
            $result['contents'] = $p['files'];
            $c->summary         = "plugin skeleton {$p['slug']} (not written)";

            return $result;
        }
        if ( ! empty( $a['install'] ) ) {
            if ( is_dir( WP_PLUGIN_DIR . '/' . $p['slug'] ) && empty( $a['overwrite'] ) ) {
                throw new BridgeError( 'exists', 'A plugin folder with this slug exists. Pass overwrite:true to replace its files, or choose another slug.', 409 );
            }
            Files::op_write_many( array( 'root' => 'plugins/' . $p['slug'], 'files' => $p['files'] ), $c );
            $result['installed'] = 'plugins/' . $p['slug'];
            $result['next']      = 'plugins.activate ' . $p['slug'] . '/' . $p['slug'] . '.php when it is ready.';
        }
        if ( ! empty( $a['zip'] ) ) {
            $result['zip'] = self::zip( $p );
        }
        $c->summary = "scaffolded plugin {$p['slug']} (" . count( $p['files'] ) . ' files)';

        return $result;
    }

    /**
     * @param array{slug: string, files: list<array{path: string, content: string}>} $p Plan.
     * @return array<string, mixed>
     */
    private static function zip( array $p ): array {
        if ( ! class_exists( '\ZipArchive' ) ) {
            throw new BridgeError( 'no_zip', 'PHP ZipArchive is not available on this server.', 501 );
        }
        $up  = wp_upload_dir( null, false );
        $dir = rtrim( (string) $up['basedir'], '/\\' ) . '/wpmcp-exports';
        wp_mkdir_p( $dir );
        $file = $dir . '/' . $p['slug'] . '.zip';
        $zip  = new \ZipArchive();
        if ( true !== $zip->open( $file, \ZipArchive::CREATE | \ZipArchive::OVERWRITE ) ) {
            throw new BridgeError( 'zip_failed', 'The zip could not be created (permissions?).', 500 );
        }
        foreach ( $p['files'] as $f ) {
            $zip->addFromString( $p['slug'] . '/' . $f['path'], $f['content'] );
        }
        $zip->close();

        return array( 'url' => rtrim( (string) $up['baseurl'], '/' ) . '/wpmcp-exports/' . $p['slug'] . '.zip', 'bytes' => (int) filesize( $file ), 'note' => 'The zip holds only the generated skeleton. Delete it with files.delete (root uploads, path wpmcp-exports/' . $p['slug'] . '.zip) when you are done.' );
    }
}
