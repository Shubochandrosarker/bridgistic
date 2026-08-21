<?php
/**
 * wp_options access — strictly allowlisted on BOTH read and write, so a key can
 * never read secrets (e.g. api credentials) or brick the site via siteurl.
 *
 * Allowlist source: option 'bridgistic_options_allowlist' (array of names, '*' wildcards
 * allowed at the end) merged with the 'bridgistic_options_allowlist' filter.
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

final class OptionsController extends Controller {

	private const DEFAULT_ALLOWLIST = array(
		'blogname',
		'blogdescription',
		'date_format',
		'time_format',
		'start_of_week',
		'posts_per_page',
		'show_on_front',
		'page_on_front',
		'page_for_posts',
		'default_comment_status',
		'timezone_string',
	);

	public function register( string $namespace ): void {
		register_rest_route(
			$namespace,
			'/options',
			array(
				array(
					'methods'             => 'GET',
					'callback'            => array( $this, 'get_option_item' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
				array(
					'methods'             => 'POST',
					'callback'            => array( $this, 'update_option_item' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
			)
		);
	}

	public function get_option_item( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::OPTIONS_READ );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$name = (string) ( $request->get_param( 'name' ) ?? '' );
		if ( ! self::allowed( $name ) ) {
			return $this->fail( 'bridgistic_option_denied', "Option '{$name}' is not in the allowlist.", 403 );
		}
		return $this->ok(
			array(
				'name'   => $name,
				'value'  => get_option( $name ),
				'exists' => false !== get_option( $name, false ),
			)
		);
	}

	public function update_option_item( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::OPTIONS_WRITE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$name = (string) ( $request->get_param( 'name' ) ?? '' );
		if ( ! self::allowed( $name ) ) {
			return $this->fail( 'bridgistic_option_denied', "Option '{$name}' is not in the allowlist.", 403 );
		}
		$value = $request->get_param( 'value' );

		return Guard::run(
			$request,
			array(
				'action'      => 'options.update',
				'destructive' => true,
				'mutating'    => true,
				'payload'     => array( 'name' => $name, 'value' => $value ),
				'summary'     => "Update option {$name}",
				'snapshot'    => fn() => Snapshot::create( 'option', array( 'name' => $name ), "pre-update {$name}", $this->key_id( $request ) ),
				'dry_run'     => fn() => array(
					'option'  => $name,
					'from'    => get_option( $name ),
					'to'      => $value,
				),
				'execute'     => static function () use ( $name, $value ) {
					update_option( $name, $value );
					return array( 'name' => $name, 'updated' => true );
				},
			)
		);
	}

	/** Is an option name permitted? Supports trailing '*' wildcards. */
	public static function allowed( string $name ): bool {
		if ( '' === $name ) {
			return false;
		}
		$stored = (array) get_option( 'bridgistic_options_allowlist', self::DEFAULT_ALLOWLIST );
		/** Filter the effective allowlist. @param array $stored */
		$list = (array) apply_filters( 'bridgistic_options_allowlist', $stored );
		foreach ( $list as $pattern ) {
			$pattern = (string) $pattern;
			if ( $pattern === $name ) {
				return true;
			}
			if ( str_ends_with( $pattern, '*' ) && str_starts_with( $name, rtrim( $pattern, '*' ) ) ) {
				return true;
			}
		}
		return false;
	}
}
