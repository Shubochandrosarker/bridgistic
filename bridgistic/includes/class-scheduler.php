<?php
/**
 * Scheduled playbooks — run a saved playbook unattended on a recurrence via
 * WP-Cron. Each schedule is bound to a key; at run time the key's CURRENT
 * scopes are loaded, so revoking/scoping the key immediately affects its
 * scheduled runs. Unattended runs never auto-approve: a step that needs
 * approval pauses the run and is surfaced in the admin Schedules screen.
 *
 * Reliability: WP-Cron only fires on traffic. For true unattended operation,
 * disable WP-Cron and hit wp-cron.php from a real system cron — see README.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic;

use Bridgistic\Security\KeyStore;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Scheduler {

	public const HOOK = 'bridgistic_run_scheduled_playbook';

	/** Allowed recurrences → human label. 'once' = single event. */
	public static function recurrences(): array {
		return array(
			'once'         => 'Once',
			'bridgistic_5min' => 'Every 5 minutes',
			'bridgistic_15min' => 'Every 15 minutes',
			'bridgistic_30min' => 'Every 30 minutes',
			'hourly'       => 'Hourly',
			'twicedaily'   => 'Twice daily',
			'daily'        => 'Daily',
			'weekly'       => 'Weekly',
		);
	}

	private static function table(): string {
		global $wpdb;
		return $wpdb->prefix . 'bridgistic_schedules';
	}

	public static function install(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$table   = self::table();
		$charset = $wpdb->get_charset_collate();

		$sql = "CREATE TABLE {$table} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			schedule_id VARCHAR(40) NOT NULL,
			playbook_slug VARCHAR(96) NOT NULL,
			recurrence VARCHAR(20) NOT NULL DEFAULT 'daily',
			vars LONGTEXT NULL,
			options LONGTEXT NULL,
			key_id VARCHAR(40) NOT NULL DEFAULT '',
			enabled TINYINT(1) NOT NULL DEFAULT 1,
			next_run DATETIME NULL,
			last_run DATETIME NULL,
			last_status VARCHAR(24) NULL,
			last_result LONGTEXT NULL,
			created_at DATETIME NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY schedule_id (schedule_id),
			KEY enabled (enabled)
		) {$charset};";

		dbDelta( $sql );
	}

	/** Register cron interval(s) + the run hook. Called on every load. */
	public static function boot(): void {
		add_filter( 'cron_schedules', array( __CLASS__, 'add_intervals' ) ); // phpcs:ignore WordPress.WP.CronInterval
		add_action( self::HOOK, array( __CLASS__, 'run_due' ), 10, 1 );
	}

	/**
	 * @param array<string,array{interval:int,display:string}> $schedules Existing schedules.
	 * @return array<string,array{interval:int,display:string}>
	 */
	public static function add_intervals( array $schedules ): array {
		$schedules['bridgistic_5min']  = array( 'interval' => 5 * MINUTE_IN_SECONDS,  'display' => 'Bridgistic: every 5 minutes' );
		$schedules['bridgistic_15min'] = array( 'interval' => 15 * MINUTE_IN_SECONDS, 'display' => 'Bridgistic: every 15 minutes' );
		$schedules['bridgistic_30min'] = array( 'interval' => 30 * MINUTE_IN_SECONDS, 'display' => 'Bridgistic: every 30 minutes' );
		return $schedules;
	}

	/**
	 * Create a schedule + register the WP-Cron event.
	 *
	 * @param array<string,mixed> $vars    Playbook run vars.
	 * @param array<string,mixed> $options dry_run / force.
	 * @return array<string,mixed>|\WP_Error
	 */
	public static function create( string $playbook_slug, string $recurrence, array $vars, array $options, string $key_id, ?int $start_at = null ) {
		if ( ! array_key_exists( $recurrence, self::recurrences() ) ) {
			return new \WP_Error( 'bridgistic_sched_recurrence', 'Invalid recurrence.', array( 'status' => 400 ) );
		}
		if ( ! Playbooks::get( $playbook_slug ) ) {
			return new \WP_Error( 'bridgistic_sched_playbook', "Playbook '{$playbook_slug}' not found.", array( 'status' => 404 ) );
		}

		$id        = 'sch_' . bin2hex( random_bytes( 10 ) );
		$timestamp = $start_at && $start_at > time() ? $start_at : time() + MINUTE_IN_SECONDS;

		$scheduled = ( 'once' === $recurrence )
			? wp_schedule_single_event( $timestamp, self::HOOK, array( $id ), true )
			: wp_schedule_event( $timestamp, $recurrence, self::HOOK, array( $id ), true );

		if ( is_wp_error( $scheduled ) || false === $scheduled ) {
			return new \WP_Error( 'bridgistic_sched_cron', 'WordPress could not register the cron event.', array( 'status' => 500 ) );
		}

		global $wpdb;
		$wpdb->insert( // phpcs:ignore WordPress.DB
			self::table(),
			array(
				'schedule_id'   => $id,
				'playbook_slug' => $playbook_slug,
				'recurrence'    => $recurrence,
				'vars'          => (string) wp_json_encode( $vars ),
				'options'       => (string) wp_json_encode( $options ),
				'key_id'        => $key_id,
				'enabled'       => 1,
				'next_run'      => gmdate( 'Y-m-d H:i:s', $timestamp ),
				'created_at'    => current_time( 'mysql', true ),
			),
			array( '%s', '%s', '%s', '%s', '%s', '%s', '%d', '%s', '%s' )
		);

		return array(
			'schedule_id' => $id,
			'playbook'    => $playbook_slug,
			'recurrence'  => $recurrence,
			'next_run'    => gmdate( 'c', $timestamp ),
		);
	}

	/**
	 * @return array<string,mixed>|null
	 */
	public static function get( string $schedule_id ): ?array {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM ' . self::table() . ' WHERE schedule_id = %s', $schedule_id ), ARRAY_A ); // phpcs:ignore WordPress.DB
		return $row ?: null;
	}

	/** @return array<int,array<string,mixed>> */
	public static function list(): array {
		global $wpdb;
		$rows = $wpdb->get_results( 'SELECT * FROM ' . self::table() . ' ORDER BY id DESC', ARRAY_A ); // phpcs:ignore WordPress.DB
		foreach ( (array) $rows as &$r ) {
			$ts             = wp_next_scheduled( self::HOOK, array( $r['schedule_id'] ) );
			$r['next_run']  = $ts ? gmdate( 'Y-m-d H:i:s', $ts ) : $r['next_run'];
			unset( $r['last_result'] ); // keep the list light.
		}
		return is_array( $rows ) ? $rows : array();
	}

	public static function toggle( string $schedule_id, bool $enabled ): bool {
		$row = self::get( $schedule_id );
		if ( ! $row ) {
			return false;
		}
		global $wpdb;
		$wpdb->update( self::table(), array( 'enabled' => $enabled ? 1 : 0 ), array( 'schedule_id' => $schedule_id ), array( '%d' ), array( '%s' ) ); // phpcs:ignore WordPress.DB

		if ( $enabled ) {
			if ( 'once' !== $row['recurrence'] && ! wp_next_scheduled( self::HOOK, array( $schedule_id ) ) ) {
				wp_schedule_event( time() + MINUTE_IN_SECONDS, $row['recurrence'], self::HOOK, array( $schedule_id ) );
			}
		} else {
			wp_clear_scheduled_hook( self::HOOK, array( $schedule_id ) );
		}
		return true;
	}

	public static function delete( string $schedule_id ): void {
		wp_clear_scheduled_hook( self::HOOK, array( $schedule_id ) );
		global $wpdb;
		$wpdb->delete( self::table(), array( 'schedule_id' => $schedule_id ), array( '%s' ) ); // phpcs:ignore WordPress.DB
	}

	/**
	 * Cron callback: execute one schedule's playbook.
	 *
	 * @param string $schedule_id Public schedule id (passed as the cron arg).
	 */
	public static function run_due( string $schedule_id ): void {
		$row = self::get( $schedule_id );
		if ( ! $row || (int) $row['enabled'] !== 1 ) {
			return;
		}
		self::execute( $row );
	}

	/**
	 * Run a schedule now (also used by the admin "Run now" button).
	 *
	 * @param array<string,mixed> $row Schedule row.
	 * @return array<string,mixed>
	 */
	public static function execute( array $row ): array {
		$key = KeyStore::get( (string) $row['key_id'] );
		if ( ! $key || (int) ( $key['enabled'] ?? 0 ) !== 1 ) {
			return self::record( $row['schedule_id'], 'error', array( 'error' => 'Bound key is missing or disabled.' ) );
		}

		$ctx = array(
			'key_id'        => (string) $row['key_id'],
			'scopes'        => (array) ( $key['scopes'] ?? array() ),
			'rate_limit'    => (int) ( $key['rate_limit'] ?? 120 ),
			'monthly_quota' => (int) ( $key['monthly_quota'] ?? 0 ),
			'tier'          => (string) ( $key['tier'] ?? 'custom' ),
		);

		// Meter the run for billing; respect monthly quota (no per-minute throttle for cron).
		$metered = Usage::meter_scheduled( $ctx );
		if ( is_wp_error( $metered ) ) {
			return self::record( $row['schedule_id'], 'quota_exceeded', array( 'error' => $metered->get_error_message() ) );
		}

		$vars = json_decode( (string) $row['vars'], true ) ?: array();
		$opts = json_decode( (string) $row['options'], true ) ?: array();

		$result = Playbooks::run( (string) $row['playbook_slug'], $vars, $ctx, $opts );
		if ( is_wp_error( $result ) ) {
			return self::record( $row['schedule_id'], 'error', array( 'error' => $result->get_error_message() ) );
		}

		$status = (string) ( $result['status'] ?? 'ok' );
		// Single-run schedules disable themselves after firing.
		if ( 'once' === $row['recurrence'] ) {
			global $wpdb;
			$wpdb->update( self::table(), array( 'enabled' => 0 ), array( 'schedule_id' => $row['schedule_id'] ), array( '%d' ), array( '%s' ) ); // phpcs:ignore WordPress.DB
		}
		return self::record( (string) $row['schedule_id'], $status, $result );
	}

	/**
	 * @param array<string,mixed> $result Run result.
	 * @return array<string,mixed>
	 */
	private static function record( string $schedule_id, string $status, array $result ): array {
		global $wpdb;
		$wpdb->update( // phpcs:ignore WordPress.DB
			self::table(),
			array(
				'last_run'    => current_time( 'mysql', true ),
				'last_status' => mb_substr( $status, 0, 24 ),
				'last_result' => mb_substr( (string) wp_json_encode( $result ), 0, 20000 ),
			),
			array( 'schedule_id' => $schedule_id ),
			array( '%s', '%s', '%s' ),
			array( '%s' )
		);
		AuditLog::record( '', 'schedule.run', $status, array( 'schedule_id' => $schedule_id ) );
		return array( 'schedule_id' => $schedule_id, 'status' => $status, 'result' => $result );
	}
}
