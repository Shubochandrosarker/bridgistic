<?php
/**
 * Core plugin loader.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic;

use Bridgistic\Security\KeyStore;
use Bridgistic\Rest\Router;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Singleton bootstrap that wires everything together.
 */
final class Plugin {

	private static ?Plugin $instance = null;

	private bool $booted = false;

	public static function instance(): Plugin {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {}

	/**
	 * Hook everything in. Safe to call once.
	 */
	public function boot(): void {
		if ( $this->booted ) {
			return;
		}
		$this->booted = true;

		// REST API routes — the only entry point for the MCP server.
		add_action(
			'rest_api_init',
			static function (): void {
				( new Router() )->register_routes();
			}
		);

		// Admin UI for connecting / managing scoped keys.
		if ( is_admin() ) {
			( new Admin() )->hooks();
		}

		// Daily cleanup of expired nonces + old audit rows.
		add_action( 'bridgistic_cron_cleanup', array( $this, 'cleanup' ) );
		if ( ! wp_next_scheduled( 'bridgistic_cron_cleanup' ) ) {
			wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', 'bridgistic_cron_cleanup' );
		}

		// Scheduled playbooks: register custom cron intervals + the run hook.
		Scheduler::boot();
	}

	/**
	 * Activation: create custom tables, the sandbox dir, and a site secret.
	 */
	public static function activate(): void {
		require_once BRIDGISTIC_DIR . 'includes/security/class-key-store.php';
		require_once BRIDGISTIC_DIR . 'includes/class-audit-log.php';
		require_once BRIDGISTIC_DIR . 'includes/class-snapshot.php';
		require_once BRIDGISTIC_DIR . 'includes/class-approvals.php';
		require_once BRIDGISTIC_DIR . 'includes/class-usage.php';
		require_once BRIDGISTIC_DIR . 'includes/class-memory.php';
		require_once BRIDGISTIC_DIR . 'includes/class-playbooks.php';
		require_once BRIDGISTIC_DIR . 'includes/class-scheduler.php';

		KeyStore::install();
		AuditLog::install();
		Snapshot::install();
		Approvals::install();
		Usage::install();
		Memory::install();
		Playbooks::install();
		Scheduler::install();
		self::ensure_sandbox();

		// One-time, per-site signing pepper. Never leaves the server.
		if ( ! get_option( 'bridgistic_bridge_pepper' ) ) {
			add_option( 'bridgistic_bridge_pepper', wp_generate_password( 64, true, true ), '', 'no' );
		}

		flush_rewrite_rules();
	}

	public static function deactivate(): void {
		wp_clear_scheduled_hook( 'bridgistic_cron_cleanup' );
		wp_unschedule_hook( Scheduler::HOOK );
		flush_rewrite_rules();
	}

	/**
	 * Create the sandbox directory under uploads with a hardening .htaccess.
	 */
	public static function ensure_sandbox(): string {
		$uploads = wp_upload_dir();
		$dir     = trailingslashit( $uploads['basedir'] ) . BRIDGISTIC_SANDBOX;

		if ( ! is_dir( $dir ) ) {
			wp_mkdir_p( $dir );
		}

		// Block direct web execution of anything inside the sandbox.
		$htaccess = $dir . '/.htaccess';
		if ( ! file_exists( $htaccess ) ) {
			file_put_contents( $htaccess, "Require all denied\n<FilesMatch \".*\">\nRequire all denied\n</FilesMatch>\n" ); // phpcs:ignore
		}
		$index = $dir . '/index.php';
		if ( ! file_exists( $index ) ) {
			file_put_contents( $index, "<?php // Silence is golden.\n" ); // phpcs:ignore
		}

		return $dir;
	}

	/**
	 * Scheduled cleanup.
	 */
	public function cleanup(): void {
		AuditLog::prune();
	}
}
