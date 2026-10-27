<?php
/**
 * An error the gateway can show to the AI as-is (code + readable message).
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge;

defined( 'ABSPATH' ) || exit;

final class BridgeError extends \RuntimeException {

    /** @var mixed */
    public $data;

    public string $error_code;

    public int $status;

    /**
     * @param mixed $data Extra detail for the caller.
     */
    public function __construct( string $error_code, string $message, int $status = 400, $data = null ) {
        parent::__construct( $message );
        $this->error_code = $error_code;
        $this->status     = $status;
        $this->data       = $data;
    }
}
