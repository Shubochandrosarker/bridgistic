<?php
/**
 * Plugin management. Activation/deactivation snapshots the active_plugins option
 * first, so a bad toggle is one restore away.
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

final class PluginsController extends Controller {

	public function register( string $namespace ): void {
		register_rest_route(
			$namespace,
			'/plugins',
			array(
				'methods'             => 'GET',
				'callback'            => array( $this, 'list_plugins' ),
				'permission_callback' => array( $this, 'authenticate' ),
			)
		);
		register_rest_route(
			$namespace,
			'/plugins/toggle',
			array(
				'methods'             => 'POST',
				'callback'            => array( $this, 'toggle_plugin' ),
				'permission_callback' => array( $this, 'authenticate' ),
			)
		);
	}

	public function list_plugins( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::PLUGINS_MANAGE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		if ( ! function_exists( 'get_plugins' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		$active = (array) get_option( 'active_plugins', array() );
		$out    = array();
		foreach ( get_plugins() as $file => $meta ) {
			$out[] = array(
				'file'    => $file,
				'name'    => $meta['Name'],
				'version' => $meta['Version'],
				'active'  => in_array( $file, $active, true ),
			);
		}
		return $this->ok( array( 'plugins' => $out ) );
	}

	public function toggle_plugin( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::PLUGINS_MANAGE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$file   = (string) ( $request->get_param( 'plugin' ) ?? '' );
		$action = (string) ( $request->get_param( 'state' ) ?? '' ); // 'activate' | 'deactivate'
		if ( '' === $file || ! in_array( $action, array( 'activate', 'deactivate' ), true ) ) {
			return $this->fail( 'bridgistic_plugin_args', "Provide 'plugin' (file) and 'state' (activate|deactivate).", 400 );
		}

		return Guard::run(
			$request,
			array(
				'action'      => 'plugins.' . $action,
				'destructive' => true,
				'mutating'    => true,
				'force_approval' => true, // toggling plugins is high-risk; always confirm.
				'payload'     => array( 'plugin' => $file, 'state' => $action ),
				'summary'     => ucfirst( $action ) . " plugin {$file}",
				'snapshot'    => fn() => Snapshot::create( 'option', array( 'name' => 'active_plugins' ), 'pre plugin toggle', $this->key_id( $request ) ),
				'dry_run'     => static fn() => array( 'plugin' => $file, 'state' => $action ),
				'execute'     => static function () use ( $file, $action ) {
					require_once ABSPATH . 'wp-admin/includes/plugin.php';
					if ( 'activate' === $action ) {
						$res = activate_plugin( $file );
						return is_wp_error( $res ) ? $res : array( 'plugin' => $file, 'active' => true );
					}
					deactivate_plugins( $file );
					return array( 'plugin' => $file, 'active' => false );
				},
			)
		);
	}
}
