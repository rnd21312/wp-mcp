<!doctype html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php bloginfo( 'charset' ); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1">
<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>
<header class="site-header">
	<p class="site-title"><a href="<?php echo esc_url( home_url( '/' ) ); ?>"><?php bloginfo( 'name' ); ?></a></p>
	<nav aria-label="<?php esc_attr_e( 'Primary menu', '{{slug}}' ); ?>">
		<?php wp_nav_menu( array( 'theme_location' => 'primary', 'container' => false, 'menu_class' => 'primary-menu', 'fallback_cb' => false ) ); ?>
	</nav>
</header>
