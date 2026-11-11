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
		add_theme_support( 'woocommerce' );
		add_theme_support( 'wc-product-gallery-zoom' );
		add_theme_support( 'wc-product-gallery-lightbox' );
		add_theme_support( 'wc-product-gallery-slider' );
		register_nav_menus( array( 'primary' => __( 'Primary menu', '{{slug}}' ) ) );
	}
);

add_action(
	'wp_enqueue_scripts',
	static function () {
		wp_enqueue_style( '{{slug}}-style', get_stylesheet_uri(), array(), wp_get_theme()->get( 'Version' ) );
	}
);

/** Cart link with a live count in the header, refreshed by WooCommerce cart fragments. */
add_filter(
	'woocommerce_add_to_cart_fragments',
	static function ( $fragments ) {
		$fragments['a.cart-link'] = '<a class="cart-link" href="' . esc_url( wc_get_cart_url() ) . '">' . esc_html__( 'Cart', '{{slug}}' ) . ' (' . WC()->cart->get_cart_contents_count() . ')</a>';

		return $fragments;
	}
);
