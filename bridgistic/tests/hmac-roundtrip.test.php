<?php
/**
 * Bridgistic — HMAC round-trip unit test (no WordPress required).
 *
 * Exercises the REAL plugin classes — Crypto, Scopes, KeyStore, HmacVerifier —
 * against a minimal in-memory stub of the WordPress surface they touch. This is
 * the coverage the JS integration test cannot give: it proves that a minted key
 * is actually stored, that its secret can be recovered, and that a correctly
 * signed request authenticates (and that bad signatures, unknown/disabled keys,
 * and replays are rejected).
 *
 * Run: php tests/hmac-roundtrip.test.php
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

// ---- test harness ---------------------------------------------------------

$failures = 0;
$checks   = 0;

/**
 * @param mixed $cond Truthy assertion.
 */
function check( $cond, string $label ): void {
	global $failures, $checks;
	$checks++;
	if ( ! $cond ) {
		$failures++;
		fwrite( STDERR, "  FAIL  {$label}\n" );
	}
}

// ---- minimal WordPress stubs ---------------------------------------------

define( 'ABSPATH', __DIR__ . '/' );
define( 'ARRAY_A', 'ARRAY_A' );
define( 'AUTH_KEY', 'unit-test-auth-key-000000000000000000' );
define( 'SECURE_AUTH_KEY', 'unit-test-secure-auth-key-00000000000' );

$_SERVER['REMOTE_ADDR'] = '127.0.0.1';

$GLOBALS['__options']    = array( 'bridgistic_bridge_pepper' => 'unit-test-pepper-value' );
$GLOBALS['__transients'] = array();

/** Minimal WP_Error stand-in. */
class WP_Error {
	public string $code;
	public string $message;
	/** @var array<string,mixed> */
	public $data;
	/**
	 * @param array<string,mixed> $data Error data.
	 */
	public function __construct( string $code = '', string $message = '', $data = array() ) {
		$this->code    = $code;
		$this->message = $message;
		$this->data    = $data;
	}
	public function get_error_code(): string {
		return $this->code;
	}
	public function get_error_message(): string {
		return $this->message;
	}
}

/**
 * @param mixed $thing Value to test.
 */
function is_wp_error( $thing ): bool {
	return $thing instanceof WP_Error;
}

/**
 * @param mixed $default Default when the option is absent.
 * @return mixed
 */
function get_option( string $name, $default = false ) {
	return $GLOBALS['__options'][ $name ] ?? $default;
}

/**
 * @param mixed $value Option value.
 */
function add_option( string $name, $value, string $deprecated = '', string $autoload = 'yes' ): bool {
	$GLOBALS['__options'][ $name ] = $value;
	return true;
}

/**
 * @return mixed
 */
function get_transient( string $key ) {
	return $GLOBALS['__transients'][ $key ] ?? false;
}

/**
 * @param mixed $value Transient value.
 */
function set_transient( string $key, $value, int $expiration = 0 ): bool {
	$GLOBALS['__transients'][ $key ] = $value;
	return true;
}

/**
 * @param mixed $data Value to encode.
 */
function wp_json_encode( $data ): string {
	return (string) json_encode( $data );
}

/**
 * @param mixed $str Value to unslash.
 * @return mixed
 */
function wp_unslash( $str ) {
	return $str;
}

function sanitize_text_field( string $str ): string {
	return trim( $str );
}

/**
 * @return string
 */
function current_time( string $type, bool $gmt = false ): string {
	return gmdate( 'Y-m-d H:i:s' );
}

/**
 * Tiny in-memory $wpdb good enough for KeyStore mint + lookup.
 */
class FakeWpdb {
	public string $prefix = 'wp_';
	public int $insert_id = 0;
	public string $last_error = '';
	/** @var array<string,array<int,array<string,mixed>>> */
	private array $store = array();

	public function get_charset_collate(): string {
		return '';
	}

	/**
	 * @param array<string,mixed> $data    Row data.
	 * @param array<int,string>   $formats Column formats.
	 */
	public function insert( string $table, array $data, $formats = null ): int {
		$this->store[ $table ][] = $data;
		return 1;
	}

	public function update( string $table, array $data, array $where, $f = null, $wf = null ): int {
		return 1;
	}

	public function query( string $sql ): int {
		return 0;
	}

	/**
	 * Substitute %s/%d/%f placeholders like $wpdb->prepare.
	 *
	 * @param mixed ...$args Bound values.
	 */
	public function prepare( string $query, ...$args ): string {
		if ( isset( $args[0] ) && is_array( $args[0] ) ) {
			$args = $args[0];
		}
		foreach ( $args as $a ) {
			$rep   = is_int( $a ) ? (string) $a : "'" . addslashes( (string) $a ) . "'";
			$query = preg_replace( '/%[sdf]/', $rep, $query, 1 );
		}
		return (string) $query;
	}

	/**
	 * Return the stored row whose key_id appears in the (prepared) query.
	 *
	 * @return array<string,mixed>|null
	 */
	public function get_row( string $query, $output = null ): ?array {
		foreach ( $this->store as $rows ) {
			foreach ( $rows as $r ) {
				if ( isset( $r['key_id'] ) && strpos( $query, (string) $r['key_id'] ) !== false ) {
					return $r;
				}
			}
		}
		return null;
	}

	/**
	 * @return mixed
	 */
	public function get_var( string $query ) {
		return null;
	}
}

$GLOBALS['wpdb'] = new FakeWpdb();

// ---- load the real classes under test ------------------------------------

