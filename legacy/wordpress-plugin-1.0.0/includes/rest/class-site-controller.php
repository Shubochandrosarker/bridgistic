<?php
/**
 * Site discovery endpoint. Lets the agent understand the stack before acting,
 * without arbitrary PHP — usable by read-only keys.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic\Rest;

use Bridgistic\Security\Scopes;
use Bridgistic\AuditLog;
use WP_REST_Request;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class SiteController extends Controller {

	public function register( string $namespace ): void {
		register_rest_route(
			$namespace,
			'/site-info',
			array(
				'methods'             => 'GET',
				'callback'            => array( $this, 'site_info' ),
				'permission_callback' => array( $this, 'authenticate' ),
			)
		);
	}

	public function site_info( WP_REST_Request $request ) {
		$scope = $this->require_scope( $request, Scopes::SITE_READ );
		if ( is_wp_error( $scope ) ) {
			return $scope;
		}

		if ( ! function_exists( 'get_plugins' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}

		$active  = (array) get_option( 'active_plugins', array() );
		$plugins = array();
		foreach ( get_plugins() as $file => $meta ) {
			$plugins[] = array(
				'file'    => $file,
				'name'    => $meta['Name'],
				'version' => $meta['Version'],
				'active'  => in_array( $file, $active, true ),
			);
		}

		$theme = wp_get_theme();

		$data = array(
			'site'    => array(
				'name'        => get_bloginfo( 'name' ),
				'url'         => home_url(),
				'wp_version'  => get_bloginfo( 'version' ),
				'php_version' => PHP_VERSION,
				'is_multisite' => is_multisite(),
				'language'    => get_locale(),
			),
			'theme'   => array(
				'name'     => $theme->get( 'Name' ),
				'version'  => $theme->get( 'Version' ),
				'template' => $theme->get_template(),
			),
			'plugins' => $plugins,
			'detected' => array(
				'woocommerce' => class_exists( 'WooCommerce' ),
				'elementor'   => defined( 'ELEMENTOR_VERSION' ),
				'acf'         => class_exists( 'ACF' ),
			),
			'bridge'  => array(
				'version' => BRIDGISTIC_VERSION,
				'scopes'  => ( (array) $request->get_param( '__ctx' ) )['scopes'] ?? array(),
			),
		);

		AuditLog::record( $this->key_id( $request ), 'site-info', 'ok' );

		return $this->ok( $data );
	}
}
