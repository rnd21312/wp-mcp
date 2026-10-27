<?php
/**
 * One call's identity: who asked, at which level, and what the handler produced besides data.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class Context {

    public int $revision = 0;

    public string $summary = '';

    public function __construct(
        public string $level,
        public string $op,
        public string $actor = '',
        public string $client = '',
        public string $request_id = '',
        public bool $dry_run = false
    ) {}

    public function can( string $level ): bool {
        return Levels::at_least( $this->level, $level );
    }

    /** Throws unless the effective level is at least $level. */
    public function need( string $level, string $why = '' ): void {
        if ( ! $this->can( $level ) ) {
            throw new BridgeError(
                'level_too_low',
                sprintf( '%s needs level %s but your level on this site is %s.%s', $this->op, $level, $this->level, '' !== $why ? ' ' . $why : '' ),
                403,
                array( 'needs' => $level, 'have' => $this->level )
            );
        }
    }
}
