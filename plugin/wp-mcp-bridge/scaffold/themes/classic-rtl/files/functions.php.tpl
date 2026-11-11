<?php
/**
 * {{name}}: theme set-up.
 *
 * @package {{slug}}
 */

add_action(
	'after_setup_theme',
	static function () {
		load_theme_textdomain( '{{slug}}', get_template_directory() . '/languages' );
		add_theme_support( 'title-tag' );
		add_theme_support( 'post-thumbnails' );
		add_theme_support( 'html5', array( 'search-form', 'comment-form', 'comment-list', 'gallery', 'caption', 'style', 'script' ) );
		add_theme_support( 'custom-logo' );
		add_theme_support( 'responsive-embeds' );
		register_nav_menus( array( 'primary' => __( 'Primary menu', '{{slug}}' ) ) );
	}
);

add_action(
	'wp_enqueue_scripts',
	static function () {
		wp_enqueue_style( '{{slug}}-style', get_stylesheet_uri(), array(), wp_get_theme()->get( 'Version' ) );
	}
);
