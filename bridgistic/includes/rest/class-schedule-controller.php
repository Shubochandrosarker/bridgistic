<?php
/**
 * Scheduled-playbook endpoints. A schedule is bound to the calling key; its
 * runs execute under that key's current scopes.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic\Rest;

use Bridgistic\Security\Scopes;
use Bridgistic\Scheduler;
use WP_REST_Request;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class ScheduleController extends Controller {

	public function register( string $namespace ): void {
		register_rest_route(
			$namespace,
			'/schedules',
			array(
				array(
					'methods'             => 'GET',
					'callback'            => array( $this, 'list_schedules' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
				array(
					'methods'             => 'POST',
					'callback'            => array( $this, 'create_schedule' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
			)
		);
		foreach ( array( 'toggle', 'delete', 'run-now' ) as $op ) {
			register_rest_route(
				$namespace,
				"/schedules/{$op}",
				array(
					'methods'             => 'POST',
					'callback'            => array( $this, str_replace( '-', '_', $op ) . '_schedule' ),
					'permission_callback' => array( $this, 'authenticate' ),
				)
			);
		}
	}

	public function list_schedules( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::SCHEDULE_MANAGE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		return $this->ok(
			array(
				'schedules'   => Scheduler::list(),
				'recurrences' => Scheduler::recurrences(),
			)
		);
	}

	public function create_schedule( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::SCHEDULE_MANAGE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$start_at = $request->get_param( 'start_at' );
		$res      = Scheduler::create(
			(string) ( $request->get_param( 'playbook' ) ?? '' ),
			(string) ( $request->get_param( 'recurrence' ) ?? 'daily' ),
			(array) ( $request->get_param( 'vars' ) ?? array() ),
			array(
				'dry_run' => (bool) $request->get_param( 'dry_run' ),
				'force'   => (bool) $request->get_param( 'force' ),
			),
			$this->key_id( $request ),
			$start_at ? (int) $start_at : null
		);
		return is_wp_error( $res ) ? $res : $this->ok( $res );
	}

	public function toggle_schedule( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::SCHEDULE_MANAGE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$id = (string) ( $request->get_param( 'schedule_id' ) ?? '' );
		$ok = Scheduler::toggle( $id, $this->truthy( $request->get_param( 'enabled' ) ) );
		return $ok ? $this->ok( array( 'schedule_id' => $id, 'enabled' => $this->truthy( $request->get_param( 'enabled' ) ) ) )
			: $this->fail( 'bridgistic_sched_404', 'Schedule not found.', 404 );
	}

	public function delete_schedule( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::SCHEDULE_MANAGE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$id = (string) ( $request->get_param( 'schedule_id' ) ?? '' );
		Scheduler::delete( $id );
		return $this->ok( array( 'schedule_id' => $id, 'deleted' => true ) );
	}

	public function run_now_schedule( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::SCHEDULE_MANAGE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$id  = (string) ( $request->get_param( 'schedule_id' ) ?? '' );
		$row = Scheduler::get( $id );
		if ( ! $row ) {
			return $this->fail( 'bridgistic_sched_404', 'Schedule not found.', 404 );
		}
		return $this->ok( Scheduler::execute( $row ) );
	}

	private function truthy( $v ): bool {
		return true === $v || '1' === $v || 1 === $v || 'true' === $v;
	}
}
