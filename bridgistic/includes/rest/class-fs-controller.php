<?php
/**
 * Filesystem access, confined to ABSPATH.
 *
 * Hard rule (mirrors the sandbox model, enforced server-side):
 * executable PHP can only be WRITTEN inside wp-content/uploads/bridgistic-sandbox/.
 * Non-PHP files may be written anywhere under ABSPATH. Reads/lists are ABSPATH-wide.
 * Writes and deletes snapshot the file first.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic\Rest;

use Bridgistic\Security\Scopes;
use Bridgistic\Snapshot;
use Bridgistic\Guard;
use Bridgistic\Plugin;
use WP_REST_Request;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class FsController extends Controller {

	public function register( string $namespace ): void {
		foreach ( array( 'list', 'read', 'write', 'delete' ) as $op ) {
			register_rest_route(
				$namespace,
				"/fs/{$op}",
				array(
					'methods'             => 'POST',
					'callback'            => array( $this, $op ),
					'permission_callback' => array( $this, 'authenticate' ),
				)
			);
		}
	}

	public function list( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::FS_READ );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$path = $this->confine( (string) ( $request->get_param( 'path' ) ?? ABSPATH ), true );
		if ( ! $path || ! is_dir( $path ) ) {
			return $this->fail( 'bridgistic_fs_dir', 'Not a directory inside ABSPATH.', 400 );
		}
		$entries = array();
		foreach ( (array) scandir( $path ) as $e ) {
			if ( '.' === $e || '..' === $e ) {
				continue;
			}
			$full      = trailingslashit( $path ) . $e;
			$entries[] = array(
				'name'  => $e,
				'type'  => is_dir( $full ) ? 'dir' : 'file',
				'size'  => is_file( $full ) ? filesize( $full ) : null,
			);
		}
		return $this->ok( array( 'path' => $path, 'entries' => $entries ) );
	}

	public function read( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::FS_READ );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$path = $this->confine( (string) ( $request->get_param( 'path' ) ?? '' ), true );
		if ( ! $path || ! is_file( $path ) ) {
			return $this->fail( 'bridgistic_fs_404', 'File not found inside ABSPATH.', 404 );
		}
		if ( filesize( $path ) > 5 * MB_IN_BYTES ) {
			return $this->fail( 'bridgistic_fs_big', 'File too large to read (>5MB).', 413 );
		}
		return $this->ok( array( 'path' => $path, 'content' => (string) file_get_contents( $path ) ) ); // phpcs:ignore
	}

	public function write( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::FS_WRITE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$raw     = (string) ( $request->get_param( 'path' ) ?? '' );
		$content = (string) ( $request->get_param( 'content' ) ?? '' );
		$path    = $this->confine( $raw, false );
		if ( ! $path ) {
			return $this->fail( 'bridgistic_fs_path', 'Path is outside ABSPATH.', 400 );
		}
		// Execution guard. Block not only PHP but any file that can turn other
		// files into executable PHP (.htaccess / .user.ini / php.ini / web.config).
		// Otherwise fs:write silently escalates to arbitrary code execution.
		if ( ( $this->is_php( $path ) || $this->is_exec_control( $path ) ) && ! $this->in_sandbox( $path ) ) {
			return $this->fail(
				'bridgistic_fs_sandbox',
				'PHP and execution-control files (.htaccess, .user.ini, php.ini, web.config) can only be written inside wp-content/uploads/' . BRIDGISTIC_SANDBOX . '/.',
				403
			);
		}

		return Guard::run(
			$request,
			array(
				'action'      => 'fs.write',
				'destructive' => file_exists( $path ), // only destructive if overwriting.
				'mutating'    => true,
				'payload'     => array( 'path' => $path, 'bytes' => strlen( $content ) ),
				'summary'     => 'Write ' . $path,
				'snapshot'    => fn() => Snapshot::create( 'file', array( 'path' => $path ), 'pre-write ' . basename( $path ), $this->key_id( $request ) ),
				'dry_run'     => static fn() => array( 'write' => $path, 'bytes' => strlen( $content ), 'exists' => file_exists( $path ) ),
				'execute'     => static function () use ( $path, $content ) {
					if ( ! is_dir( dirname( $path ) ) ) {
						wp_mkdir_p( dirname( $path ) );
					}
					$ok = file_put_contents( $path, $content ); // phpcs:ignore
					return false === $ok ? new \WP_Error( 'bridgistic_fs_write', 'Write failed.', array( 'status' => 500 ) ) : array( 'path' => $path, 'bytes' => (int) $ok );
				},
			)
		);
	}

	public function delete( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::FS_WRITE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$path = $this->confine( (string) ( $request->get_param( 'path' ) ?? '' ), true );
		if ( ! $path || ! is_file( $path ) ) {
			return $this->fail( 'bridgistic_fs_404', 'File not found inside ABSPATH.', 404 );
		}

		return Guard::run(
			$request,
			array(
				'action'      => 'fs.delete',
				'destructive' => true,
				'mutating'    => true,
				'force_approval' => true, // deleting files is high-risk.
				'payload'     => array( 'path' => $path ),
				'summary'     => 'Delete ' . $path,
				'snapshot'    => fn() => Snapshot::create( 'file', array( 'path' => $path ), 'pre-delete ' . basename( $path ), $this->key_id( $request ) ),
				'dry_run'     => static fn() => array( 'delete' => $path ),
				'execute'     => static function () use ( $path ) {
					return wp_delete_file( $path ) || ! file_exists( $path )
						? array( 'path' => $path, 'deleted' => true )
						: new \WP_Error( 'bridgistic_fs_del', 'Delete failed.', array( 'status' => 500 ) );
				},
			)
		);
	}

	/**
	 * Confine a path to ABSPATH. $must_exist=false allows new-file paths whose
	 * parent dir is inside ABSPATH.
	 */
	private function confine( string $path, bool $must_exist ): string {
		$base = realpath( ABSPATH );
		if ( false === $base ) {
			return '';
		}
		$real = realpath( $path );
		if ( false === $real ) {
			if ( $must_exist ) {
				return '';
			}
			$parent = realpath( dirname( $path ) );
			if ( false === $parent || strpos( $parent, $base ) !== 0 ) {
				return '';
			}
			return trailingslashit( $parent ) . basename( $path );
		}
		return strpos( $real, $base ) === 0 ? $real : '';
	}

	private function is_php( string $path ): bool {
		return (bool) preg_match( '/\.(php|php\d|phtml|phps|phar)$/i', $path );
	}

	/**
	 * Files that can re-configure the web server to execute otherwise-inert
	 * files as PHP (Apache/LiteSpeed/IIS). Writing these anywhere in the docroot
	 * is a sandbox escape, so they are treated like PHP.
	 */
	private function is_exec_control( string $path ): bool {
		$base = strtolower( basename( $path ) );
		if ( in_array( $base, array( '.htaccess', '.htpasswd', '.user.ini', 'php.ini', 'web.config' ), true ) ) {
			return true;
		}
		// Any Apache .ht* control file.
		return strpos( $base, '.ht' ) === 0;
	}

	private function in_sandbox( string $path ): bool {
		$sandbox = realpath( Plugin::ensure_sandbox() );
		return $sandbox && strpos( $path, $sandbox ) === 0;
	}
}
