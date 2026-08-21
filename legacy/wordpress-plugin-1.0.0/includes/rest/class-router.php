<?php
/**
 * Registers every REST controller under the bridge namespace.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic\Rest;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Router {

	public function register_routes(): void {
		$ns = BRIDGISTIC_REST_NAMESPACE;

		// Core / discovery.
		( new SiteController() )->register( $ns );
		( new ExecuteController() )->register( $ns );

		// Structured tools.
		( new PostsController() )->register( $ns );
		( new MediaController() )->register( $ns );
		( new UsersController() )->register( $ns );
		( new OptionsController() )->register( $ns );
		( new PluginsController() )->register( $ns );
		( new FsController() )->register( $ns );

		// Safety layer.
		( new SnapshotController() )->register( $ns );
		( new ApprovalsController() )->register( $ns );

		// Metering + intelligence layer.
		( new UsageController() )->register( $ns );
		( new MemoryController() )->register( $ns );
		( new PlaybookController() )->register( $ns );
		( new ScheduleController() )->register( $ns );
	}
}
