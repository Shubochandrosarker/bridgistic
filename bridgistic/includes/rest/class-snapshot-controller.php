<?php
/**
 * Snapshot management endpoints (manual snapshots + restore/list/delete).
 * Auto-snapshots are created by the Guard; this is the explicit interface.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic\Rest;

use Bridgistic\Security\Scopes;
use Bridgistic\Snapshot;
use Bridgistic\AuditLog;
use WP_REST_Request;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class SnapshotController extends Controller {

	public function register( string $namespace ): void {
		register_rest_route(
			$namespace,
			'/snapshot',
			array(
				array(
					'methods'             => 'GET',
					'callback'            => array( $this, 'list_snapshots' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
				array(
					'methods'             => 'POST',
					'callback'            => array( $this, 'create_snapshot' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
			)
		);
		register_rest_route(
			$namespace,
			'/snapshot/restore',
			array(
				'methods'             => 'POST',
				'callback'            => array( $this, 'restore_snapshot' ),
				'permission_callback' => array( $this, 'authenticate' ),
			)
		);
		register_rest_route(
			$namespace,
			'/snapshot/delete',
			array(
				'methods'             => 'POST',
				'callback'            => array( $this, 'delete_snapshot' ),
				'permission_callback' => array( $this, 'authenticate' ),
			)
		);
	}

	public function list_snapshots( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::SNAPSHOT );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		return $this->ok( array( 'snapshots' => Snapshot::list_recent( (int) ( $request->get_param( 'limit' ) ?: 50 ) ) ) );
	}

	public function create_snapshot( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::SNAPSHOT );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$type   = (string) ( $request->get_param( 'type' ) ?? '' );
		$target = (array) ( $request->get_param( 'target' ) ?? array() );
		$label  = (string) ( $request->get_param( 'label' ) ?? '' );

		$res = Snapshot::create( $type, $target, $label, $this->key_id( $request ) );
		if ( is_wp_error( $res ) ) {
			return $res;
		}
		AuditLog::record( $this->key_id( $request ), 'snapshot.create', 'ok', array( 'type' => $type ) );
		return $this->ok( $res );
	}

	public function restore_snapshot( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::SNAPSHOT );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$id  = (string) ( $request->get_param( 'snapshot_id' ) ?? '' );
		$res = Snapshot::restore( $id );
		if ( is_wp_error( $res ) ) {
			AuditLog::record( $this->key_id( $request ), 'snapshot.restore', 'error', array( 'snapshot_id' => $id ), $res->get_error_message() );
			return $res;
		}
		AuditLog::record( $this->key_id( $request ), 'snapshot.restore', 'ok', array( 'snapshot_id' => $id ) );
		return $this->ok( $res );
	}

	public function delete_snapshot( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::SNAPSHOT );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$id = (string) ( $request->get_param( 'snapshot_id' ) ?? '' );
		Snapshot::delete( $id );
		return $this->ok( array( 'snapshot_id' => $id, 'deleted' => true ) );
	}
}
