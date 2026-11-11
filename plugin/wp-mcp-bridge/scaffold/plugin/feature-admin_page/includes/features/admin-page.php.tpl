<?php
/**
 * A settings page under Settings.
 *
 * @package {{class}}
 */

defined( 'ABSPATH' ) || exit;

add_action(
	'admin_init',
	static function () {
		register_setting(
			'{{prefix}}_group',
			'{{prefix}}_options',
			array(
				'type'              => 'array',
				'sanitize_callback' => static function ( $input ) {
					return array( 'text' => sanitize_text_field( (string) ( $input['text'] ?? '' ) ) );
				},
				'default'           => array( 'text' => '' ),
			)
		);
	}
);

add_action(
	'admin_menu',
	static function () {
		add_options_page( '{{name}}', '{{name}}', 'manage_options', '{{slug}}', '{{prefix}}_render_settings' );
	}
);

function {{prefix}}_render_settings(): void {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$options = (array) get_option( '{{prefix}}_options', array() );
	?>
	<div class="wrap">
		<h1><?php echo esc_html( get_admin_page_title() ); ?></h1>
		<form method="post" action="options.php">
			<?php settings_fields( '{{prefix}}_group' ); ?>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="{{prefix}}_text"><?php esc_html_e( 'Text', '{{slug}}' ); ?></label></th>
					<td><input type="text" id="{{prefix}}_text" class="regular-text" name="{{prefix}}_options[text]" value="<?php echo esc_attr( (string) ( $options['text'] ?? '' ) ); ?>"></td>
				</tr>
			</table>
			<?php submit_button(); ?>
		</form>
	</div>
	<?php
}
