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

    /** Parse error of a file about to be written, by its name: only .php files are checked. */
    public static function file_problem( string $path, string $bytes ): ?string {
        return 'php' === strtolower( pathinfo( $path, PATHINFO_EXTENSION ) ) ? self::problem( $bytes ) : null;
    }

    /**
     * Writes a file with the safety net every PHP-writing operation shares: syntax check first (nothing is written on an error),
     * a probe of the front page before and after, and a revert when the site stops answering.
     *
     * @param callable $revert Puts the file back as it was; called only when the site broke.
     */
    public static function write( string $full, string $path, string $bytes, callable $revert ): void {
        $problem = self::file_problem( $path, $bytes );
        if ( null !== $problem ) {
            throw new BridgeError( 'syntax_error', $problem . ' Nothing was written.', 400 );
        }
        $healthy = 'php' === strtolower( pathinfo( $path, PATHINFO_EXTENSION ) ) ? self::front_ok() : null;
        Util::write_atomic( $full, $bytes );
        if ( true === $healthy && false === self::front_ok() ) {
            $revert();
            throw new BridgeError( 'broke_site', 'The site returned a server error after this change, so it was reverted automatically. Check maintain.logs for the PHP error.', 409 );
        }
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
