<?php
declare(strict_types=1);

defined('WPM_AGENT') || exit;

// Public key (base64, 32 bytes, Ed25519) that agent updates must be signed with.
// Empty = signed self-update is disabled. Create the pair with: npm run release:keygen -- <path outside this repository>
return '';
