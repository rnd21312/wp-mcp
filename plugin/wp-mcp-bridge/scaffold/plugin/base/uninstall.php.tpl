<?php
/**
 * Runs when the plugin is deleted: removes what it stored.
 *
 * @package {{class}}
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( '{{prefix}}_version' );
delete_option( '{{prefix}}_options' );
