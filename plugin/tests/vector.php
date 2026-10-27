<?php
// Prints the signatures for a fixed input so the gateway test can compare them with its own.
define( 'ABSPATH', __DIR__ . '/' );
require dirname( __DIR__ ) . '/wp-mcp-bridge/includes/Signature.php';
use WPMCP\Bridge\Signature;
$secret = str_repeat( 'cd', 32 );
$nonce  = str_repeat( '9a', 16 );
$body   = '{"op":"content.save","args":{"title":"Salam – سلام"},"level":"live"}';
echo json_encode( array(
    'request'  => Signature::sign( $secret, '1700000123', $nonce, 'kABC', 'POST', '/wp-mcp/v1/call', $body ),
    'response' => Signature::response( $secret, $nonce, $body ),
) );
