<?php
/**
 * Media library — upload (from URL or base64), list, delete.
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

final class MediaController extends Controller {

	public function register( string $namespace ): void {
		register_rest_route(
			$namespace,
			'/media',
			array(
				array(
					'methods'             => 'GET',
					'callback'            => array( $this, 'list_media' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
				array(
					'methods'             => 'POST',
					'callback'            => array( $this, 'upload_media' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
			)
		);
		register_rest_route(
			$namespace,
			'/media/(?P<id>\d+)',
			array(
				'methods'             => 'DELETE',
				'callback'            => array( $this, 'delete_media' ),
				'permission_callback' => array( $this, 'authenticate' ),
			)
		);
	}

	public function list_media( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::POSTS_READ );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$atts  = get_posts(
			array(
				'post_type'      => 'attachment',
				'post_status'    => 'inherit',
				'posts_per_page' => min( 100, max( 1, (int) ( $request->get_param( 'per_page' ) ?: 20 ) ) ),
				'paged'          => max( 1, (int) ( $request->get_param( 'page' ) ?: 1 ) ),
			)
		);
		$items = array();
		foreach ( $atts as $a ) {
			$items[] = array(
				'id'   => $a->ID,
				'title' => $a->post_title,
				'mime' => $a->post_mime_type,
				'url'  => wp_get_attachment_url( $a->ID ),
			);
		}
		return $this->ok( array( 'count' => count( $items ), 'items' => $items ) );
	}

	public function upload_media( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::MEDIA_WRITE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$url      = (string) ( $request->get_param( 'url' ) ?? '' );
		$filename = (string) ( $request->get_param( 'filename' ) ?? '' );
		$b64      = (string) ( $request->get_param( 'content_base64' ) ?? '' );

		if ( '' === $url && '' === $b64 ) {
			return $this->fail( 'bridgistic_media_args', "Provide 'url' or 'filename'+'content_base64'.", 400 );
		}

		return Guard::run(
			$request,
			array(
				'action'      => 'media.upload',
				'destructive' => false,
				'mutating'    => true,
				'payload'     => array( 'url' => $url, 'filename' => $filename ),
				'summary'     => 'Upload media ' . ( $filename ?: $url ),
				'dry_run'     => static fn() => array( 'source' => $url ?: $filename ),
				'execute'     => static function () use ( $url, $filename, $b64 ) {
					require_once ABSPATH . 'wp-admin/includes/file.php';
					require_once ABSPATH . 'wp-admin/includes/media.php';
					require_once ABSPATH . 'wp-admin/includes/image.php';

					if ( '' !== $url ) {
						$tmp = download_url( $url );
						if ( is_wp_error( $tmp ) ) {
							return $tmp;
						}
						$file = array(
							'name'     => $filename ?: basename( wp_parse_url( $url, PHP_URL_PATH ) ?: 'upload' ),
							'tmp_name' => $tmp,
						);
						$id = media_handle_sideload( $file, 0 );
						if ( is_wp_error( $id ) ) {
							@unlink( $tmp ); // phpcs:ignore
							return $id;
						}
						return array( 'id' => (int) $id, 'url' => wp_get_attachment_url( (int) $id ) );
					}

					// base64 path
					$bytes = base64_decode( $b64, true ); // phpcs:ignore
					if ( false === $bytes ) {
						return new \WP_Error( 'bridgistic_media_b64', 'Invalid base64 content.', array( 'status' => 400 ) );
					}
					$upload = wp_upload_bits( $filename ?: 'upload.bin', null, $bytes );
					if ( ! empty( $upload['error'] ) ) {
						return new \WP_Error( 'bridgistic_media_write', $upload['error'], array( 'status' => 500 ) );
					}
					$type = wp_check_filetype( $upload['file'] );
					$att  = array(
						'post_mime_type' => $type['type'] ?: 'application/octet-stream',
						'post_title'     => sanitize_file_name( $filename ?: 'upload' ),
						'post_status'    => 'inherit',
					);
					$id = wp_insert_attachment( $att, $upload['file'] );
					if ( is_wp_error( $id ) ) {
						return $id;
					}
					wp_update_attachment_metadata( $id, wp_generate_attachment_metadata( $id, $upload['file'] ) );
					return array( 'id' => (int) $id, 'url' => wp_get_attachment_url( (int) $id ) );
				},
			)
		);
	}

	public function delete_media( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::MEDIA_WRITE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$id = (int) $request['id'];
		if ( 'attachment' !== get_post_type( $id ) ) {
			return $this->fail( 'bridgistic_media_404', 'Attachment not found.', 404 );
		}
		return Guard::run(
			$request,
			array(
				'action'      => 'media.delete',
				'destructive' => true,
				'mutating'    => true,
				'payload'     => array( 'id' => $id ),
				'summary'     => "Delete attachment {$id}",
				'snapshot'    => fn() => Snapshot::create( 'post', array( 'id' => $id ), "pre-delete attachment {$id}", $this->key_id( $request ) ),
				'dry_run'     => static fn() => array( 'delete_attachment' => $id ),
				'execute'     => static function () use ( $id ) {
					$res = wp_delete_attachment( $id, true );
					return $res ? array( 'id' => $id, 'deleted' => true ) : new \WP_Error( 'bridgistic_media_del', 'Delete failed.', array( 'status' => 500 ) );
				},
			)
		);
	}
}
