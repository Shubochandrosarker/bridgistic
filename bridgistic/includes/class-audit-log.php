<?php
/**
 * Tamper-evident audit log of every bridge operation.
 *
 * Novamira keeps no trail. This is a selling point for agencies and EU clients:
 * who (key), what (action), when, params hash, result status, IP.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class AuditLog {

	/** Retention in days. */
	private const RETENTION_DAYS = 90;

	private static function table(): string {
		global $wpdb;
		return $wpdb->prefix . 'bridgistic_audit';
	}

	public static function install(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table   = self::table();
		$charset = $wpdb->get_charset_collate();

		$sql = "CREATE TABLE {$table} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			created_at DATETIME NOT NULL,
			key_id VARCHAR(40) NOT NULL DEFAULT '',
			action VARCHAR(64) NOT NULL DEFAULT '',
			status VARCHAR(16) NOT NULL DEFAULT '',
			ip VARCHAR(45) NOT NULL DEFAULT '',
			params_hash CHAR(64) NOT NULL DEFAULT '',
			summary TEXT NULL,
			PRIMARY KEY  (id),
			KEY created_at (created_at),
			KEY key_id (key_id),
			KEY action (action)
		) {$charset};";

		dbDelta( $sql );
	}

	/**
	 * Record one operation.
	 *
	 * @param array<string,mixed> $params Operation params (hashed, not stored raw).
	 */
	public static function record( string $key_id, string $action, string $status, array $params = array(), string $summary = '' ): void {
		global $wpdb;

		$wpdb->insert( // phpcs:ignore WordPress.DB
			self::table(),
			array(
				'created_at'  => current_time( 'mysql', true ),
				'key_id'      => $key_id,
				'action'      => $action,
				'status'      => $status,
				'ip'          => isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '',
				'params_hash' => hash( 'sha256', (string) wp_json_encode( $params ) ),
				'summary'     => mb_substr( $summary, 0, 2000 ),
			),
			array( '%s', '%s', '%s', '%s', '%s', '%s', '%s' )
		);
	}

	/**
	 * @return array<int,array<string,mixed>>
	 */
	public static function recent( int $limit = 100 ): array {
		global $wpdb;
		$limit = max( 1, min( 1000, $limit ) );
		$rows  = $wpdb->get_results( // phpcs:ignore WordPress.DB
			$wpdb->prepare( 'SELECT * FROM ' . self::table() . ' ORDER BY id DESC LIMIT %d', $limit ),
			ARRAY_A
		);
		return is_array( $rows ) ? $rows : array();
	}

	public static function prune(): void {
		global $wpdb;
		$cutoff = gmdate( 'Y-m-d H:i:s', time() - ( self::RETENTION_DAYS * DAY_IN_SECONDS ) );
		$wpdb->query( // phpcs:ignore WordPress.DB
			$wpdb->prepare( 'DELETE FROM ' . self::table() . ' WHERE created_at < %s', $cutoff )
		);
	}
}
