<?php
/**
 * Bridgistic uninstall — remove all plugin data when deleted from WP Admin.
 *
 * Only runs on real deletion (not deactivation). Drops custom tables, deletes
 * options, clears scheduled events, and removes the sandbox directory.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

global $wpdb;

// 1. Drop custom tables.
$tables = array(
	'bridgistic_keys',
	'bridgistic_audit',
	'bridgistic_snapshots',
	'bridgistic_approvals',
	'bridgistic_usage',
	'bridgistic_memory',
	'bridgistic_playbooks',
	'bridgistic_schedules',
);
foreach ( $tables as $t ) {
	$table = $wpdb->prefix . $t;
	$wpdb->query( "DROP TABLE IF EXISTS `{$table}`" ); // phpcs:ignore WordPress.DB
}

// 2. Delete options.
delete_option( 'bridgistic_options_allowlist' );
delete_option( 'bridgistic_bridge_pepper' );
delete_option( 'bridgistic_pepper' );

// 3. Clear scheduled events.
wp_clear_scheduled_hook( 'bridgistic_cron_cleanup' );
if ( function_exists( 'wp_unschedule_hook' ) ) {
	wp_unschedule_hook( 'bridgistic_run_scheduled_playbook' );
}

// 4. Remove the sandbox directory.
$uploads = wp_upload_dir();
$sandbox = trailingslashit( $uploads['basedir'] ) . 'bridgistic-sandbox';
if ( is_dir( $sandbox ) ) {
	$it = new RecursiveIteratorIterator(
		new RecursiveDirectoryIterator( $sandbox, FilesystemIterator::SKIP_DOTS ),
		RecursiveIteratorIterator::CHILD_FIRST
	);
	foreach ( $it as $file ) {
		$file->isDir() ? rmdir( $file->getPathname() ) : unlink( $file->getPathname() ); // phpcs:ignore
	}
	rmdir( $sandbox ); // phpcs:ignore
}
