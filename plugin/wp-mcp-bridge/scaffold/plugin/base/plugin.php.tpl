<?php
/**
 * Plugin Name: {{name}}
 * Description: {{description}}
 * Version: 1.0.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Author: {{author}}
 * License: GPL-2.0-or-later
 * Text Domain: {{slug}}
 * Domain Path: /languages
 *
 * @package {{class}}
 */

defined( 'ABSPATH' ) || exit;

define( '{{const}}_VERSION', '1.0.0' );
define( '{{const}}_FILE', __FILE__ );
define( '{{const}}_DIR', plugin_dir_path( __FILE__ ) );
define( '{{const}}_URL', plugin_dir_url( __FILE__ ) );

require_once {{const}}_DIR . 'includes/class-{{slug}}.php';

add_action( 'plugins_loaded', array( '{{class}}', 'boot' ) );
register_activation_hook( __FILE__, array( '{{class}}', 'activate' ) );
register_deactivation_hook( __FILE__, array( '{{class}}', 'deactivate' ) );
