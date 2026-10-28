<?php
declare(strict_types=1);

namespace WPM\Agent;

defined('WPM_AGENT') || exit;

final class ApiError extends \RuntimeException
{
    public function __construct(public readonly string $errorCode, string $message, public readonly int $status = 400, public readonly mixed $data = null)
    {
        parent::__construct($message);
    }
}
