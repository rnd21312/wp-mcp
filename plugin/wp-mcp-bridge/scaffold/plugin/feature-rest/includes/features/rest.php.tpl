<?php
/**
 * REST route /wp-json/{{slug}}/v1/ping (editors and above).
 *
 * @package {{class}}
 */

defined( 'ABSPATH' ) || exit;

add_action(
	'rest_api_init',
	static function () {
		register_rest_route(
			'{{slug}}/v1',
			'/ping',
			array(
				'methods'             => 'GET',
				'callback'            => static function () {
					return rest_ensure_response( array( 'ok' => true, 'version' => {{const}}_VERSION ) );
				},
				'permission_callback' => static function () {
					return current_user_can( 'edit_others_posts' );
				},
			)
		);
	}
);
