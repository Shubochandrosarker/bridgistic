<?php
/**
 * Snapshot + rollback engine.
 *
 * Captures a reversible copy of a target BEFORE a destructive op, so any write
 * can be undone with a single restore call. Supported targets:
 *   - post    { id }            row + all postmeta
 *   - option  { name }          single option value
 *   - tables  { tables: [...] } full table contents (row-capped)
 *   - file    { path }          file contents (size-capped) or "absent" marker
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Snapshot {

	/** Max rows captured per table for an auto table snapshot. */
	public const TABLE_ROW_CAP = 50000;

	/** Max bytes captured for a file snapshot (2 MB). */
	public const FILE_SIZE_CAP = 2097152;

	private static function table(): string {
		global $wpdb;
		return $wpdb->prefix . 'bridgistic_snapshots';
	}

	public static function install(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$table   = self::table();
		$charset = $wpdb->get_charset_collate();

		$sql = "CREATE TABLE {$table} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			snapshot_id VARCHAR(40) NOT NULL,
			label VARCHAR(191) NOT NULL DEFAULT '',
			type VARCHAR(20) NOT NULL DEFAULT '',
			target TEXT NULL,
			payload LONGTEXT NULL,
			byte_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
			key_id VARCHAR(40) NOT NULL DEFAULT '',
			created_at DATETIME NOT NULL,
			restored_at DATETIME NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY snapshot_id (snapshot_id),
			KEY type (type),
			KEY created_at (created_at)
		) {$charset};";

		dbDelta( $sql );
	}

	/**
	 * Create a snapshot. Returns metadata incl. the public snapshot_id, or WP_Error.
	 *
	 * @param string              $type   One of post|option|tables|file.
	 * @param array<string,mixed> $target Target descriptor.
	 * @return array{snapshot_id:string,type:string,byte_size:int}|\WP_Error
	 */
	public static function create( string $type, array $target, string $label = '', string $key_id = '' ) {
		$payload = self::capture( $type, $target );
		if ( is_wp_error( $payload ) ) {
			return $payload;
		}

		$encoded = self::encode( $payload );
		$id      = 'snap_' . bin2hex( random_bytes( 10 ) );

		global $wpdb;
		$wpdb->insert( // phpcs:ignore WordPress.DB
			self::table(),
			array(
				'snapshot_id' => $id,
				'label'       => mb_substr( $label, 0, 191 ),
				'type'        => $type,
				'target'      => wp_json_encode( $target ),
				'payload'     => $encoded,
				'byte_size'   => strlen( $encoded ),
				'key_id'      => $key_id,
				'created_at'  => current_time( 'mysql', true ),
			),
			array( '%s', '%s', '%s', '%s', '%s', '%d', '%s', '%s' )
		);

		return array(
			'snapshot_id' => $id,
			'type'        => $type,
			'byte_size'   => strlen( $encoded ),
		);
	}

	/**
	 * Capture target state into a serialisable array.
	 *
	 * @return array<string,mixed>|\WP_Error
	 */
	private static function capture( string $type, array $target ) {
		global $wpdb;

		switch ( $type ) {
			case 'post':
				$id   = (int) ( $target['id'] ?? 0 );
				$row  = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->posts} WHERE ID = %d", $id ), ARRAY_A ); // phpcs:ignore WordPress.DB
				$meta = $wpdb->get_results( $wpdb->prepare( "SELECT meta_key, meta_value FROM {$wpdb->postmeta} WHERE post_id = %d", $id ), ARRAY_A ); // phpcs:ignore WordPress.DB
				return array(
					'exists' => (bool) $row,
					'post'   => $row,
					'meta'   => is_array( $meta ) ? $meta : array(),
				);

			case 'user':
				$uid    = (int) ( $target['id'] ?? 0 );
				$urow   = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->users} WHERE ID = %d", $uid ), ARRAY_A ); // phpcs:ignore WordPress.DB
				$umeta  = $wpdb->get_results( $wpdb->prepare( "SELECT meta_key, meta_value FROM {$wpdb->usermeta} WHERE user_id = %d", $uid ), ARRAY_A ); // phpcs:ignore WordPress.DB
				return array(
					'exists' => (bool) $urow,
					'user'   => $urow,
					'meta'   => is_array( $umeta ) ? $umeta : array(),
				);

			case 'option':
				$name   = (string) ( $target['name'] ?? '' );
				$exists = $wpdb->get_var( $wpdb->prepare( "SELECT option_id FROM {$wpdb->options} WHERE option_name = %s", $name ) ) !== null; // phpcs:ignore WordPress.DB
				return array(
					'exists'   => $exists,
					'name'     => $name,
					'value'    => $exists ? get_option( $name ) : null,
					'autoload' => $exists ? $wpdb->get_var( $wpdb->prepare( "SELECT autoload FROM {$wpdb->options} WHERE option_name = %s", $name ) ) : 'yes', // phpcs:ignore WordPress.DB
				);

			case 'tables':
				$tables = (array) ( $target['tables'] ?? array() );
				$dump   = array();
				foreach ( $tables as $t ) {
					$t = self::safe_table( (string) $t );
					if ( ! $t ) {
						return new \WP_Error( 'bridgistic_snap_table', "Unknown or unsafe table: {$t}", array( 'status' => 400 ) );
					}
					$count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM `{$t}`" ); // phpcs:ignore WordPress.DB
					if ( $count > self::TABLE_ROW_CAP ) {
						return new \WP_Error(
							'bridgistic_snap_toolarge',
							"Table {$t} has {$count} rows (cap " . self::TABLE_ROW_CAP . '). Use a targeted snapshot or raise the cap.',
							array( 'status' => 413 )
						);
					}
					$dump[ $t ] = $wpdb->get_results( "SELECT * FROM `{$t}`", ARRAY_A ); // phpcs:ignore WordPress.DB
				}
				return array( 'tables' => $dump );

			case 'file':
				$path = self::safe_path( (string) ( $target['path'] ?? '' ) );
				if ( ! $path ) {
					return new \WP_Error( 'bridgistic_snap_path', 'Path is outside ABSPATH.', array( 'status' => 400 ) );
				}
				if ( ! file_exists( $path ) ) {
					return array(
						'exists' => false,
						'path'   => $path,
					);
				}
				if ( filesize( $path ) > self::FILE_SIZE_CAP ) {
					return new \WP_Error( 'bridgistic_snap_filesize', 'File exceeds snapshot size cap.', array( 'status' => 413 ) );
				}
				return array(
					'exists'  => true,
					'path'    => $path,
					'content' => base64_encode( (string) file_get_contents( $path ) ), // phpcs:ignore
				);

			default:
				return new \WP_Error( 'bridgistic_snap_type', "Unknown snapshot type: {$type}", array( 'status' => 400 ) );
		}
	}

	/**
	 * Restore a snapshot by its public id.
	 *
	 * @return array<string,mixed>|\WP_Error
	 */
	public static function restore( string $snapshot_id ) {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM ' . self::table() . ' WHERE snapshot_id = %s', $snapshot_id ), ARRAY_A ); // phpcs:ignore WordPress.DB
		if ( ! $row ) {
			return new \WP_Error( 'bridgistic_snap_notfound', 'Snapshot not found.', array( 'status' => 404 ) );
		}

		$data = self::decode( (string) $row['payload'] );
		if ( null === $data ) {
			return new \WP_Error( 'bridgistic_snap_corrupt', 'Snapshot payload could not be decoded.', array( 'status' => 500 ) );
		}

		$result = self::apply( (string) $row['type'], $data );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		$wpdb->update( self::table(), array( 'restored_at' => current_time( 'mysql', true ) ), array( 'snapshot_id' => $snapshot_id ), array( '%s' ), array( '%s' ) ); // phpcs:ignore WordPress.DB

		return array(
			'snapshot_id' => $snapshot_id,
			'type'        => $row['type'],
			'restored'    => $result,
		);
	}

	/**
	 * Apply captured state back to the site.
	 *
	 * @param array<string,mixed> $data Captured payload.
	 * @return array<string,mixed>|\WP_Error
	 */
	private static function apply( string $type, array $data ) {
		global $wpdb;

		switch ( $type ) {
			case 'post':
				$post = $data['post'] ?? null;
				if ( ! $post ) {
					return new \WP_Error( 'bridgistic_snap_nopost', 'Snapshot had no post row.', array( 'status' => 500 ) );
				}
				$id = (int) $post['ID'];
				// Upsert the post row.
				$wpdb->replace( $wpdb->posts, $post ); // phpcs:ignore WordPress.DB
				// Replace meta wholesale.
				$wpdb->delete( $wpdb->postmeta, array( 'post_id' => $id ), array( '%d' ) ); // phpcs:ignore WordPress.DB
				foreach ( (array) ( $data['meta'] ?? array() ) as $m ) {
					$wpdb->insert( // phpcs:ignore WordPress.DB
						$wpdb->postmeta,
						array(
							'post_id'    => $id,
							'meta_key'   => $m['meta_key'],   // phpcs:ignore WordPress.DB.SlowDBQuery
							'meta_value' => $m['meta_value'], // phpcs:ignore WordPress.DB.SlowDBQuery
						),
						array( '%d', '%s', '%s' )
					);
				}
				clean_post_cache( $id );
				return array( 'post_id' => $id );

			case 'user':
				$user = $data['user'] ?? null;
				if ( ! $user ) {
					return new \WP_Error( 'bridgistic_snap_nouser', 'Snapshot had no user row.', array( 'status' => 500 ) );
				}
				$uid = (int) $user['ID'];
				$wpdb->replace( $wpdb->users, $user ); // phpcs:ignore WordPress.DB
				$wpdb->delete( $wpdb->usermeta, array( 'user_id' => $uid ), array( '%d' ) ); // phpcs:ignore WordPress.DB
				foreach ( (array) ( $data['meta'] ?? array() ) as $m ) {
					$wpdb->insert( // phpcs:ignore WordPress.DB
						$wpdb->usermeta,
						array(
							'user_id'    => $uid,
							'meta_key'   => $m['meta_key'],   // phpcs:ignore WordPress.DB.SlowDBQuery
							'meta_value' => $m['meta_value'], // phpcs:ignore WordPress.DB.SlowDBQuery
						),
						array( '%d', '%s', '%s' )
					);
				}
				clean_user_cache( $uid );
				return array( 'user_id' => $uid );

			case 'option':
				$name = (string) $data['name'];
				if ( ! $data['exists'] ) {
					delete_option( $name );
					return array( 'option' => $name, 'action' => 'deleted' );
				}
				update_option( $name, $data['value'], $data['autoload'] ?? 'yes' );
				return array( 'option' => $name, 'action' => 'restored' );

			case 'tables':
				foreach ( (array) ( $data['tables'] ?? array() ) as $t => $rows ) {
					$t = self::safe_table( (string) $t );
					if ( ! $t ) {
						continue;
					}
					$wpdb->query( 'START TRANSACTION' ); // phpcs:ignore WordPress.DB
					$wpdb->query( "DELETE FROM `{$t}`" ); // phpcs:ignore WordPress.DB
					foreach ( (array) $rows as $r ) {
						$wpdb->insert( $t, $r ); // phpcs:ignore WordPress.DB
					}
					$wpdb->query( 'COMMIT' ); // phpcs:ignore WordPress.DB
				}
				return array( 'tables' => array_keys( (array) $data['tables'] ) );

			case 'file':
				$path = self::safe_path( (string) $data['path'] );
				if ( ! $path ) {
					return new \WP_Error( 'bridgistic_snap_path', 'Path no longer valid.', array( 'status' => 400 ) );
				}
				if ( ! $data['exists'] ) {
					if ( file_exists( $path ) ) {
						wp_delete_file( $path );
					}
					return array( 'file' => $path, 'action' => 'removed' );
				}
				file_put_contents( $path, base64_decode( (string) $data['content'] ) ); // phpcs:ignore
				return array( 'file' => $path, 'action' => 'restored' );

			default:
				return new \WP_Error( 'bridgistic_snap_type', 'Unknown snapshot type on restore.', array( 'status' => 500 ) );
		}
	}

	/**
	 * Best-effort table snapshot derived from a write SQL statement.
	 * Returns a snapshot_id, or null if no table could be determined / cap exceeded.
	 */
	public static function for_sql( string $sql, string $key_id ): ?string {
		$tables = self::tables_from_sql( $sql );
		if ( ! $tables ) {
			return null;
		}
		$snap = self::create( 'tables', array( 'tables' => $tables ), 'auto: ' . mb_substr( $sql, 0, 60 ), $key_id );
		return is_wp_error( $snap ) ? null : $snap['snapshot_id'];
	}

	/**
	 * Extract target table names from a write statement.
	 *
	 * @return array<int,string>
	 */
	public static function tables_from_sql( string $sql ): array {
		$found = array();
		if ( preg_match( '/\b(?:update)\s+`?([a-z0-9_]+)`?/i', $sql, $m ) ) {
			$found[] = $m[1];
		}
		if ( preg_match( '/\b(?:delete\s+from|insert\s+into|replace\s+into|truncate(?:\s+table)?|alter\s+table|drop\s+table)\s+`?([a-z0-9_]+)`?/i', $sql, $m ) ) {
			$found[] = $m[1];
		}
		$valid = array();
		foreach ( array_unique( $found ) as $t ) {
			$safe = self::safe_table( $t );
			if ( $safe ) {
				$valid[] = $safe;
			}
		}
		return $valid;
	}

	/** Validate a table name exists in this DB; returns the real name or ''. */
	private static function safe_table( string $name ): string {
		global $wpdb;
		$name = preg_replace( '/[^a-zA-Z0-9_]/', '', $name );
		if ( '' === $name ) {
			return '';
		}
		$exists = $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $name ) ); // phpcs:ignore WordPress.DB
		return $exists ? $name : '';
	}

	/** Confine a path to ABSPATH, return realpath or ''. */
	private static function safe_path( string $path ): string {
		$base = realpath( ABSPATH );
		$real = realpath( $path );
		if ( false === $real ) {
			// Allow not-yet-existing files inside ABSPATH (for create-on-restore).
			$real = $path;
		}
		if ( false === $base || strpos( $real, $base ) !== 0 ) {
			return '';
		}
		return $real;
	}

	private static function encode( array $payload ): string {
		$json = (string) wp_json_encode( $payload );
		$gz   = function_exists( 'gzencode' ) ? gzencode( $json, 6 ) : false;
		return false !== $gz ? 'gz:' . base64_encode( $gz ) : 'raw:' . base64_encode( $json ); // phpcs:ignore
	}

	/**
	 * @return array<string,mixed>|null
	 */
	private static function decode( string $stored ): ?array {
		if ( strpos( $stored, 'gz:' ) === 0 ) {
			$raw = gzdecode( (string) base64_decode( substr( $stored, 3 ), true ) ); // phpcs:ignore
		} elseif ( strpos( $stored, 'raw:' ) === 0 ) {
			$raw = (string) base64_decode( substr( $stored, 4 ), true ); // phpcs:ignore
		} else {
			return null;
		}
		$data = json_decode( (string) $raw, true );
		return is_array( $data ) ? $data : null;
	}

	/** @return array<int,array<string,mixed>> */
	public static function list_recent( int $limit = 50 ): array {
		global $wpdb;
		$limit = max( 1, min( 500, $limit ) );
		$rows  = $wpdb->get_results( // phpcs:ignore WordPress.DB
			$wpdb->prepare( 'SELECT snapshot_id, label, type, byte_size, key_id, created_at, restored_at FROM ' . self::table() . ' ORDER BY id DESC LIMIT %d', $limit ),
			ARRAY_A
		);
		return is_array( $rows ) ? $rows : array();
	}

	public static function delete( string $snapshot_id ): void {
		global $wpdb;
		$wpdb->delete( self::table(), array( 'snapshot_id' => $snapshot_id ), array( '%s' ) ); // phpcs:ignore WordPress.DB
	}
}
