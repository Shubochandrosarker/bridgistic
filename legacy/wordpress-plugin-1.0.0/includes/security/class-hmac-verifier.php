<?php
/**
 * HMAC request authentication.
 *
 * The MCP server signs every request:
 *   canonical = METHOD \n PATH \n TIMESTAMP \n NONCE \n sha256(body)
 *   signature = HMAC-SHA256( secret, canonical )
 *
 * Headers sent:
 *   X-Bridgistic-Key        public key id
 *   X-Bridgistic-Timestamp  unix seconds
 *   X-Bridgistic-Nonce      random per-request id
 *   X-Bridgistic-Signature  hex hmac
 *
 * This is strictly stronger than a bearer Application Password: a leaked
 * signature cannot be replayed (nonce + timestamp window) and the secret
 * never travels on the wire.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic\Security;

use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class HmacVerifier {

	/** Max clock skew allowed, in seconds. */
	private const WINDOW = 300;

	/**
	 * Authenticate a raw request.
	 *
	 * @param string $method   HTTP method (GET/POST/...).
	 * @param string $path     Route path that was signed (namespace-relative).
	 * @param string $body     Raw request body.
	 * @param array  $headers  Lowercased header map.
	 * @return array{key_id:string,scopes:array<int,string>}|WP_Error
	 */
	public static function authenticate( string $method, string $path, string $body, array $headers ) {
		$key_id    = $headers['x-bridgistic-key'] ?? '';
		$timestamp = $headers['x-bridgistic-timestamp'] ?? '';
		$nonce     = $headers['x-bridgistic-nonce'] ?? '';
		$signature = $headers['x-bridgistic-signature'] ?? '';

		if ( '' === $key_id || '' === $timestamp || '' === $nonce || '' === $signature ) {
			return new WP_Error( 'bridgistic_auth_missing', 'Missing authentication headers.', array( 'status' => 401 ) );
		}

		// 1. Timestamp window (anti-replay part 1).
		$ts  = (int) $timestamp;
		$now = time();
		if ( abs( $now - $ts ) > self::WINDOW ) {
			return new WP_Error( 'bridgistic_auth_stale', 'Request timestamp outside the allowed window.', array( 'status' => 401 ) );
		}

		// 2. Resolve key.
		$record = KeyStore::get( $key_id );
		if ( ! $record || (int) $record['enabled'] !== 1 ) {
			return new WP_Error( 'bridgistic_auth_key', 'Unknown or disabled key.', array( 'status' => 401 ) );
		}

		// 3. IP allowlist (if configured).
		if ( ! empty( $record['ip_allowlist'] ) && ! self::ip_allowed( self::client_ip(), $record['ip_allowlist'] ) ) {
			return new WP_Error( 'bridgistic_auth_ip', 'Source IP not allowed for this key.', array( 'status' => 403 ) );
		}

		// 4. Recompute signature.
		$secret = KeyStore::get_secret( $record );
		if ( null === $secret ) {
			return new WP_Error( 'bridgistic_auth_secret', 'Key secret could not be loaded.', array( 'status' => 500 ) );
		}

		$canonical = implode(
			"\n",
			array(
				strtoupper( $method ),
				$path,
				$timestamp,
				$nonce,
				hash( 'sha256', $body ),
			)
		);
		$expected = hash_hmac( 'sha256', $canonical, $secret );

		if ( ! hash_equals( $expected, (string) $signature ) ) {
			return new WP_Error( 'bridgistic_auth_signature', 'Invalid request signature.', array( 'status' => 401 ) );
		}

		// 5. Nonce replay check (anti-replay part 2).
		if ( ! self::consume_nonce( $key_id, $nonce ) ) {
			return new WP_Error( 'bridgistic_auth_replay', 'Nonce already used (possible replay).', array( 'status' => 409 ) );
		}

		KeyStore::touch( $key_id );

		return array(
			'key_id'        => $key_id,
			'scopes'        => $record['scopes'],
			'rate_limit'    => (int) ( $record['rate_limit'] ?? 120 ),
			'monthly_quota' => (int) ( $record['monthly_quota'] ?? 0 ),
			'tier'          => (string) ( $record['tier'] ?? 'custom' ),
		);
	}

	/**
	 * Store the nonce for the timestamp window; return false if it already existed.
	 */
	private static function consume_nonce( string $key_id, string $nonce ): bool {
		$transient = 'bridgistic_nonce_' . md5( $key_id . ':' . $nonce );
		if ( false !== get_transient( $transient ) ) {
			return false;
		}
		// Keep a little longer than the window so replays just outside are still blocked.
		set_transient( $transient, 1, self::WINDOW + 60 );
		return true;
	}

	/**
	 * @param array<int,string> $allowlist IPs or CIDR ranges.
	 */
	private static function ip_allowed( string $ip, array $allowlist ): bool {
		foreach ( $allowlist as $entry ) {
			if ( self::ip_matches( $ip, trim( $entry ) ) ) {
				return true;
			}
		}
		return false;
	}

	private static function ip_matches( string $ip, string $entry ): bool {
		if ( $ip === $entry ) {
			return true;
		}
		if ( strpos( $entry, '/' ) === false ) {
			return false;
		}
		// IPv4 CIDR.
		list( $subnet, $bits ) = explode( '/', $entry, 2 );
		$ip_long     = ip2long( $ip );
		$subnet_long = ip2long( $subnet );
		if ( false === $ip_long || false === $subnet_long ) {
			return false;
		}
		$mask = -1 << ( 32 - (int) $bits );
		return ( $ip_long & $mask ) === ( $subnet_long & $mask );
	}

	private static function client_ip(): string {
		// Trust REMOTE_ADDR by default; behind a known proxy the admin can extend this.
		return isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '';
	}
}
