<?php
/**
 * Per-site memory endpoints.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic\Rest;

use Bridgistic\Security\Scopes;
use Bridgistic\Memory;
use WP_REST_Request;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class MemoryController extends Controller {

	public function register( string $namespace ): void {
		register_rest_route(
			$namespace,
			'/memory',
			array(
				array(
					'methods'             => 'GET',
					'callback'            => array( $this, 'read' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
				array(
					'methods'             => 'POST',
					'callback'            => array( $this, 'write' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
			)
		);
		register_rest_route(
			$namespace,
			'/memory/delete',
			array(
				'methods'             => 'POST',
				'callback'            => array( $this, 'remove' ),
				'permission_callback' => array( $this, 'authenticate' ),
			)
		);
	}

	public function read( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::MEMORY_READ );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$category = (string) ( $request->get_param( 'category' ) ?? '' );
		$key      = (string) ( $request->get_param( 'key' ) ?? '' );

		if ( '' !== $key ) {
			$item = Memory::get( $category ?: 'general', $key );
			return $item ? $this->ok( $item ) : $this->fail( 'bridgistic_mem_404', 'No memory under that key.', 404 );
		}
		return $this->ok( array( 'items' => Memory::list( $category ) ) );
	}

	public function write( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::MEMORY_WRITE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$key = (string) ( $request->get_param( 'key' ) ?? '' );
		if ( '' === $key ) {
			return $this->fail( 'bridgistic_mem_args', "Provide 'key' (and optional 'category', 'value').", 400 );
		}
		return $this->ok(
			Memory::set(
				(string) ( $request->get_param( 'category' ) ?? 'general' ),
				$key,
				$request->get_param( 'value' ),
				$this->key_id( $request )
			)
		);
	}

	public function remove( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::MEMORY_WRITE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$key = (string) ( $request->get_param( 'key' ) ?? '' );
		Memory::delete( (string) ( $request->get_param( 'category' ) ?? 'general' ), $key );
		return $this->ok( array( 'deleted' => true, 'key' => $key ) );
	}
}
