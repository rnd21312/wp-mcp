<?php
/**
 * {{name}}: block theme set-up.
 *
 * @package {{slug}}
 */

add_action(
	'after_setup_theme',
	static function () {
		load_theme_textdomain( '{{slug}}', get_template_directory() . '/languages' );
		add_theme_support( 'post-thumbnails' );
		add_theme_support( 'responsive-embeds' );
		add_theme_support( 'editor-styles' );
	}
);