$base = dirname( __DIR__ ) . '/includes/security/';
require_once $base . 'class-crypto.php';
require_once $base . 'class-scopes.php';
require_once $base . 'class-key-store.php';
require_once $base . 'class-hmac-verifier.php';

use Bridgistic\Security\Crypto;
use Bridgistic\Security\KeyStore;
use Bridgistic\Security\HmacVerifier;

// ---- 1. Crypto round-trips ------------------------------------------------

$secret_plain = 'wps_' . bin2hex( random_bytes( 24 ) );
$enc          = Crypto::encrypt( $secret_plain );
check( is_string( $enc ) && '' !== $enc, 'Crypto::encrypt returns a non-empty string' );
check( Crypto::decrypt( $enc ) === $secret_plain, 'Crypto::decrypt recovers the plaintext secret' );

// ---- 2. KeyStore mints a usable, recoverable key --------------------------

$minted = KeyStore::create( 'Unit Test Key', array( 'site:read', 'posts:read' ), array(), 120, false, 'custom', 0 );
check( isset( $minted['key_id'], $minted['secret'] ), 'KeyStore::create returns key_id + secret' );

$key_id = (string) $minted['key_id'];
$secret = (string) $minted['secret'];

$record = KeyStore::get( $key_id );
check( is_array( $record ), 'KeyStore::get finds the minted record' );
check( is_array( $record ) && KeyStore::get_secret( $record ) === $secret, 'Stored secret decrypts back to the minted secret' );

// ---- 3. A correctly signed request authenticates --------------------------

/**
 * Build the signed headers exactly like the MCP server's signer.
 *
 * @return array<string,string>
 */
function sign_headers( string $method, string $path, string $body, string $key_id, string $secret, ?string $nonce = null ): array {
	$ts        = (string) time();
	$nonce     = $nonce ?? bin2hex( random_bytes( 16 ) );
	$canonical = implode( "\n", array( strtoupper( $method ), $path, $ts, $nonce, hash( 'sha256', $body ) ) );
	$sig       = hash_hmac( 'sha256', $canonical, $secret );
	return array(
		'x-bridgistic-key'       => $key_id,
		'x-bridgistic-timestamp' => $ts,
		'x-bridgistic-nonce'     => $nonce,
		'x-bridgistic-signature' => $sig,
	);
}

$method = 'GET';
$path   = '/bridgistic/v1/site-info';
$body   = '';

$ctx = HmacVerifier::authenticate( $method, $path, $body, sign_headers( $method, $path, $body, $key_id, $secret ) );
check( is_array( $ctx ), 'Valid signature authenticates' );
check( is_array( $ctx ) && ( $ctx['key_id'] ?? '' ) === $key_id, 'Auth context carries the key_id' );
check( is_array( $ctx ) && in_array( 'posts:read', (array) ( $ctx['scopes'] ?? array() ), true ), 'Auth context carries the granted scopes' );

// ---- 4. A tampered signature is rejected ----------------------------------

$bad          = sign_headers( $method, $path, $body, $key_id, 'wrong-secret' );
$bad_result   = HmacVerifier::authenticate( $method, $path, $body, $bad );
check( is_wp_error( $bad_result ), 'Wrong secret is rejected' );
check( is_wp_error( $bad_result ) && $bad_result->get_error_code() === 'bridgistic_auth_signature', 'Wrong secret yields a signature error' );

// ---- 5. Unknown key is rejected -------------------------------------------

$unknown = HmacVerifier::authenticate( $method, $path, $body, sign_headers( $method, $path, $body, 'wpk_does_not_exist', $secret ) );
check( is_wp_error( $unknown ) && $unknown->get_error_code() === 'bridgistic_auth_key', 'Unknown key is rejected' );

// ---- 6. Replay of a used nonce is rejected --------------------------------

$replay_headers = sign_headers( $method, $path, $body, $key_id, $secret, 'fixed-nonce-abc' );
$first          = HmacVerifier::authenticate( $method, $path, $body, $replay_headers );
$second         = HmacVerifier::authenticate( $method, $path, $body, $replay_headers );
check( is_array( $first ), 'First use of a nonce succeeds' );
check( is_wp_error( $second ) && $second->get_error_code() === 'bridgistic_auth_replay', 'Replayed nonce is rejected' );

// ---- 7. Stale timestamp is rejected ---------------------------------------

$stale_headers = sign_headers( $method, $path, $body, $key_id, $secret );
$stale_headers['x-bridgistic-timestamp'] = (string) ( time() - 4000 );
// Re-sign with the stale timestamp so only the freshness check can fail.
$stale_canonical = implode( "\n", array( $method, $path, $stale_headers['x-bridgistic-timestamp'], $stale_headers['x-bridgistic-nonce'], hash( 'sha256', $body ) ) );
$stale_headers['x-bridgistic-signature'] = hash_hmac( 'sha256', $stale_canonical, $secret );
$stale = HmacVerifier::authenticate( $method, $path, $body, $stale_headers );
check( is_wp_error( $stale ) && $stale->get_error_code() === 'bridgistic_auth_stale', 'Stale timestamp is rejected' );

// ---- report ---------------------------------------------------------------

if ( $failures > 0 ) {
	fwrite( STDERR, "\nFAIL  hmac-roundtrip — {$failures} of {$checks} checks failed\n" );
	exit( 1 );
}

fwrite( STDOUT, "PASS  hmac-roundtrip — {$checks} checks\n" );
exit( 0 );
