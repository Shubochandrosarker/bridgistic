<?php
/**
 * Playbook endpoints. Running a playbook executes its steps through the internal
 * dispatcher, inheriting the calling key's scopes + the Guard on each step.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic\Rest;

use Bridgistic\Security\Scopes;
use Bridgistic\Playbooks;
use WP_REST_Request;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class PlaybookController extends Controller {

	public function register( string $namespace ): void {
		register_rest_route(
			$namespace,
			'/playbooks',
			array(
				array(
					'methods'             => 'GET',
					'callback'            => array( $this, 'list_playbooks' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
				array(
					'methods'             => 'POST',
					'callback'            => array( $this, 'save_playbook' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
			)
		);
		register_rest_route(
			$namespace,
			'/playbooks/run',
			array(
				'methods'             => 'POST',
				'callback'            => array( $this, 'run_playbook' ),
				'permission_callback' => array( $this, 'authenticate' ),
			)
		);
		register_rest_route(
			$namespace,
			'/playbooks/delete',
			array(
				'methods'             => 'POST',
				'callback'            => array( $this, 'delete_playbook' ),
				'permission_callback' => array( $this, 'authenticate' ),
			)
		);
		register_rest_route(
			$namespace,
			'/playbooks/(?P<slug>[a-z0-9-]+)',
			array(
				'methods'             => 'GET',
				'callback'            => array( $this, 'get_playbook' ),
				'permission_callback' => array( $this, 'authenticate' ),
			)
		);
	}

	public function list_playbooks( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::PLAYBOOK_MANAGE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		return $this->ok( array( 'playbooks' => Playbooks::list() ) );
	}

	public function get_playbook( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::PLAYBOOK_MANAGE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$pb = Playbooks::get( (string) $request['slug'] );
		return $pb ? $this->ok( $pb ) : $this->fail( 'bridgistic_pb_404', 'Playbook not found.', 404 );
	}

	public function save_playbook( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::PLAYBOOK_MANAGE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$res = Playbooks::save(
			(string) ( $request->get_param( 'slug' ) ?? '' ),
			(string) ( $request->get_param( 'name' ) ?? '' ),
			(string) ( $request->get_param( 'description' ) ?? '' ),
			(array) ( $request->get_param( 'steps' ) ?? array() ),
			$this->key_id( $request )
		);
		return is_wp_error( $res ) ? $res : $this->ok( $res );
	}

	public function run_playbook( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::PLAYBOOK_MANAGE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$ctx  = (array) $request->get_param( '__ctx' );
		$opts = array(
			'dry_run'   => $request->get_param( 'dry_run' ),
			'force'     => $request->get_param( 'force' ),
			'approvals' => (array) ( $request->get_param( 'approvals' ) ?? array() ),
		);
		$res = Playbooks::run(
			(string) ( $request->get_param( 'slug' ) ?? '' ),
			(array) ( $request->get_param( 'vars' ) ?? array() ),
			$ctx,
			$opts
		);
		return is_wp_error( $res ) ? $res : $this->ok( $res );
	}

	public function delete_playbook( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::PLAYBOOK_MANAGE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$slug = (string) ( $request->get_param( 'slug' ) ?? '' );
		Playbooks::delete( $slug );
		return $this->ok( array( 'deleted' => true, 'slug' => $slug ) );
	}
}
