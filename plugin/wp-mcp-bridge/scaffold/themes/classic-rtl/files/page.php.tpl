<?php
/**
 * Pages and single posts.
 *
 * @package {{slug}}
 */

get_header();
?>
<main class="site-main">
	<?php while ( have_posts() ) : the_post(); ?>
		<article <?php post_class(); ?>>
			<h1 class="entry-title"><?php the_title(); ?></h1>
			<div class="entry-content"><?php the_content(); ?></div>
		</article>
		<?php if ( comments_open() || get_comments_number() ) { comments_template(); } ?>
	<?php endwhile; ?>
</main>
<?php
get_footer();
