<?php
/**
 * The shared operation list (ops.json), generated from the project's single spec.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class Spec {

    /** @var array<string, array<string, mixed>>|null */
    private static ?array $ops = null;

    /**
     * @return array<string, array<string, mixed>>
     */
    public static function all(): array {
        if ( null === self::$ops ) {
            $raw       = is_file( WPMCP_DIR . 'ops.json' ) ? (string) file_get_contents( WPMCP_DIR . 'ops.json' ) : '{}';
            $data      = json_decode( $raw, true );
            self::$ops = array();
            foreach ( (array) ( $data['ops'] ?? array() ) as $op ) {
                self::$ops[ (string) $op['id'] ] = $op;
            }
        }

        return self::$ops;
    }

    /**
     * @return array<string, mixed>|null
     */
    public static function op( string $id ): ?array {
        return self::all()[ $id ] ?? null;
    }

    /** Handler class for a tool name. */
    public static function handler_class( string $tool ): ?string {
        $map = array(
            'site'     => 'Site',
            'content'  => 'Content',
            'design'   => 'Design',
            'media'    => 'Media',
            'seo'      => 'Seo',
            'inspect'  => 'Inspect',
            'maintain' => 'Maintain',
            'plugins'  => 'PluginOps',
            'users'    => 'UserOps',
            'options'  => 'OptionOps',
            'rest'     => 'RestCall',
            'shop'     => 'Shop',
            'forms'    => 'Forms',
            'activity' => 'ActivityOps',
        );

        return isset( $map[ $tool ] ) ? 'WPMCP\\Bridge\\Handlers\\' . $map[ $tool ] : null;
    }
}
