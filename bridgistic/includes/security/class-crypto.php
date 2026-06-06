<?php
/**
 * Authenticated encryption for secrets at rest.
 *
 * HMAC needs the live secret, so we encrypt (not hash) it. The encryption key
 * is derived from the per-site pepper + WP salts. For maximum hardening, move
 * BRIDGISTIC_ENC_KEY into wp-config.php (see README).
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic\Security;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Crypto {

	/**
	 * Derive a 32-byte key. Prefers a wp-config constant, falls back to
	 * pepper + AUTH salts so it still works out of the box.
	 */
	private static function key(): string {
		if ( defined( 'BRIDGISTIC_ENC_KEY' ) && strlen( (string) BRIDGISTIC_ENC_KEY ) >= 32 ) {
			return substr( hash( 'sha256', (string) BRIDGISTIC_ENC_KEY, true ), 0, 32 );
		}

		$pepper = (string) get_option( 'bridgistic_bridge_pepper', '' );
		$salt   = ( defined( 'AUTH_KEY' ) ? AUTH_KEY : '' ) . ( defined( 'SECURE_AUTH_KEY' ) ? SECURE_AUTH_KEY : '' );

		return substr( hash( 'sha256', 'bridgistic|' . $pepper . '|' . $salt, true ), 0, 32 );
	}

	/**
	 * Encrypt plaintext, return base64( nonce || ciphertext ).
	 */
	public static function encrypt( string $plaintext ): string {
		$key = self::key();

		if ( function_exists( 'sodium_crypto_secretbox' ) ) {
			$nonce  = random_bytes( SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
			$cipher = sodium_crypto_secretbox( $plaintext, $nonce, $key );
			return 'sb1:' . base64_encode( $nonce . $cipher ); // phpcs:ignore
		}

		// OpenSSL AES-256-GCM fallback.
		$iv     = random_bytes( 12 );
		$tag    = '';
		$cipher = openssl_encrypt( $plaintext, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag );
		return 'gcm1:' . base64_encode( $iv . $tag . $cipher ); // phpcs:ignore
	}

	/**
	 * Decrypt a value produced by encrypt(). Returns null on failure.
	 */
	public static function decrypt( string $stored ): ?string {
		$key = self::key();

		if ( strpos( $stored, 'sb1:' ) === 0 ) {
			$raw = base64_decode( substr( $stored, 4 ), true ); // phpcs:ignore
			if ( false === $raw || strlen( $raw ) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ) {
				return null;
			}
			$nonce  = substr( $raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
			$cipher = substr( $raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
			$plain  = sodium_crypto_secretbox_open( $cipher, $nonce, $key );
			return false === $plain ? null : $plain;
		}

		if ( strpos( $stored, 'gcm1:' ) === 0 ) {
			$raw = base64_decode( substr( $stored, 5 ), true ); // phpcs:ignore
			if ( false === $raw || strlen( $raw ) <= 28 ) {
				return null;
			}
			$iv     = substr( $raw, 0, 12 );
			$tag    = substr( $raw, 12, 16 );
			$cipher = substr( $raw, 28 );
			$plain  = openssl_decrypt( $cipher, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag );
			return false === $plain ? null : $plain;
		}

		return null;
	}
}
