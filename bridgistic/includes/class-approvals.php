<?php
/**
 * Human-in-the-loop approval queue.
 *
 * When a key is flagged require_approval, destructive ops are enqueued instead
 * of executed. A WP admin approves/rejects in the dashboard. The agent then
 * retries the SAME call with the returned approval_id; the Guard verifies the
 * action+payload hash matches the approved record before executing once.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Approvals {

	public const PENDING  = 'pending';
	public const APPROVED = 'approved';
	public const REJECTED = 'rejected';
	public const EXECUTED = 'executed';

	private static function table(): string {
		global $wpdb;
		return $wpdb->prefix . 'bridgistic_approvals';
	}

	public static function install(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$table   = self::table();
		$charset = $wpdb->get_charset_collate();

		$sql = "CREATE TABLE {$table} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			approval_id VARCHAR(40) NOT NULL,
			key_id VARCHAR(40) NOT NULL DEFAULT '',
			action VARCHAR(64) NOT NULL DEFAULT '',
			request_hash CHAR(64) NOT NULL DEFAULT '',
			summary TEXT NULL,
			status VARCHAR(16) NOT NULL DEFAULT 'pending',
			created_at DATETIME NOT NULL,
			decided_at DATETIME NULL,
			decided_by BIGINT UNSIGNED NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY approval_id (approval_id),
			KEY status (status)
		) {$charset};";

		dbDelta( $sql );
	}

	/**
	 * Stable hash binding an approval to a specific action + payload.
	 *
	 * @param array<string,mixed> $payload Operation payload.
	 */
	public static function hash( string $action, array $payload ): string {
		ksort( $payload );
		return hash( 'sha256', $action . '|' . (string) wp_json_encode( $payload ) );
	}

	/**
	 * Enqueue a pending approval.
	 *
	 * @param array<string,mixed> $payload Operation payload.
	 */
	public static function enqueue( string $key_id, string $action, array $payload, string $summary = '' ): string {
		global $wpdb;
		$id = 'apr_' . bin2hex( random_bytes( 10 ) );
		$wpdb->insert( // phpcs:ignore WordPress.DB
			self::table(),
			array(
				'approval_id'  => $id,
				'key_id'       => $key_id,
				'action'       => $action,
				'request_hash' => self::hash( $action, $payload ),
				'summary'      => mb_substr( $summary, 0, 2000 ),
				'status'       => self::PENDING,
				'created_at'   => current_time( 'mysql', true ),
			),
			array( '%s', '%s', '%s', '%s', '%s', '%s', '%s' )
		);
		return $id;
	}

	/**
	 * @return array<string,mixed>|null
	 */
	public static function get( string $approval_id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM ' . self::table() . ' WHERE approval_id = %s', $approval_id ), ARRAY_A ); // phpcs:ignore WordPress.DB
		return $row ?: null;
	}

	/**
	 * Verify a presented approval is APPROVED and matches this exact action+payload.
	 *
	 * @param array<string,mixed> $payload Payload being executed now.
	 * @return true|\WP_Error
	 */
	public static function verify_ready( string $approval_id, string $action, array $payload ) {
		$row = self::get( $approval_id );
		if ( ! $row ) {
			return new \WP_Error( 'bridgistic_approval_missing', 'Approval not found.', array( 'status' => 404 ) );
		}
		if ( self::EXECUTED === $row['status'] ) {
			return new \WP_Error( 'bridgistic_approval_used', 'Approval already consumed.', array( 'status' => 409 ) );
		}
		if ( self::REJECTED === $row['status'] ) {
			return new \WP_Error( 'bridgistic_approval_rejected', 'This operation was rejected by an administrator.', array( 'status' => 403 ) );
		}
		if ( self::APPROVED !== $row['status'] ) {
			return new \WP_Error( 'bridgistic_approval_pending', 'Still awaiting administrator approval.', array( 'status' => 425 ) );
		}
		if ( ! hash_equals( (string) $row['request_hash'], self::hash( $action, $payload ) ) ) {
			return new \WP_Error( 'bridgistic_approval_mismatch', 'Approval does not match this request (args changed).', array( 'status' => 409 ) );
		}
		return true;
	}

	public static function mark_executed( string $approval_id ): void {
		global $wpdb;
		$wpdb->update( self::table(), array( 'status' => self::EXECUTED ), array( 'approval_id' => $approval_id ), array( '%s' ), array( '%s' ) ); // phpcs:ignore WordPress.DB
	}

	public static function decide( string $approval_id, bool $approve, int $user_id ): void {
		global $wpdb;
		$wpdb->update( // phpcs:ignore WordPress.DB
			self::table(),
			array(
				'status'     => $approve ? self::APPROVED : self::REJECTED,
				'decided_at' => current_time( 'mysql', true ),
				'decided_by' => $user_id,
			),
			array( 'approval_id' => $approval_id ),
			array( '%s', '%s', '%d' ),
			array( '%s' )
		);
	}

	/** @return array<int,array<string,mixed>> */
	public static function list_by_status( string $status = '', int $limit = 100 ): array {
		global $wpdb;
		$limit = max( 1, min( 500, $limit ) );
		if ( $status ) {
			$rows = $wpdb->get_results( $wpdb->prepare( 'SELECT * FROM ' . self::table() . ' WHERE status = %s ORDER BY id DESC LIMIT %d', $status, $limit ), ARRAY_A ); // phpcs:ignore WordPress.DB
		} else {
			$rows = $wpdb->get_results( $wpdb->prepare( 'SELECT * FROM ' . self::table() . ' ORDER BY id DESC LIMIT %d', $limit ), ARRAY_A ); // phpcs:ignore WordPress.DB
		}
		return is_array( $rows ) ? $rows : array();
	}
}
