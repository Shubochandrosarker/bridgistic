<?php
/**
 * Reusable playbooks: ordered, parameterised sequences of bridge operations
 * (e.g. "spin up a landing page": create post → upload hero → set option).
 *
 * Steps are dispatched internally through the real REST pipeline via
 * rest_do_request(), so every step inherits the caller's scopes plus the Guard
 * (dry-run / approval / snapshot). A per-run random token authorises the
 * internal calls so external requests can never forge the trusted context.
 *
 * Step shape:
 *   { "method": "POST", "route": "posts", "params": { "title": "{{vars.title}}" }, "save_as": "page" }
 * Later steps reference earlier results: "{{steps.page.data.result.id}}" and run
 * inputs: "{{vars.NAME}}".
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic;

use WP_REST_Request;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Playbooks {

	/** Route prefixes a playbook step is allowed to call (no recursion into playbooks). */
	private const ALLOWED_PREFIXES = array(
		'posts', 'media', 'users', 'options', 'plugins',
		'fs', 'snapshot', 'execute', 'db', 'memory', 'site-info',
	);

	private static string $internal_token = '';

	private static function table(): string {
		global $wpdb;
		return $wpdb->prefix . 'bridgistic_playbooks';
	}

	public static function install(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$table   = self::table();
		$charset = $wpdb->get_charset_collate();

		$sql = "CREATE TABLE {$table} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			slug VARCHAR(96) NOT NULL,
			name VARCHAR(191) NOT NULL DEFAULT '',
			description TEXT NULL,
			steps LONGTEXT NULL,
			created_by VARCHAR(40) NOT NULL DEFAULT '',
			created_at DATETIME NOT NULL,
			updated_at DATETIME NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY slug (slug)
		) {$charset};";

		dbDelta( $sql );
	}

	// ---- internal-dispatch trust ------------------------------------------

	public static function valid_internal_token( string $token ): bool {
		return '' !== self::$internal_token && hash_equals( self::$internal_token, $token );
	}

	private static function begin_internal(): string {
		self::$internal_token = bin2hex( random_bytes( 32 ) );
		return self::$internal_token;
	}

	private static function end_internal(): void {
		self::$internal_token = '';
	}

	// ---- CRUD -------------------------------------------------------------

	/**
	 * @param array<int,array<string,mixed>> $steps Step definitions.
	 * @return array<string,mixed>|\WP_Error
	 */
	public static function save( string $slug, string $name, string $description, array $steps, string $by = '' ) {
		$slug = sanitize_title( $slug );
		if ( '' === $slug ) {
			return new \WP_Error( 'bridgistic_pb_slug', 'A valid slug is required.', array( 'status' => 400 ) );
		}
		$check = self::validate_steps( $steps );
		if ( is_wp_error( $check ) ) {
			return $check;
		}

		global $wpdb;
		$now = current_time( 'mysql', true );
		$wpdb->query( // phpcs:ignore WordPress.DB
			$wpdb->prepare(
				'INSERT INTO ' . self::table() . ' (slug, name, description, steps, created_by, created_at, updated_at)
				 VALUES (%s, %s, %s, %s, %s, %s, %s)
				 ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), steps = VALUES(steps), updated_at = VALUES(updated_at)',
				$slug,
				mb_substr( $name, 0, 191 ),
				$description,
				(string) wp_json_encode( $steps ),
				$by,
				$now,
				$now
			)
		);
		return array( 'slug' => $slug, 'steps' => count( $steps ), 'saved' => true );
	}

	/**
	 * @return array<string,mixed>|null
	 */
	public static function get( string $slug ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM ' . self::table() . ' WHERE slug = %s', sanitize_title( $slug ) ), ARRAY_A ); // phpcs:ignore WordPress.DB
		if ( ! $row ) {
			return null;
		}
		$row['steps'] = json_decode( (string) $row['steps'], true ) ?: array();
		return $row;
	}

	/** @return array<int,array<string,mixed>> */
	public static function list(): array {
		global $wpdb;
		$rows = $wpdb->get_results( 'SELECT slug, name, description, created_at, updated_at FROM ' . self::table() . ' ORDER BY slug ASC', ARRAY_A ); // phpcs:ignore WordPress.DB
		return is_array( $rows ) ? $rows : array();
	}

	public static function delete( string $slug ): void {
		global $wpdb;
		$wpdb->delete( self::table(), array( 'slug' => sanitize_title( $slug ) ), array( '%s' ) ); // phpcs:ignore WordPress.DB
	}

	// ---- validation -------------------------------------------------------

	/**
	 * @param array<int,mixed> $steps Steps to validate.
	 * @return true|\WP_Error
	 */
	private static function validate_steps( array $steps ) {
		if ( ! $steps ) {
			return new \WP_Error( 'bridgistic_pb_empty', 'A playbook needs at least one step.', array( 'status' => 400 ) );
		}
		foreach ( $steps as $i => $step ) {
			if ( ! is_array( $step ) ) {
				return new \WP_Error( 'bridgistic_pb_step', "Step {$i} is not an object.", array( 'status' => 400 ) );
			}
			$method = strtoupper( (string) ( $step['method'] ?? 'POST' ) );
			if ( ! in_array( $method, array( 'GET', 'POST', 'DELETE' ), true ) ) {
				return new \WP_Error( 'bridgistic_pb_method', "Step {$i}: method must be GET/POST/DELETE.", array( 'status' => 400 ) );
			}
			$route  = ltrim( (string) ( $step['route'] ?? '' ), '/' );
			$prefix = explode( '/', $route )[0] ?? '';
			if ( '' === $route || ! in_array( $prefix, self::ALLOWED_PREFIXES, true ) ) {
				return new \WP_Error( 'bridgistic_pb_route', "Step {$i}: route '{$route}' is empty or not allowed.", array( 'status' => 400 ) );
			}
		}
		return true;
	}

	// ---- execution --------------------------------------------------------

	/**
	 * Run a playbook.
	 *
	 * @param string              $slug Playbook slug.
	 * @param array<string,mixed> $vars Run-time variables.
	 * @param array<string,mixed> $ctx  Caller auth context (key_id + scopes).
	 * @param array<string,mixed> $opts dry_run(bool), force(bool), approvals(map ref=>approval_id).
	 * @return array<string,mixed>|\WP_Error
	 */
	public static function run( string $slug, array $vars, array $ctx, array $opts = array() ) {
		$pb = self::get( $slug );
		if ( ! $pb ) {
			return new \WP_Error( 'bridgistic_pb_404', "Playbook '{$slug}' not found.", array( 'status' => 404 ) );
		}

		$steps     = (array) $pb['steps'];
		$results   = array();
		$ran       = array();
		$approvals = (array) ( $opts['approvals'] ?? array() );
		$token     = self::begin_internal();

		try {
			foreach ( $steps as $i => $step ) {
				$ref    = (string) ( $step['save_as'] ?? ( 'step' . $i ) );
				$method = strtoupper( (string) ( $step['method'] ?? 'POST' ) );
				$route  = ltrim( (string) ( $step['route'] ?? '' ), '/' );
				$params = self::resolve( (array) ( $step['params'] ?? array() ), $vars, $results );

				$req = new WP_REST_Request( $method, '/' . BRIDGISTIC_REST_NAMESPACE . '/' . $route );
				foreach ( $params as $k => $v ) {
					$req->set_param( $k, $v );
				}
				$req->set_param( '__ctx', $ctx );
				$req->set_param( '__internal_token', $token );
				if ( isset( $opts['dry_run'] ) ) {
					$req->set_param( 'dry_run', (bool) $opts['dry_run'] );
				}
				if ( isset( $opts['force'] ) ) {
					$req->set_param( 'force', (bool) $opts['force'] );
				}
				if ( ! empty( $approvals[ $ref ] ) ) {
					$req->set_param( 'approval_id', (string) $approvals[ $ref ] );
				}

				$res    = rest_do_request( $req );
				$status = $res->get_status();
				$body   = $res->get_data();
				$ran[]  = array( 'ref' => $ref, 'method' => $method, 'route' => $route, 'status' => $status );

				$pending = is_array( $body ) && ( ( $body['data']['status'] ?? '' ) === 'pending_approval' );
				if ( 202 === $status || $pending ) {
					return array(
						'status'        => 'paused_for_approval',
						'paused_at'     => $ref,
						'approval_id'   => is_array( $body ) ? ( $body['data']['approval_id'] ?? null ) : null,
						'message'       => "Step '{$ref}' needs approval. Approve in WP Admin, then re-run with approvals[\"{$ref}\"] = the approval_id.",
						'completed'     => $ran,
						'results'       => $results,
					);
				}
				if ( $status >= 400 ) {
					return array(
						'status'      => 'failed',
						'failed_at'   => $ref,
						'http_status' => $status,
						'response'    => $body,
						'completed'   => array_slice( $ran, 0, -1 ),
						'results'     => $results,
					);
				}

				$results[ $ref ] = $body;
			}

			return array(
				'status'  => 'ok',
				'ran'     => $ran,
				'results' => $results,
			);
		} finally {
			self::end_internal();
		}
	}

	// ---- variable resolution ----------------------------------------------

	/**
	 * Recursively resolve {{vars.X}} / {{steps.ref.path}} templates in params.
	 *
	 * @param mixed                $value   Value to resolve.
	 * @param array<string,mixed>  $vars    Run vars.
	 * @param array<string,mixed>  $results Prior step results.
	 * @return mixed
	 */
	private static function resolve( $value, array $vars, array $results ) {
		if ( is_array( $value ) ) {
			$out = array();
			foreach ( $value as $k => $v ) {
				$out[ $k ] = self::resolve( $v, $vars, $results );
			}
			return $out;
		}
		if ( ! is_string( $value ) ) {
			return $value;
		}
		// Whole-string template → return the raw typed value.
		if ( preg_match( '/^\{\{\s*(.+?)\s*\}\}$/', $value, $m ) ) {
			return self::resolve_path( $m[1], $vars, $results );
		}
		// Inline templates → string interpolation.
		return preg_replace_callback(
			'/\{\{\s*(.+?)\s*\}\}/',
			static function ( $m ) use ( $vars, $results ) {
				$v = self::resolve_path( $m[1], $vars, $results );
				return is_scalar( $v ) ? (string) $v : (string) wp_json_encode( $v );
			},
			$value
		);
	}

	/**
	 * @param array<string,mixed> $vars    Run vars.
	 * @param array<string,mixed> $results Prior step results.
	 * @return mixed
	 */
	private static function resolve_path( string $expr, array $vars, array $results ) {
		$parts = explode( '.', trim( $expr ) );
		$head  = array_shift( $parts );

		if ( 'vars' === $head ) {
			$cur = $vars;
		} elseif ( 'steps' === $head ) {
			$ref = array_shift( $parts );
			$cur = $results[ $ref ] ?? null;
		} else {
			return null;
		}

		foreach ( $parts as $p ) {
			if ( is_array( $cur ) && array_key_exists( $p, $cur ) ) {
				$cur = $cur[ $p ];
			} else {
				return null;
			}
		}
		return $cur;
	}
}
