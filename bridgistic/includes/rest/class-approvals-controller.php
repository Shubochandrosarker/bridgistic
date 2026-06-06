<?php
/**
 * Approval status endpoint for the agent. Approving/rejecting is done by a human
 * in WP Admin (Bridgistic → Approvals), never via the API.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic\Rest;

use Bridgistic\Approvals;
use WP_REST_Request;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class ApprovalsController extends Controller {

	public function register( string $namespace ): void {
		register_rest_route(
			$namespace,
			'/approvals/status',
			array(
				'methods'             => 'GET',
				'callback'            => array( $this, 'status' ),
				'permission_callback' => array( $this, 'authenticate' ),
			)
		);
	}

	public function status( WP_REST_Request $request ) {
		$id  = (string) ( $request->get_param( 'approval_id' ) ?? '' );
		$row = Approvals::get( $id );
		if ( ! $row ) {
			return $this->fail( 'bridgistic_approval_404', 'Approval not found.', 404 );
		}
		// A key may only see its own approvals.
		if ( (string) $row['key_id'] !== $this->key_id( $request ) ) {
			return $this->fail( 'bridgistic_approval_forbidden', 'Not your approval.', 403 );
		}
		return $this->ok(
			array(
				'approval_id' => $row['approval_id'],
				'action'      => $row['action'],
				'status'      => $row['status'],
				'summary'     => $row['summary'],
				'created_at'  => $row['created_at'],
				'decided_at'  => $row['decided_at'],
			)
		);
	}
}
