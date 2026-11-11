<?php
/**
 * WooCommerce wrapper: shop, product, cart and checkout render inside the theme layout.
 *
 * @package {{slug}}
 */

get_header();
?>
<main class="site-main">
	<?php woocommerce_content(); ?>
</main>
<?php
get_footer();
