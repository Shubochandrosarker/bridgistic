<?php
/**
 * Per-site memory: durable notes the agent writes once and recalls later
 * (site quirks, conventions, IDs, client preferences). Namespaced by category.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Memory {

	private static function table(): string {
		global $wpdb;
		return $wpdb->prefix . 'bridgistic_memory';
	}

	public static function install(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$table   = self::table();
		$charset = $wpdb->get_charset_collate();

		$sql = "CREATE TABLE {$table} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			category VARCHAR(64) NOT NULL DEFAULT 'general',
			mkey VARCHAR(191) NOT NULL,
			mvalue LONGTEXT NULL,
			updated_by VARCHAR(40) NOT NULL DEFAULT '',
			updated_at DATETIME NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY uniq (category, mkey),
			KEY category (category)
		) {$charset};";

		dbDelta( $sql );
	}

	public static function set( string $category, string $key, $value, string $by = '' ): array {
		global $wpdb;
		$category = $category ?: 'general';
		$json     = wp_json_encode( $value );
		$now      = current_time( 'mysql', true );

		$wpdb->query( // phpcs:ignore WordPress.DB
			$wpdb->prepare(
				'INSERT INTO ' . self::table() . ' (category, mkey, mvalue, updated_by, updated_at)
				 VALUES (%s, %s, %s, %s, %s)
				 ON DUPLICATE KEY UPDATE mvalue = VALUES(mvalue), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)',
				$category,
				$key,
				$json,
				$by,
				$now
			)
		);

		return array( 'category' => $category, 'key' => $key, 'saved' => true );
	}

	/**
	 * @return array<string,mixed>|null
	 */
	public static function get( string $category, string $key ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( // phpcs:ignore WordPress.DB
			$wpdb->prepare( 'SELECT * FROM ' . self::table() . ' WHERE category = %s AND mkey = %s', $category ?: 'general', $key ),
			ARRAY_A
		);
		if ( ! $row ) {
			return null;
		}
		return array(
			'category'   => $row['category'],
			'key'        => $row['mkey'],
			'value'      => json_decode( (string) $row['mvalue'], true ),
			'updated_at' => $row['updated_at'],
		);
	}

	/** @return array<int,array<string,mixed>> */
	public static function list( string $category = '' ): array {
		global $wpdb;
		if ( $category ) {
			$rows = $wpdb->get_results( $wpdb->prepare( 'SELECT category, mkey, mvalue, updated_at FROM ' . self::table() . ' WHERE category = %s ORDER BY mkey ASC', $category ), ARRAY_A ); // phpcs:ignore WordPress.DB
		} else {
			$rows = $wpdb->get_results( 'SELECT category, mkey, mvalue, updated_at FROM ' . self::table() . ' ORDER BY category, mkey ASC', ARRAY_A ); // phpcs:ignore WordPress.DB
		}
		$out = array();
		foreach ( (array) $rows as $r ) {
			$out[] = array(
				'category'   => $r['category'],
				'key'        => $r['mkey'],
				'value'      => json_decode( (string) $r['mvalue'], true ),
				'updated_at' => $r['updated_at'],
			);
		}
		return $out;
	}

	public static function delete( string $category, string $key ): void {
		global $wpdb;
		$wpdb->delete( self::table(), array( 'category' => $category ?: 'general', 'mkey' => $key ), array( '%s', '%s' ) ); // phpcs:ignore WordPress.DB
	}
}
