<?php
/**
 * Safety checks for PHP the bridge puts on a site: a syntax check before it is written and a front-page probe after.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class PhpGuard {

    /**
     * Parse error of a PHP file's bytes (they must start with the opening tag), or null when the syntax is fine.
     */
    public static function problem( string $bytes ): ?string {
        try {
            token_get_all( $bytes, TOKEN_PARSE );
        } catch ( \ParseError $e ) {
            return 'PHP syntax error on line ' . $e->getLine() . ': ' . $e->getMessage();
        }

        return null;
    }

    /**
     * Same check for a bare code fragment (no opening tag), as a code snippet is stored. Line numbers count from the fragment.
     */
    public static function fragment_problem( string $code ): ?string {
        $problem = self::problem( "<?php\n" . $code );

        return null === $problem ? null : (string) preg_replace_callback( '/on line (\d+)/', static fn ( array $m ): string => 'on line ' . max( 1, (int) $m[1] - 1 ), $problem );
    }

    /**
     * Does the front page still answer without a server error? Null when the check itself could not run.
     */
    public static function front_ok(): ?bool {
        try {
            return Util::fetch_own( home_url( '/?wpm_check=' . time() ) )['status'] < 500;
        } catch ( BridgeError $e ) {
            return null;
        }
    }
}
