<?php
/**
 * A custom post type: rename it and add fields as needed.
 *
 * @package {{class}}
 */

defined( 'ABSPATH' ) || exit;

add_action(
	'init',
	static function () {
		register_post_type(
			'{{prefix}}_item',
			array(
				'label'        => '{{name}}',
				'public'       => true,
				'show_in_rest' => true,
				'menu_icon'    => 'dashicons-admin-post',
				'supports'     => array( 'title', 'editor', 'thumbnail', 'excerpt' ),
				'has_archive'  => true,
				'rewrite'      => array( 'slug' => '{{slug}}' ),
			)
		);
	}
);
