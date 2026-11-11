<?php
/**
 * Shortcode [{{prefix}}]: change the output below.
 *
 * @package {{class}}
 */

defined( 'ABSPATH' ) || exit;

add_shortcode(
	'{{prefix}}',
	static function ( $atts ) {
		$atts = shortcode_atts( array( 'text' => '' ), (array) $atts, '{{prefix}}' );

		return '<div class="{{prefix}}">' . esc_html( (string) $atts['text'] ) . '</div>';
	}
);
