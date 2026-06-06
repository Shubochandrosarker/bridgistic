<?php
/**
 * Execution guard.
 *
 * Every destructive operation is funnelled through Guard::run(), which applies,
 * in order: dry-run preview → approval gate → auto-snapshot → execute → audit.
 * Controllers stay tiny: they declare the action and pass closures.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic;

use Bridgistic\Security\KeyStore;
use WP_REST_Request;
use WP_REST_Response;
use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Guard {

	/**
	 * Run a guarded operation.
	 *
	 * @param WP_REST_Request $request The REST request (carries __ctx, dry_run, approval_id, force).
	 * @param array{
	 *   action:string,
	 *   destructive?:bool,
	 *   mutating?:bool,
	 *   payload?:array<string,mixed>,
	 *   summary?:string,
	 *   force_approval?:bool,
	 *   snapshot?:callable():(array<string,mixed>|WP_Error|null),
	 *   dry_run?:callable():array<string,mixed>,
	 *   execute:callable():(array<string,mixed>|WP_Error)
	 * } $op Operation definition.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function run( WP_REST_Request $request, array $op ) {
		$ctx         = (array) $request->get_param( '__ctx' );
		$key_id      = (string) ( $ctx['key_id'] ?? '' );
		$action      = (string) $op['action'];
		$destructive = (bool) ( $op['destructive'] ?? true );
		$mutating    = (bool) ( $op['mutating'] ?? true );
		$payload     = (array) ( $op['payload'] ?? array() );
		$summary     = (string) ( $op['summary'] ?? $action );

		$dry_run     = self::truthy( $request->get_param( 'dry_run' ) );
		$approval_id = (string) ( $request->get_param( 'approval_id' ) ?? '' );
		$force       = self::truthy( $request->get_param( 'force' ) );

		// 1. Dry-run — never mutates, never snapshots, never queues.
		if ( $dry_run ) {
			$report = isset( $op['dry_run'] ) && is_callable( $op['dry_run'] )
				? (array) call_user_func( $op['dry_run'] )
				: array( 'note' => 'No structured preview available for this action; nothing was changed.' );
			AuditLog::record( $key_id, $action, 'dry_run', $payload, $summary );
			return self::ok(
				array(
					'dry_run' => true,
					'action'  => $action,
					'would'   => $report,
				)
			);
		}

		// 2. Approval gate (per-key flag, or op forces it).
		$needs_approval = $mutating && ( self::key_requires_approval( $key_id ) || ! empty( $op['force_approval'] ) );

		if ( $needs_approval ) {
			if ( '' === $approval_id ) {
				$new_id = Approvals::enqueue( $key_id, $action, $payload, $summary );
				AuditLog::record( $key_id, $action, 'queued', $payload, $summary );
				return self::ok(
					array(
						'status'      => 'pending_approval',
						'approval_id' => $new_id,
						'action'      => $action,
						'summary'     => $summary,
						'next'        => 'An administrator must approve this in WP Admin → Bridgistic → Approvals, then retry the same call with this approval_id.',
					),
					202
				);
			}

			$ready = Approvals::verify_ready( $approval_id, $action, $payload );
			if ( is_wp_error( $ready ) ) {
				AuditLog::record( $key_id, $action, 'approval_' . $ready->get_error_code(), $payload, $summary );
				return $ready;
			}
		}

		// 3. Auto-snapshot before mutating.
		$snapshot_id = null;
		if ( $destructive && isset( $op['snapshot'] ) && is_callable( $op['snapshot'] ) ) {
			$snap = call_user_func( $op['snapshot'] );
			if ( is_wp_error( $snap ) ) {
				if ( ! $force ) {
					AuditLog::record( $key_id, $action, 'snapshot_failed', $payload, $snap->get_error_message() );
					return new WP_Error(
						'bridgistic_snapshot_required',
						'Could not snapshot before this destructive op: ' . $snap->get_error_message() . ' Pass force=true to proceed without a snapshot (irreversible).',
						array( 'status' => 412 )
					);
				}
			} elseif ( is_array( $snap ) && isset( $snap['snapshot_id'] ) ) {
				$snapshot_id = $snap['snapshot_id'];
			}
		}

		// 4. Execute.
		$result = call_user_func( $op['execute'] );
		if ( is_wp_error( $result ) ) {
			AuditLog::record( $key_id, $action, 'error', $payload, $result->get_error_message() );
			return $result;
		}

		if ( $needs_approval && '' !== $approval_id ) {
			Approvals::mark_executed( $approval_id );
		}

		AuditLog::record( $key_id, $action, 'ok', $payload, $summary );

		$envelope = array( 'result' => $result );
		if ( $snapshot_id ) {
			$envelope['snapshot_id'] = $snapshot_id;
			$envelope['undo']        = 'Call bridgistic_snapshot_restore with this snapshot_id to revert.';
		}
		return self::ok( $envelope );
	}

	private static function key_requires_approval( string $key_id ): bool {
		$rec = KeyStore::get( $key_id );
		return $rec && (int) ( $rec['require_approval'] ?? 0 ) === 1;
	}

	private static function truthy( $v ): bool {
		return true === $v || '1' === $v || 1 === $v || 'true' === $v;
	}

	private static function ok( array $data, int $status = 200 ): WP_REST_Response {
		return new WP_REST_Response(
			array(
				'ok'   => true,
				'data' => $data,
			),
			$status
		);
	}
}
