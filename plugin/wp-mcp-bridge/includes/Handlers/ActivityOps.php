<?php
/**
 * activity.* operations.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\Activity;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\Revisions;

defined( 'ABSPATH' ) || exit;

final class ActivityOps {

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_list( array $a, Context $c ): array {
        return Activity::list( $a );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_revisions( array $a, Context $c ): array {
        return Revisions::list( $a );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_undo( array $a, Context $c ): array {
        return Revisions::undo( (int) $a['revision'], $c );
    }
}
