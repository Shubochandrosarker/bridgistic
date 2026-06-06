<?php
/**
 * Base REST controller — shared auth, scope checks, and response shaping.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic\Rest;

use Bridgistic\Security\HmacVerifier;
use Bridgistic\AuditLog;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

abstract class Controller {

	/**
	 * permission_callback: verify the HMAC signature and stash the auth context.
	 *
	 * @return true|WP_Error
	 */
	public function authenticate( WP_REST_Request $request ) {
		// Trusted internal dispatch (playbook steps): a per-run random token,
		// never sent to clients, authorises the already-built __ctx. External
		// requests cannot forge it, so this is safe to short-circuit on.
		$internal = (string) $request->get_param( '__internal_token' );
		if ( '' !== $internal && \Bridgistic\Playbooks::valid_internal_token( $internal ) ) {
			return true;
		}

		$headers = array();
		foreach ( $request->get_headers() as $name => $values ) {
			$headers[ strtolower( $name ) ] = is_array( $values ) ? ( $values[0] ?? '' ) : $values;
		}

		$ctx = HmacVerifier::authenticate(
			$request->get_method(),
			$request->get_route(),
			$request->get_body(),
			$headers
		);

		if ( is_wp_error( $ctx ) ) {
			return $ctx;
		}

		// Rate-limit + monthly-quota enforcement + metering (one choke point for all routes).
		$metered = \Bridgistic\Usage::guard( $ctx );
		if ( is_wp_error( $metered ) ) {
			return $metered;
		}
		\Bridgistic\Usage::meter_action( (string) $ctx['key_id'], $this->action_name( $request ) );

		// Stash for the handler.
		$request->set_param( '__ctx', $ctx );
		return true;
	}

	/**
	 * Enforce a required scope. Returns WP_Error if missing.
	 *
	 * @return true|WP_Error
	 */
	protected function require_scope( WP_REST_Request $request, string $scope ) {
		$ctx    = (array) $request->get_param( '__ctx' );
		$scopes = (array) ( $ctx['scopes'] ?? array() );

		if ( ! in_array( $scope, $scopes, true ) ) {
			AuditLog::record( (string) ( $ctx['key_id'] ?? '' ), $this->action_name( $request ), 'denied', array( 'scope' => $scope ) );
			return new WP_Error(
				'bridgistic_scope_denied',
				sprintf( 'This key lacks the required scope: %s', $scope ),
				array( 'status' => 403 )
			);
		}
		return true;
	}

	protected function key_id( WP_REST_Request $request ): string {
		$ctx = (array) $request->get_param( '__ctx' );
		return (string) ( $ctx['key_id'] ?? '' );
	}

	protected function action_name( WP_REST_Request $request ): string {
		return trim( str_replace( '/' . BRIDGISTIC_REST_NAMESPACE, '', $request->get_route() ), '/' );
	}

	/**
	 * Standard success envelope.
	 *
	 * @param array<string,mixed> $data Payload.
	 */
	protected function ok( array $data, int $status = 200 ): WP_REST_Response {
		return new WP_REST_Response(
			array(
				'ok'   => true,
				'data' => $data,
			),
			$status
		);
	}

	protected function fail( string $code, string $message, int $status = 400 ): WP_Error {
		return new WP_Error( $code, $message, array( 'status' => $status ) );
	}
}
