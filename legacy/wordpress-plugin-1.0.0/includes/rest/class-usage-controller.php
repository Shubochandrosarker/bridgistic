<?php
/**
 * Lets a key read its own usage + limits (read-only, no extra scope).
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic\Rest;

use Bridgistic\Usage;
use WP_REST_Request;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class UsageController extends Controller {

	public function register( string $namespace ): void {
		register_rest_route(
			$namespace,
			'/usage',
			array(
				'methods'             => 'GET',
				'callback'            => array( $this, 'usage' ),
				'permission_callback' => array( $this, 'authenticate' ),
			)
		);
	}

	public function usage( WP_REST_Request $request ) {
		$ctx = (array) $request->get_param( '__ctx' );
		$key = (string) ( $ctx['key_id'] ?? '' );

		$summary = Usage::summary( $key );
		$quota   = (int) ( $ctx['monthly_quota'] ?? 0 );

		return $this->ok(
			array(
				'tier'         => (string) ( $ctx['tier'] ?? 'custom' ),
				'rate_limit'   => (int) ( $ctx['rate_limit'] ?? 120 ),
				'monthly_quota' => $quota,
				'usage'        => $summary,
				'quota_remaining' => $quota > 0 ? max( 0, $quota - (int) $summary['this_month'] ) : null,
			)
		);
	}
}
