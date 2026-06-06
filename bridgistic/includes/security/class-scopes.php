<?php
/**
 * Capability scopes.
 *
 * Unlike an Application Password (which grants whatever the admin user can do),
 * each Bridgistic key is minted with an explicit, least-privilege scope set.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic\Security;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Scopes {

	public const SITE_READ      = 'site:read';
	public const POSTS_READ     = 'posts:read';
	public const POSTS_WRITE    = 'posts:write';
	public const MEDIA_WRITE    = 'media:write';
	public const USERS_READ     = 'users:read';
	public const USERS_WRITE    = 'users:write';
	public const OPTIONS_READ   = 'options:read';
	public const OPTIONS_WRITE  = 'options:write';
	public const DB_READ        = 'db:read';
	public const DB_WRITE       = 'db:write';
	public const FS_READ        = 'fs:read';
	public const FS_WRITE       = 'fs:write';
	public const PLUGINS_MANAGE = 'plugins:manage';
	public const PHP_EXECUTE    = 'php:execute';
	public const SNAPSHOT       = 'snapshot:manage';
	public const MEMORY_READ    = 'memory:read';
	public const MEMORY_WRITE   = 'memory:write';
	public const PLAYBOOK_MANAGE = 'playbook:manage';
	public const SCHEDULE_MANAGE = 'schedule:manage';

	/**
	 * All scopes that exist, with human descriptions for the admin UI.
	 *
	 * @return array<string,string>
	 */
	public static function all(): array {
		return array(
			self::SITE_READ      => 'Read site metadata, plugins, theme, health',
			self::POSTS_READ     => 'Read posts, pages, custom post types',
			self::POSTS_WRITE    => 'Create / update / delete content',
			self::MEDIA_WRITE    => 'Upload and manage media',
			self::USERS_READ     => 'Read user accounts (no passwords)',
			self::USERS_WRITE    => 'Create / update users',
			self::OPTIONS_READ   => 'Read wp_options (allowlist enforced)',
			self::OPTIONS_WRITE  => 'Write wp_options (allowlist enforced)',
			self::DB_READ        => 'Run read-only SQL (SELECT / SHOW / EXPLAIN)',
			self::DB_WRITE       => 'Run write SQL (snapshot taken first)',
			self::FS_READ        => 'Read files inside ABSPATH',
			self::FS_WRITE       => 'Write non-PHP files; PHP only inside sandbox',
			self::PLUGINS_MANAGE => 'Activate / deactivate plugins',
			self::PHP_EXECUTE    => 'Execute arbitrary PHP (highest privilege)',
			self::SNAPSHOT       => 'Create / restore DB + file snapshots',
			self::MEMORY_READ    => 'Read per-site memory notes',
			self::MEMORY_WRITE   => 'Write per-site memory notes',
			self::PLAYBOOK_MANAGE => 'Save / run reusable playbooks',
			self::SCHEDULE_MANAGE => 'Schedule playbooks to run unattended',
		);
	}

	/**
	 * Convenience preset bundles for the admin UI.
	 *
	 * @return array<string,array<int,string>>
	 */
	public static function presets(): array {
		return array(
			'read_only'   => array(
				self::SITE_READ,
				self::POSTS_READ,
				self::USERS_READ,
				self::OPTIONS_READ,
				self::DB_READ,
				self::FS_READ,
			),
			'content_ops' => array(
				self::SITE_READ,
				self::POSTS_READ,
				self::POSTS_WRITE,
				self::MEDIA_WRITE,
				self::MEMORY_READ,
				self::MEMORY_WRITE,
			),
			'developer'   => array_keys(
				array_diff_key( self::all(), array( self::PHP_EXECUTE => 1 ) )
			),
			'full_trust'  => array_keys( self::all() ),
		);
	}

	/**
	 * Validate that a requested scope list contains only known scopes.
	 *
	 * @param array<int,string> $requested Requested scopes.
	 * @return array<int,string> Filtered, de-duplicated valid scopes.
	 */
	public static function sanitize( array $requested ): array {
		$valid = array_keys( self::all() );
		return array_values( array_unique( array_intersect( $requested, $valid ) ) );
	}
}
