<?php
/**
 * Posts / pages / CPT CRUD. Writes flow through Guard (dry-run, approval, snapshot).
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic\Rest;

use Bridgistic\Security\Scopes;
use Bridgistic\Snapshot;
use Bridgistic\Guard;
use WP_REST_Request;
use WP_Query;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class PostsController extends Controller {

	public function register( string $namespace ): void {
		register_rest_route(
			$namespace,
			'/posts',
			array(
				array(
					'methods'             => 'GET',
					'callback'            => array( $this, 'list_posts' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
				array(
					'methods'             => 'POST',
					'callback'            => array( $this, 'create_post' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
			)
		);

		register_rest_route(
			$namespace,
			'/posts/(?P<id>\d+)',
			array(
				array(
					'methods'             => 'GET',
					'callback'            => array( $this, 'get_post_item' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
				array(
					'methods'             => 'POST',
					'callback'            => array( $this, 'update_post_item' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
				array(
					'methods'             => 'DELETE',
					'callback'            => array( $this, 'delete_post_item' ),
					'permission_callback' => array( $this, 'authenticate' ),
				),
			)
		);
	}

	public function list_posts( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::POSTS_READ );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}

		$q = new WP_Query(
			array(
				'post_type'      => $request->get_param( 'post_type' ) ?: 'post',
				'post_status'    => $request->get_param( 'status' ) ?: 'any',
				's'              => (string) ( $request->get_param( 'search' ) ?? '' ),
				'posts_per_page' => min( 100, max( 1, (int) ( $request->get_param( 'per_page' ) ?: 20 ) ) ),
				'paged'          => max( 1, (int) ( $request->get_param( 'page' ) ?: 1 ) ),
			)
		);

		$items = array();
		foreach ( $q->posts as $p ) {
			$items[] = array(
				'id'     => $p->ID,
				'title'  => get_the_title( $p ),
				'type'   => $p->post_type,
				'status' => $p->post_status,
				'slug'   => $p->post_name,
				'date'   => $p->post_date_gmt,
				'link'   => get_permalink( $p ),
			);
		}

		return $this->ok(
			array(
				'total'     => (int) $q->found_posts,
				'count'     => count( $items ),
				'page'      => max( 1, (int) ( $request->get_param( 'page' ) ?: 1 ) ),
				'has_more'  => $q->max_num_pages > max( 1, (int) ( $request->get_param( 'page' ) ?: 1 ) ),
				'items'     => $items,
			)
		);
	}

	public function get_post_item( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::POSTS_READ );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$id   = (int) $request['id'];
		$post = get_post( $id );
		if ( ! $post ) {
			return $this->fail( 'bridgistic_post_404', "Post {$id} not found.", 404 );
		}
		return $this->ok(
			array(
				'id'      => $post->ID,
				'title'   => $post->post_title,
				'content' => $post->post_content,
				'excerpt' => $post->post_excerpt,
				'type'    => $post->post_type,
				'status'  => $post->post_status,
				'slug'    => $post->post_name,
				'author'  => (int) $post->post_author,
				'meta'    => get_post_meta( $id ),
			)
		);
	}

	public function create_post( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::POSTS_WRITE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}

		$fields = $this->collect_fields( $request );

		return Guard::run(
			$request,
			array(
				'action'      => 'posts.create',
				'destructive' => false, // nothing to snapshot — it's new.
				'mutating'    => true,
				'payload'     => $fields,
				'summary'     => 'Create ' . ( $fields['post_type'] ?? 'post' ) . ': ' . ( $fields['post_title'] ?? '(untitled)' ),
				'dry_run'     => static fn() => array( 'create' => $fields ),
				'execute'     => function () use ( $fields, $request ) {
					$id = wp_insert_post( wp_slash( $fields ), true );
					if ( is_wp_error( $id ) ) {
						return $id;
					}
					$this->apply_meta( (int) $id, $request );
					return array( 'id' => (int) $id, 'link' => get_permalink( (int) $id ) );
				},
			)
		);
	}

	public function update_post_item( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::POSTS_WRITE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$id = (int) $request['id'];
		if ( ! get_post( $id ) ) {
			return $this->fail( 'bridgistic_post_404', "Post {$id} not found.", 404 );
		}

		$fields       = $this->collect_fields( $request );
		$fields['ID'] = $id;

		return Guard::run(
			$request,
			array(
				'action'      => 'posts.update',
				'destructive' => true,
				'mutating'    => true,
				'payload'     => $fields,
				'summary'     => "Update post {$id}",
				'snapshot'    => fn() => Snapshot::create( 'post', array( 'id' => $id ), "pre-update post {$id}", $this->key_id( $request ) ),
				'dry_run'     => static fn() => array( 'update' => $fields ),
				'execute'     => function () use ( $fields, $id, $request ) {
					$res = wp_update_post( wp_slash( $fields ), true );
					if ( is_wp_error( $res ) ) {
						return $res;
					}
					$this->apply_meta( $id, $request );
					return array( 'id' => $id );
				},
			)
		);
	}

	public function delete_post_item( WP_REST_Request $request ) {
		$gate = $this->require_scope( $request, Scopes::POSTS_WRITE );
		if ( is_wp_error( $gate ) ) {
			return $gate;
		}
		$id = (int) $request['id'];
		if ( ! get_post( $id ) ) {
			return $this->fail( 'bridgistic_post_404', "Post {$id} not found.", 404 );
		}
		$force = $this->truthy( $request->get_param( 'permanent' ) );

		return Guard::run(
			$request,
			array(
				'action'      => 'posts.delete',
				'destructive' => true,
				'mutating'    => true,
				'payload'     => array( 'id' => $id, 'permanent' => $force ),
				'summary'     => ( $force ? 'Permanently delete' : 'Trash' ) . " post {$id}",
				'snapshot'    => fn() => Snapshot::create( 'post', array( 'id' => $id ), "pre-delete post {$id}", $this->key_id( $request ) ),
				'dry_run'     => static fn() => array( 'delete' => $id, 'permanent' => $force ),
				'execute'     => static function () use ( $id, $force ) {
					$res = wp_delete_post( $id, $force );
					return $res ? array( 'id' => $id, 'deleted' => true ) : new \WP_Error( 'bridgistic_delete_failed', 'Delete failed.', array( 'status' => 500 ) );
				},
			)
		);
	}

	/**
	 * @return array<string,mixed>
	 */
	private function collect_fields( WP_REST_Request $request ): array {
		$map    = array(
			'title'   => 'post_title',
			'content' => 'post_content',
			'excerpt' => 'post_excerpt',
			'status'  => 'post_status',
			'slug'    => 'post_name',
			'type'    => 'post_type',
			'author'  => 'post_author',
			'parent'  => 'post_parent',
		);
		$fields = array();
		foreach ( $map as $in => $wp ) {
			$val = $request->get_param( $in );
			if ( null !== $val ) {
				$fields[ $wp ] = $val;
			}
		}
		return $fields;
	}

	private function apply_meta( int $id, WP_REST_Request $request ): void {
		$meta = $request->get_param( 'meta' );
		if ( is_array( $meta ) ) {
			foreach ( $meta as $k => $v ) {
				update_post_meta( $id, sanitize_key( (string) $k ), $v );
			}
		}
	}

	private function truthy( $v ): bool {
		return true === $v || '1' === $v || 1 === $v || 'true' === $v;
	}
}
