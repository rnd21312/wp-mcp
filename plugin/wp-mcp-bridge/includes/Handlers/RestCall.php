<?php
/**
 * rest.* operations: the generic layer to any plugin's REST API, run internally as the connected administrator.
 *
 * @package WPMCP\Bridge
 */

declare(strict_types=1);

namespace WPMCP\Bridge\Handlers;

use WPMCP\Bridge\BridgeError;
use WPMCP\Bridge\Context;
use WPMCP\Bridge\Policy;
use WPMCP\Bridge\Revisions;

defined( 'ABSPATH' ) || exit;

final class RestCall {

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_routes( array $a, Context $c ): array {
        $server = rest_get_server();
        $ns     = (string) ( $a['namespace'] ?? '' );
        $find   = strtolower( (string) ( $a['search'] ?? '' ) );
        $routes = array();
        foreach ( $server->get_routes() as $route => $handlers ) {
            if ( str_starts_with( $route, '/wp-mcp/' ) ) {
                continue;
            }
            if ( '' !== $ns && ! str_starts_with( ltrim( $route, '/' ), trim( $ns, '/' ) . '/' ) && ltrim( $route, '/' ) !== trim( $ns, '/' ) ) {
                continue;
            }
            if ( '' !== $find && ! str_contains( strtolower( $route ), $find ) ) {
                continue;
            }
            $methods = array();
            foreach ( $handlers as $h ) {
                $methods = array_merge( $methods, array_keys( (array) ( $h['methods'] ?? array() ) ) );
            }
            $rule = Policy::rest_rule( 'GET', $route );
            $routes[] = array( 'route' => $route, 'methods' => array_values( array_unique( $methods ) ), 'get_level' => $rule['level'] ?? 'blocked' );
        }
        $namespaces = array_values( array_filter( (array) $server->get_namespaces(), static fn ( $n ) => 'wp-mcp/v1' !== $n ) );

        return array( 'namespaces' => $namespaces, 'routes' => array_slice( $routes, 0, 200 ), 'total' => count( $routes ), 'hint' => 'Use rest.call {method, path}. Pass namespace or search to narrow the list.' );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array{0: string, 1: string, 2: array{level: string, confirm: bool}}
     */
    private static function rule( array $a ): array {
        $method = strtoupper( (string) $a['method'] );
        $path   = Policy::rest_path( (string) $a['path'] );
        $rule   = null === $path ? null : Policy::rest_rule( $method, $path );
        if ( null === $path || null === $rule ) {
            throw new BridgeError( 'blocked_route', 'This route or method is not allowed through the bridge.', 403 );
        }

        return array( $method, $path, $rule );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function preview_call( array $a, Context $c ): array {
        [ $method, $path, $rule ] = self::rule( $a );
        $c->need( $rule['level'], 'This route is classified as ' . $rule['level'] . '.' );

        return array( 'would_call' => "$method $path", 'level_needed' => $rule['level'], 'needs_confirmation' => $rule['confirm'], 'body' => \WPMCP\Bridge\Policy::redact( $a['body'] ?? null ) );
    }

    /**
     * @param array<string, mixed> $a Arguments.
     * @return array<string, mixed>
     */
    public static function op_call( array $a, Context $c ): array {
        [ $method, $path, $rule ] = self::rule( $a );
        $c->need( $rule['level'], 'This route is classified as ' . $rule['level'] . '.' );

        $before = null;
        if ( 'GET' !== $method && preg_match( '#^/wp/v2/[a-z_-]+/(\d+)$#', $path, $m ) && get_post( (int) $m[1] ) ) {
            $before = array( (int) $m[1], Revisions::snap_post( (int) $m[1] ) );
        }

        $request = new \WP_REST_Request( $method, $path );
        $query   = (array) ( $a['query'] ?? array() );
        $body    = (array) ( $a['body'] ?? array() );
        if ( 'GET' === $method ) {
            $request->set_query_params( $query + $body );
        } else {
            $request->set_query_params( $query );
            $request->set_header( 'Content-Type', 'application/json' );
            $request->set_body( (string) wp_json_encode( $body ) );
            $request->set_body_params( $body );
        }
        $response = rest_do_request( $request );
        $status   = (int) $response->get_status();
        $data     = rest_get_server()->response_to_data( $response, false );
        if ( $status >= 400 ) {
            throw new BridgeError( 'rest_error', is_array( $data ) && isset( $data['message'] ) ? (string) $data['message'] : "The route answered HTTP $status.", $status >= 500 ? 502 : 400, array( 'rest_status' => $status, 'rest_code' => $data['code'] ?? null ) );
        }
        if ( null !== $before ) {
            Revisions::record( $c, 'post', (string) $before[0], $before[1] );
        }
        $c->summary = "$method $path";
        $data       = Policy::redact( $data );
        $headers    = array_intersect_key( $response->get_headers(), array_flip( array( 'X-WP-Total', 'X-WP-TotalPages' ) ) );
        $json       = (string) wp_json_encode( $data );
        if ( strlen( $json ) > 150000 ) {
            return array( 'status' => $status, 'truncated' => true, 'bytes' => strlen( $json ), 'headers' => $headers, 'hint' => 'Response too large; use query params (per_page, page, _fields, context=view).' );
        }

        return array( 'status' => $status, 'headers' => $headers, 'data' => $data );
    }
}
