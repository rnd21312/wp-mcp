<?php
/**
 * Main class: loads the translations and every file in includes/features.
 *
 * @package {{class}}
 */

defined( 'ABSPATH' ) || exit;

final class {{class}} {

	public static function boot(): void {
		load_plugin_textdomain( '{{slug}}', false, dirname( plugin_basename( {{const}}_FILE ) ) . '/languages' );
		foreach ( (array) glob( {{const}}_DIR . 'includes/features/*.php' ) as $feature ) {
			require_once $feature;
		}
	}

	public static function activate(): void {
		add_option( '{{prefix}}_version', {{const}}_VERSION );
		flush_rewrite_rules();
	}

	public static function deactivate(): void {
		flush_rewrite_rules();
	}
}
