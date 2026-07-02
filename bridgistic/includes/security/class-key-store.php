<?php
/**
 * Scoped key storage.
 *
 * Each key = { key_id (public), secret (shown once, stored hashed), scopes,
 * ip_allowlist, rate_limit, enabled }.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic\Security;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class KeyStore {

	private static function table(): string {
		global $wpdb;
		return $wpdb->prefix . 'bridgistic_keys';
	}

	/**
	 * Create the keys table.
	 */
	public static function install(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table   = self::table();
		$charset = $wpdb->get_charset_collate();

		$sql = "CREATE TABLE {$table} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			key_id VARCHAR(40) NOT NULL,
			secret_enc VARCHAR(512) NOT NULL,
			label VARCHAR(191) NOT NULL DEFAULT '',
			scopes TEXT NOT NULL,
			ip_allowlist TEXT NULL,
			rate_limit SMALLINT UNSIGNED NOT NULL DEFAULT 120,
			require_approval TINYINT(1) NOT NULL DEFAULT 0,
			tier VARCHAR(20) NOT NULL DEFAULT 'custom',
			monthly_quota BIGINT UNSIGNED NOT NULL DEFAULT 0,
			enabled TINYINT(1) NOT NULL DEFAULT 1,
			created_at DATETIME NOT NULL,
			last_used_at DATETIME NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY key_id (key_id)
		) {$charset};";

		dbDelta( $sql );
	}

	/**
	 * Mint a new key. Returns the plaintext secret ONCE — never stored in clear.
	 *
	 * @param string            $label        Human label.
	 * @param array<int,string> $scopes       Validated scopes.
	 * @param array<int,string> $ip_allowlist Optional CIDR / IP allowlist.
	 * @param int               $rate_limit   Requests per minute.
	 * @return array{key_id:string,secret:string}
	 */
	public static function create( string $label, array $scopes, array $ip_allowlist = array(), int $rate_limit = 120, bool $require_approval = false, string $tier = 'custom', int $monthly_quota = 0 ): array {
		global $wpdb;

		$key_id = 'wpk_' . bin2hex( random_bytes( 12 ) );
		$secret = 'wps_' . bin2hex( random_bytes( 24 ) );

		$wpdb->insert( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			self::table(),
			array(
				'key_id'       => $key_id,
				// HMAC needs the live secret, so it is encrypted at rest (never hashed).
				'secret_enc'   => Crypto::encrypt( $secret ),
				'label'        => $label,
				'scopes'       => wp_json_encode( Scopes::sanitize( $scopes ) ),
				'ip_allowlist' => $ip_allowlist ? wp_json_encode( $ip_allowlist ) : null,
				'rate_limit'   => max( 1, min( 6000, $rate_limit ) ),
				'require_approval' => $require_approval ? 1 : 0,
				'tier'         => $tier,
				'monthly_quota'=> max( 0, $monthly_quota ),
				'enabled'      => 1,
				'created_at'   => current_time( 'mysql', true ),
			),
			array( '%s', '%s', '%s', '%s', '%s', '%d', '%d', '%s', '%d', '%d', '%s' )
		);

		return array(
			'key_id' => $key_id,
			'secret' => $secret,
		);
	}

	/**
	 * Fetch a key record by its public key_id.
	 *
	 * @return array<string,mixed>|null
	 */
	public static function get( string $key_id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( // phpcs:ignore WordPress.DB
			$wpdb->prepare( 'SELECT * FROM ' . self::table() . ' WHERE key_id = %s', $key_id ),
			ARRAY_A
		);
		if ( ! $row ) {
			return null;
		}
		$row['scopes']       = json_decode( (string) $row['scopes'], true ) ?: array();
		$row['ip_allowlist'] = $row['ip_allowlist'] ? ( json_decode( (string) $row['ip_allowlist'], true ) ?: array() ) : array();
		return $row;
	}

	/**
	 * Mark a key as used (for the admin "last used" column).
	 */
	public static function touch( string $key_id ): void {
		global $wpdb;
		$wpdb->update( // phpcs:ignore WordPress.DB
			self::table(),
			array( 'last_used_at' => current_time( 'mysql', true ) ),
			array( 'key_id' => $key_id ),
			array( '%s' ),
			array( '%s' )
		);
	}

	/**
	 * @return array<int,array<string,mixed>>
	 */
	public static function list_all(): array {
		global $wpdb;
		$rows = $wpdb->get_results( 'SELECT * FROM ' . self::table() . ' ORDER BY id DESC', ARRAY_A ); // phpcs:ignore WordPress.DB
		return is_array( $rows ) ? $rows : array();
	}

	public static function revoke( string $key_id ): void {
		global $wpdb;
		$wpdb->delete( self::table(), array( 'key_id' => $key_id ), array( '%s' ) ); // phpcs:ignore WordPress.DB
	}

	/**
	 * Decrypt and return the live signing secret for a key record.
	 *
	 * @param array<string,mixed> $row Row from get().
	 */
	public static function get_secret( array $row ): ?string {
		if ( empty( $row['secret_enc'] ) ) {
			return null;
		}
		return Crypto::decrypt( (string) $row['secret_enc'] );
	}
}
