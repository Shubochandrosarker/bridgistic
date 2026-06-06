<?php
/**
 * Per-key usage metering + enforcement (the monetization layer).
 *
 * One table, atomic counters keyed by (key_id, bucket, metric):
 *   bucket = YmdHi  → per-minute throttle  (rate_limit, req/min)
 *   bucket = Ymd    → per-day reporting
 *   bucket = Ym     → per-month billing    (monthly_quota)
 *
 * Increments use INSERT ... ON DUPLICATE KEY UPDATE so concurrent requests
 * count correctly without locks.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic;

use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Usage {

	/**
	 * Billing tiers. rate = req/min; quota = req/month (0 = unlimited).
	 *
	 * @return array<string,array{rate:int,quota:int,label:string}>
	 */
	public static function tiers(): array {
		return array(
			'free'      => array( 'rate' => 30,   'quota' => 5000,    'label' => 'Free' ),
			'starter'   => array( 'rate' => 120,  'quota' => 50000,   'label' => 'Starter' ),
			'pro'       => array( 'rate' => 300,  'quota' => 250000,  'label' => 'Pro' ),
			'agency'    => array( 'rate' => 600,  'quota' => 1000000, 'label' => 'Agency' ),
			'unlimited' => array( 'rate' => 1200, 'quota' => 0,       'label' => 'Unlimited' ),
			'custom'    => array( 'rate' => 120,  'quota' => 0,       'label' => 'Custom' ),
		);
	}

	private static function table(): string {
		global $wpdb;
		return $wpdb->prefix . 'bridgistic_usage';
	}

	public static function install(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$table   = self::table();
		$charset = $wpdb->get_charset_collate();

		$sql = "CREATE TABLE {$table} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			key_id VARCHAR(40) NOT NULL,
			bucket VARCHAR(16) NOT NULL,
			metric VARCHAR(40) NOT NULL DEFAULT 'req',
			count BIGINT UNSIGNED NOT NULL DEFAULT 0,
			updated_at DATETIME NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY uniq (key_id, bucket, metric),
			KEY key_bucket (key_id, bucket)
		) {$charset};";

		dbDelta( $sql );
	}

	/** Atomic increment; returns the new count. */
	public static function incr( string $key_id, string $bucket, string $metric = 'req', int $by = 1 ): int {
		global $wpdb;
		$table = self::table();
		$now   = current_time( 'mysql', true );
		// phpcs:ignore WordPress.DB.PreparedSQL
		$wpdb->query(
			$wpdb->prepare(
				"INSERT INTO {$table} (key_id, bucket, metric, count, updated_at)
				 VALUES (%s, %s, %s, %d, %s)
				 ON DUPLICATE KEY UPDATE count = count + VALUES(count), updated_at = VALUES(updated_at)",
				$key_id,
				$bucket,
				$metric,
				$by,
				$now
			)
		);
		return (int) $wpdb->get_var( $wpdb->prepare( "SELECT count FROM {$table} WHERE key_id = %s AND bucket = %s AND metric = %s", $key_id, $bucket, $metric ) ); // phpcs:ignore WordPress.DB
	}

	public static function get( string $key_id, string $bucket, string $metric = 'req' ): int {
		global $wpdb;
		$table = self::table();
		return (int) $wpdb->get_var( $wpdb->prepare( "SELECT count FROM {$table} WHERE key_id = %s AND bucket = %s AND metric = %s", $key_id, $bucket, $metric ) ); // phpcs:ignore WordPress.DB
	}

	/**
	 * Enforce rate + quota for one request and meter it. Sends rate headers.
	 *
	 * @param array<string,mixed> $ctx Auth context (key_id, rate_limit, monthly_quota).
	 * @return true|WP_Error
	 */
	public static function guard( array $ctx ) {
		$key_id = (string) ( $ctx['key_id'] ?? '' );
		$rate   = (int) ( $ctx['rate_limit'] ?? 120 );
		$quota  = (int) ( $ctx['monthly_quota'] ?? 0 );
		if ( '' === $key_id ) {
			return true;
		}

		// 1. Per-minute throttle.
		$minute = gmdate( 'YmdHi' );
		$used   = self::incr( $key_id, $minute, 'req' );
		$reset  = 60 - (int) gmdate( 's' );
		self::send_headers( $rate, max( 0, $rate - $used ), $reset, $quota );

		if ( $rate > 0 && $used > $rate ) {
			if ( ! headers_sent() ) {
				header( 'Retry-After: ' . $reset );
			}
			return new WP_Error(
				'bridgistic_rate_limited',
				sprintf( 'Rate limit exceeded (%d req/min). Retry in %ds.', $rate, $reset ),
				array( 'status' => 429, 'retry_after' => $reset )
			);
		}

		// 2. Monthly quota (billing window).
		$month     = gmdate( 'Ym' );
		$monthUsed = self::incr( $key_id, $month, 'req' );
		self::incr( $key_id, gmdate( 'Ymd' ), 'req' ); // daily, reporting only.

		if ( $quota > 0 && $monthUsed > $quota ) {
			return new WP_Error(
				'bridgistic_quota_exceeded',
				sprintf( 'Monthly quota exceeded (%d/%d). Upgrade the key tier to continue.', $monthUsed, $quota ),
				array( 'status' => 402, 'quota' => $quota, 'used' => $monthUsed )
			);
		}

		return true;
	}

	/** Record a per-action counter for the month (billing analytics). */
	public static function meter_action( string $key_id, string $action ): void {
		if ( '' === $key_id || '' === $action ) {
			return;
		}
		self::incr( $key_id, gmdate( 'Ym' ), 'act:' . substr( $action, 0, 32 ) );
	}

	/**
	 * Meter an unattended (cron) run for billing. No headers, no per-minute
	 * throttle, but the monthly quota is still enforced.
	 *
	 * @param array<string,mixed> $ctx Auth context.
	 * @return true|WP_Error
	 */
	public static function meter_scheduled( array $ctx ) {
		$key_id = (string) ( $ctx['key_id'] ?? '' );
		$quota  = (int) ( $ctx['monthly_quota'] ?? 0 );
		if ( '' === $key_id ) {
			return true;
		}
		$monthUsed = self::incr( $key_id, gmdate( 'Ym' ), 'req' );
		self::incr( $key_id, gmdate( 'Ymd' ), 'req' );
		if ( $quota > 0 && $monthUsed > $quota ) {
			return new WP_Error(
				'bridgistic_quota_exceeded',
				sprintf( 'Monthly quota exceeded (%d/%d).', $monthUsed, $quota ),
				array( 'status' => 402 )
			);
		}
		return true;
	}

	/**
	 * Usage summary for one key.
	 *
	 * @return array<string,mixed>
	 */
	public static function summary( string $key_id ): array {
		global $wpdb;
		$table = self::table();
		$month = gmdate( 'Ym' );

		$actions = $wpdb->get_results( // phpcs:ignore WordPress.DB
			$wpdb->prepare(
				"SELECT metric, count FROM {$table} WHERE key_id = %s AND bucket = %s AND metric LIKE %s ORDER BY count DESC LIMIT 10",
				$key_id,
				$month,
				'act:%'
			),
			ARRAY_A
		);
		$top = array();
		foreach ( (array) $actions as $a ) {
			$top[ substr( (string) $a['metric'], 4 ) ] = (int) $a['count'];
		}

		return array(
			'this_minute' => self::get( $key_id, gmdate( 'YmdHi' ), 'req' ),
			'today'       => self::get( $key_id, gmdate( 'Ymd' ), 'req' ),
			'this_month'  => self::get( $key_id, $month, 'req' ),
			'top_actions' => $top,
		);
	}

	private static function send_headers( int $limit, int $remaining, int $reset, int $quota ): void {
		if ( headers_sent() ) {
			return;
		}
		header( 'X-Bridgistic-RateLimit-Limit: ' . $limit );
		header( 'X-Bridgistic-RateLimit-Remaining: ' . $remaining );
		header( 'X-Bridgistic-RateLimit-Reset: ' . $reset );
		if ( $quota > 0 ) {
			header( 'X-Bridgistic-Quota-Limit: ' . $quota );
		}
	}
}
