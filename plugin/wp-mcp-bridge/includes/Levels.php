<?php
/**
 * Permission levels: read < draft < live < admin.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class Levels {

    public const ALL = array( 'read', 'draft', 'live', 'admin' );

    public static function valid( string $level ): bool {
        return in_array( $level, self::ALL, true );
    }

    public static function rank( string $level ): int {
        $at = array_search( $level, self::ALL, true );
        return false === $at ? -1 : (int) $at;
    }

    public static function at_least( string $have, string $need ): bool {
        return self::rank( $have ) >= self::rank( $need ) && self::rank( $have ) >= 0;
    }

    public static function min( string $a, string $b ): string {
        return self::rank( $a ) <= self::rank( $b ) ? $a : $b;
    }

    public static function max( string $a, string $b ): string {
        return self::rank( $a ) >= self::rank( $b ) ? $a : $b;
    }
}
