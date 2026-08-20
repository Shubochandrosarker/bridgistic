<?php
/**
 * User management. Passwords are never read back. Updates snapshot the user first.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic\Rest;

use Bridgistic\Security\Scopes;
use Bridgistic\Snapshot;
use Bridgistic\Guard;
use WP_REST_Request;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class UsersController extends Controller {

	public function register( string $namespace ): void {
		register_rest_route(
			$namespace,
			'/users',
			array(
				array(
					'methods'             => 'GET',
					'callback'            => array( $this, 'list_users' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
				array(
					'methods'             => 'POST',
					'callback'            => array( $this, 'create_user' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
			)
		);
		register_rest_route(
			$namespace,
			'/users/(?P<id>\d+)',
			array(
				array(
					'methods'             => 'GET',
					'callback'            => array( $this, 'get_user_item' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
				array(
					'methods'             => 'POST',
					'callback'            => array( $this, 'update_user_item' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
			)
		);
	}

	public function list_users( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::USERS_READ );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$users = get_users(
			array(
				'number'  => min( 100, max( 1, (int) ( $request->get_param( 'per_page' ) ?: 20 ) ) ),
				'paged'   => max( 1, (int) ( $request->get_param( 'page' ) ?: 1 ) ),
				'search'  => $request->get_param( 'search' ) ? '*' . $request->get_param( 'search' ) . '*' : '',
				'fields'  => array( 'ID', 'user_login', 'user_email', 'display_name', 'user_registered' ),
			)
		);
		$items = array();
		foreach ( $users as $u ) {
			$wp_user = get_userdata( (int) $u->ID );
			$items[] = array(
				'id'           => (int) $u->ID,
				'login'        => $u->user_login,
				'email'        => $u->user_email,
				'display_name' => $u->display_name,
				'roles'        => $wp_user ? $wp_user->roles : array(),
				'registered'   => $u->user_registered,
			);
		}
		return $this->ok( array( 'count' => count( $items ), 'items' => $items ) );
	}

	public function get_user_item( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::USERS_READ );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$u = get_userdata( (int) $request['id'] );
		if ( ! $u ) {
			return $this->fail( 'bridgistic_user_404', 'User not found.', 404 );
		}
		return $this->ok(
			array(
				'id'           => $u->ID,
				'login'        => $u->user_login,
				'email'        => $u->user_email,
				'display_name' => $u->display_name,
				'roles'        => $u->roles,
				'registered'   => $u->user_registered,
			)
		);
	}

	public function create_user( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::USERS_WRITE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$login = (string) ( $request->get_param( 'login' ) ?? '' );
		$email = (string) ( $request->get_param( 'email' ) ?? '' );
		$role  = (string) ( $request->get_param( 'role' ) ?? 'subscriber' );
		if ( '' === $login || '' === $email ) {
			return $this->fail( 'bridgistic_user_args', "Provide 'login' and 'email'.", 400 );
		}

		return Guard::run(
			$request,
			array(
				'action'      => 'users.create',
				'destructive' => false,
				'mutating'    => true,
				'payload'     => array( 'login' => $login, 'email' => $email, 'role' => $role ),
				'summary'     => "Create user {$login} ({$role})",
				'dry_run'     => static fn() => array( 'login' => $login, 'email' => $email, 'role' => $role ),
				'execute'     => static function () use ( $login, $email, $role, $request ) {
					$pass = $request->get_param( 'password' ) ?: wp_generate_password( 20, true, true );
					$id   = wp_insert_user(
						array(
							'user_login' => $login,
							'user_email' => $email,
							'user_pass'  => $pass,
							'role'       => $role,
							'display_name' => $request->get_param( 'display_name' ) ?: $login,
						)
					);
					return is_wp_error( $id ) ? $id : array( 'id' => (int) $id );
				},
			)
		);
	}

	public function update_user_item( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::USERS_WRITE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$id = (int) $request['id'];
		if ( ! get_userdata( $id ) ) {
			return $this->fail( 'bridgistic_user_404', 'User not found.', 404 );
		}

		$fields       = array( 'ID' => $id );
		foreach ( array( 'email' => 'user_email', 'display_name' => 'display_name', 'role' => 'role' ) as $in => $wp ) {
			$v = $request->get_param( $in );
			if ( null !== $v ) {
				$fields[ $wp ] = $v;
			}
		}

		return Guard::run(
			$request,
			array(
				'action'      => 'users.update',
				'destructive' => true,
				'mutating'    => true,
				'payload'     => $fields,
				'summary'     => "Update user {$id}",
				'snapshot'    => fn() => Snapshot::create( 'user', array( 'id' => $id ), "pre-update user {$id}", $this->key_id( $request ) ),
				'dry_run'     => static fn() => array( 'update' => $fields ),
				'execute'     => static function () use ( $fields ) {
					$res = wp_update_user( $fields );
					return is_wp_error( $res ) ? $res : array( 'id' => (int) $res );
				},
			)
		);
	}
}
