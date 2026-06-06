<?php
/**
 * Admin UI: Bridgistic → Connect.
 * Mint scoped keys, copy a ready-made MCP connection block, review the audit log.
 *
 * @package Bridgistic
 */

declare( strict_types=1 );

namespace Bridgistic;

use Bridgistic\Security\KeyStore;
use Bridgistic\Security\Scopes;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Admin {

	public function hooks(): void {
		add_action( 'admin_menu', array( $this, 'menu' ) );
		add_action( 'admin_post_bridgistic_create_key', array( $this, 'handle_create_key' ) );
		add_action( 'admin_post_bridgistic_revoke_key', array( $this, 'handle_revoke_key' ) );
		add_action( 'admin_post_bridgistic_decide_approval', array( $this, 'handle_decide_approval' ) );
		add_action( 'admin_post_bridgistic_save_allowlist', array( $this, 'handle_save_allowlist' ) );
		add_action( 'admin_post_bridgistic_schedule_action', array( $this, 'handle_schedule_action' ) );
	}

	public function menu(): void {
		add_menu_page(
			'Bridgistic',
			'Bridgistic',
			'manage_options',
			'bridgistic',
			array( $this, 'render' ),
			'dashicons-rest-api',
			81
		);
		add_submenu_page( 'bridgistic', 'Connect', 'Connect', 'manage_options', 'bridgistic', array( $this, 'render' ) );
		add_submenu_page( 'bridgistic', 'Approvals', 'Approvals', 'manage_options', 'bridgistic-approvals', array( $this, 'render_approvals' ) );
		add_submenu_page( 'bridgistic', 'Snapshots', 'Snapshots', 'manage_options', 'bridgistic-snapshots', array( $this, 'render_snapshots' ) );
		add_submenu_page( 'bridgistic', 'Usage', 'Usage', 'manage_options', 'bridgistic-usage', array( $this, 'render_usage' ) );
		add_submenu_page( 'bridgistic', 'Schedules', 'Schedules', 'manage_options', 'bridgistic-schedules', array( $this, 'render_schedules' ) );
		add_submenu_page( 'bridgistic', 'Settings', 'Settings', 'manage_options', 'bridgistic-settings', array( $this, 'render_settings' ) );
	}

	public function handle_create_key(): void {
		if ( ! current_user_can( 'manage_options' ) || ! check_admin_referer( 'bridgistic_create_key' ) ) {
			wp_die( 'Not allowed.' );
		}

		$label   = isset( $_POST['label'] ) ? sanitize_text_field( wp_unslash( $_POST['label'] ) ) : 'MCP Key';
		$scopes  = isset( $_POST['scopes'] ) ? array_map( 'sanitize_text_field', (array) wp_unslash( $_POST['scopes'] ) ) : array();
		$rate    = isset( $_POST['rate_limit'] ) ? (int) $_POST['rate_limit'] : 120;
		$ips     = isset( $_POST['ip_allowlist'] ) ? array_filter( array_map( 'trim', explode( "\n", sanitize_textarea_field( wp_unslash( $_POST['ip_allowlist'] ) ) ) ) ) : array();
		$approve = ! empty( $_POST['require_approval'] );
		$tier    = isset( $_POST['tier'] ) ? sanitize_key( wp_unslash( $_POST['tier'] ) ) : 'custom';
		$quota   = isset( $_POST['monthly_quota'] ) ? max( 0, (int) $_POST['monthly_quota'] ) : 0;

		// A named tier (other than custom) sets rate + quota from the preset.
		$tiers = \Bridgistic\Usage::tiers();
		if ( 'custom' !== $tier && isset( $tiers[ $tier ] ) ) {
			$rate  = $tiers[ $tier ]['rate'];
			$quota = $tiers[ $tier ]['quota'];
		}

		$created = KeyStore::create( $label, Scopes::sanitize( $scopes ), $ips, $rate, $approve, $tier, $quota );

		// Show the secret exactly once via a short-lived transient.
		set_transient( 'bridgistic_new_key_' . get_current_user_id(), $created, 120 );

		wp_safe_redirect( admin_url( 'admin.php?page=bridgistic&created=1' ) );
		exit;
	}

	public function handle_decide_approval(): void {
		if ( ! current_user_can( 'manage_options' ) || ! check_admin_referer( 'bridgistic_decide_approval' ) ) {
			wp_die( 'Not allowed.' );
		}
		$id      = isset( $_POST['approval_id'] ) ? sanitize_text_field( wp_unslash( $_POST['approval_id'] ) ) : '';
		$approve = isset( $_POST['decision'] ) && 'approve' === $_POST['decision'];
		if ( $id ) {
			\Bridgistic\Approvals::decide( $id, $approve, get_current_user_id() );
		}
		wp_safe_redirect( admin_url( 'admin.php?page=bridgistic-approvals' ) );
		exit;
	}

	public function handle_save_allowlist(): void {
		if ( ! current_user_can( 'manage_options' ) || ! check_admin_referer( 'bridgistic_save_allowlist' ) ) {
			wp_die( 'Not allowed.' );
		}
		$raw  = isset( $_POST['allowlist'] ) ? sanitize_textarea_field( wp_unslash( $_POST['allowlist'] ) ) : '';
		$list = array_values( array_filter( array_map( 'trim', explode( "\n", $raw ) ) ) );
		update_option( 'bridgistic_options_allowlist', $list );
		wp_safe_redirect( admin_url( 'admin.php?page=bridgistic-settings&saved=1' ) );
		exit;
	}

	public function handle_schedule_action(): void {
		if ( ! current_user_can( 'manage_options' ) || ! check_admin_referer( 'bridgistic_schedule_action' ) ) {
			wp_die( 'Not allowed.' );
		}
		$id  = isset( $_POST['schedule_id'] ) ? sanitize_text_field( wp_unslash( $_POST['schedule_id'] ) ) : '';
		$act = isset( $_POST['do'] ) ? sanitize_key( wp_unslash( $_POST['do'] ) ) : '';
		if ( $id ) {
			switch ( $act ) {
				case 'enable':
					\Bridgistic\Scheduler::toggle( $id, true );
					break;
				case 'disable':
					\Bridgistic\Scheduler::toggle( $id, false );
					break;
				case 'delete':
					\Bridgistic\Scheduler::delete( $id );
					break;
				case 'run':
					$row = \Bridgistic\Scheduler::get( $id );
					if ( $row ) {
						\Bridgistic\Scheduler::execute( $row );
					}
					break;
			}
		}
		wp_safe_redirect( admin_url( 'admin.php?page=bridgistic-schedules' ) );
		exit;
	}

	public function handle_revoke_key(): void {
		if ( ! current_user_can( 'manage_options' ) || ! check_admin_referer( 'bridgistic_revoke_key' ) ) {
			wp_die( 'Not allowed.' );
		}
		$key_id = isset( $_POST['key_id'] ) ? sanitize_text_field( wp_unslash( $_POST['key_id'] ) ) : '';
		if ( $key_id ) {
			KeyStore::revoke( $key_id );
		}
		wp_safe_redirect( admin_url( 'admin.php?page=bridgistic&revoked=1' ) );
		exit;
	}

	public function render(): void {
		$new_key = get_transient( 'bridgistic_new_key_' . get_current_user_id() );
		if ( $new_key ) {
			delete_transient( 'bridgistic_new_key_' . get_current_user_id() );
		}
		$keys = KeyStore::list_all();
		?>
		<div class="wrap">
			<h1>Bridgistic — Connect</h1>
			<p>Mint a scoped key, then paste the connection block into your WordPressistic MCP server config. The secret is shown <strong>once</strong>.</p>

			<?php if ( $new_key ) : ?>
				<div class="notice notice-success">
					<h2>New key created — copy it now</h2>
					<p><code>WP_SITE_URL=<?php echo esc_html( home_url() ); ?></code></p>
					<p><code>BRIDGISTIC_KEY_ID=<?php echo esc_html( $new_key['key_id'] ); ?></code></p>
					<p><code>BRIDGISTIC_KEY_SECRET=<?php echo esc_html( $new_key['secret'] ); ?></code></p>
				</div>
			<?php endif; ?>

			<h2>Create a key</h2>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="bridgistic_create_key" />
				<?php wp_nonce_field( 'bridgistic_create_key' ); ?>
				<table class="form-table">
					<tr>
						<th><label for="label">Label</label></th>
						<td><input name="label" id="label" type="text" class="regular-text" value="Claude Cowork" /></td>
					</tr>
					<tr>
						<th>Scopes</th>
						<td>
							<?php foreach ( Scopes::all() as $scope => $desc ) : ?>
								<label style="display:block">
									<input type="checkbox" name="scopes[]" value="<?php echo esc_attr( $scope ); ?>" />
									<code><?php echo esc_html( $scope ); ?></code> — <?php echo esc_html( $desc ); ?>
								</label>
							<?php endforeach; ?>
						</td>
					</tr>
					<tr>
						<th><label for="rate_limit">Rate limit (req/min)</label></th>
						<td><input name="rate_limit" id="rate_limit" type="number" value="120" min="1" max="6000" /></td>
					</tr>
					<tr>
						<th><label for="ip_allowlist">IP allowlist (optional, one per line)</label></th>
						<td><textarea name="ip_allowlist" id="ip_allowlist" rows="3" class="large-text" placeholder="203.0.113.10&#10;198.51.100.0/24"></textarea></td>
					</tr>
					<tr>
						<th>Approval</th>
						<td>
							<label>
								<input type="checkbox" name="require_approval" value="1" />
								Require human approval before this key can perform any write/destructive op
							</label>
							<p class="description">Recommended for live client sites and for Claude Cowork keys.</p>
						</td>
					</tr>
					<tr>
						<th><label for="tier">Billing tier</label></th>
						<td>
							<select name="tier" id="tier">
								<?php foreach ( \Bridgistic\Usage::tiers() as $slug => $t ) : ?>
									<option value="<?php echo esc_attr( $slug ); ?>" <?php selected( 'custom', $slug ); ?>>
										<?php echo esc_html( $t['label'] ); ?> —
										<?php echo (int) $t['rate']; ?>/min,
										<?php echo $t['quota'] ? esc_html( number_format_i18n( $t['quota'] ) . '/mo' ) : 'unlimited'; ?>
									</option>
								<?php endforeach; ?>
							</select>
							<p class="description">A named tier overrides the rate + quota fields below. Choose <strong>Custom</strong> to set them by hand.</p>
						</td>
					</tr>
					<tr>
						<th><label for="monthly_quota">Monthly quota (Custom only)</label></th>
						<td><input type="number" name="monthly_quota" id="monthly_quota" value="0" min="0" class="small-text" /> <span class="description">requests/month — 0 = unlimited</span></td>
					</tr>
				</table>
				<?php submit_button( 'Create key' ); ?>
			</form>

			<h2>Existing keys</h2>
			<table class="widefat striped">
				<thead><tr><th>Label</th><th>Key ID</th><th>Scopes</th><th>Last used</th><th></th></tr></thead>
				<tbody>
				<?php if ( ! $keys ) : ?>
					<tr><td colspan="5">No keys yet.</td></tr>
				<?php else : ?>
					<?php foreach ( $keys as $k ) : ?>
						<tr>
							<td><?php echo esc_html( $k['label'] ); ?></td>
							<td><code><?php echo esc_html( $k['key_id'] ); ?></code></td>
							<td><?php echo esc_html( implode( ', ', (array) json_decode( (string) $k['scopes'], true ) ) ); ?></td>
							<td><?php echo esc_html( $k['last_used_at'] ?: '—' ); ?></td>
							<td>
								<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" onsubmit="return confirm('Revoke this key?');">
									<input type="hidden" name="action" value="bridgistic_revoke_key" />
									<input type="hidden" name="key_id" value="<?php echo esc_attr( $k['key_id'] ); ?>" />
									<?php wp_nonce_field( 'bridgistic_revoke_key' ); ?>
									<button class="button button-link-delete">Revoke</button>
								</form>
							</td>
						</tr>
					<?php endforeach; ?>
				<?php endif; ?>
				</tbody>
			</table>
		</div>
		<?php
	}
	public function render_approvals(): void {
		$pending = \Bridgistic\Approvals::list_by_status( \Bridgistic\Approvals::PENDING, 100 );
		$recent  = \Bridgistic\Approvals::list_by_status( '', 50 );
		?>
		<div class="wrap">
			<h1>Approvals</h1>
			<p>Operations queued by keys that require approval. Approve to let the agent retry and execute; reject to block it.</p>

			<h2>Pending (<?php echo count( $pending ); ?>)</h2>
			<table class="widefat striped">
				<thead><tr><th>When</th><th>Key</th><th>Action</th><th>Summary</th><th>Decision</th></tr></thead>
				<tbody>
				<?php if ( ! $pending ) : ?>
					<tr><td colspan="5">Nothing waiting.</td></tr>
				<?php else : foreach ( $pending as $a ) : ?>
					<tr>
						<td><?php echo esc_html( $a['created_at'] ); ?></td>
						<td><code><?php echo esc_html( $a['key_id'] ); ?></code></td>
						<td><code><?php echo esc_html( $a['action'] ); ?></code></td>
						<td><?php echo esc_html( (string) $a['summary'] ); ?></td>
						<td>
							<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline">
								<input type="hidden" name="action" value="bridgistic_decide_approval" />
								<input type="hidden" name="approval_id" value="<?php echo esc_attr( $a['approval_id'] ); ?>" />
								<?php wp_nonce_field( 'bridgistic_decide_approval' ); ?>
								<button class="button button-primary" name="decision" value="approve">Approve</button>
								<button class="button" name="decision" value="reject">Reject</button>
							</form>
						</td>
					</tr>
				<?php endforeach; endif; ?>
				</tbody>
			</table>

			<h2>Recent decisions</h2>
			<table class="widefat striped">
				<thead><tr><th>When</th><th>Action</th><th>Status</th><th>Decided</th></tr></thead>
				<tbody>
				<?php foreach ( $recent as $a ) : ?>
					<tr>
						<td><?php echo esc_html( $a['created_at'] ); ?></td>
						<td><code><?php echo esc_html( $a['action'] ); ?></code></td>
						<td><?php echo esc_html( $a['status'] ); ?></td>
						<td><?php echo esc_html( $a['decided_at'] ?: '—' ); ?></td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>
		</div>
		<?php
	}

	public function render_snapshots(): void {
		$snaps = \Bridgistic\Snapshot::list_recent( 100 );
		?>
		<div class="wrap">
			<h1>Snapshots</h1>
			<p>Reversible captures taken automatically before destructive ops (and manually via the API). Restore with the <code>bridgistic_snapshot_restore</code> tool.</p>
			<table class="widefat striped">
				<thead><tr><th>ID</th><th>Type</th><th>Label</th><th>Size</th><th>Created</th><th>Restored</th></tr></thead>
				<tbody>
				<?php if ( ! $snaps ) : ?>
					<tr><td colspan="6">No snapshots yet.</td></tr>
				<?php else : foreach ( $snaps as $s ) : ?>
					<tr>
						<td><code><?php echo esc_html( $s['snapshot_id'] ); ?></code></td>
						<td><?php echo esc_html( $s['type'] ); ?></td>
						<td><?php echo esc_html( (string) $s['label'] ); ?></td>
						<td><?php echo esc_html( size_format( (int) $s['byte_size'] ) ); ?></td>
						<td><?php echo esc_html( $s['created_at'] ); ?></td>
						<td><?php echo esc_html( $s['restored_at'] ?: '—' ); ?></td>
					</tr>
				<?php endforeach; endif; ?>
				</tbody>
			</table>
		</div>
		<?php
	}

	public function render_usage(): void {
		$keys = KeyStore::list_all();
		?>
		<div class="wrap">
			<h1>Usage &amp; metering</h1>
			<p>Per-key request counts. Rate limit is enforced per minute; quota is the monthly billing cap (0 = unlimited).</p>
			<table class="widefat striped">
				<thead><tr><th>Key</th><th>Tier</th><th>Rate (limit/min)</th><th>This month</th><th>Quota</th><th>Today</th><th>Approval</th></tr></thead>
				<tbody>
				<?php if ( ! $keys ) : ?>
					<tr><td colspan="7">No keys yet.</td></tr>
				<?php else : foreach ( $keys as $k ) :
					$u     = \Bridgistic\Usage::summary( (string) $k['key_id'] );
					$quota = (int) ( $k['monthly_quota'] ?? 0 );
					?>
					<tr>
						<td><strong><?php echo esc_html( (string) $k['label'] ); ?></strong><br><code><?php echo esc_html( (string) $k['key_id'] ); ?></code></td>
						<td><?php echo esc_html( (string) ( $k['tier'] ?? 'custom' ) ); ?></td>
						<td><?php echo esc_html( (string) ( $k['rate_limit'] ?? 120 ) ); ?></td>
						<td><?php echo esc_html( number_format_i18n( (int) $u['this_month'] ) ); ?></td>
						<td><?php echo $quota ? esc_html( number_format_i18n( $quota ) ) : '∞'; ?></td>
						<td><?php echo esc_html( number_format_i18n( (int) $u['today'] ) ); ?></td>
						<td><?php echo ! empty( $k['require_approval'] ) ? 'required' : '—'; ?></td>
					</tr>
				<?php endforeach; endif; ?>
				</tbody>
			</table>
		</div>
		<?php
	}

	public function render_schedules(): void {
		$rows       = \Bridgistic\Scheduler::list();
		$cron_off   = defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON;
		$action_url = admin_url( 'admin-post.php' );
		?>
		<div class="wrap">
			<h1>Scheduled playbooks</h1>
			<?php if ( $cron_off ) : ?>
				<div class="notice notice-info inline"><p><strong>WP-Cron is disabled</strong> — good. Make sure a real system cron is hitting <code><?php echo esc_html( site_url( 'wp-cron.php' ) ); ?></code> (e.g. every 5 min) so schedules fire reliably.</p></div>
			<?php else : ?>
				<div class="notice notice-warning inline"><p><strong>Using WP-Cron</strong> (fires on site traffic). For dependable unattended runs, set <code>define('DISABLE_WP_CRON', true);</code> and add a real cron:<br><code>*/5 * * * * curl -s <?php echo esc_html( site_url( 'wp-cron.php?doing_wp_cron' ) ); ?> &gt;/dev/null 2&gt;&amp;1</code></p></div>
			<?php endif; ?>

			<p>Schedules run their playbook under the bound key's current scopes. Create and manage schedules from the agent (<code>bridgistic_schedule_create</code>) or trigger one here.</p>
			<table class="widefat striped">
				<thead><tr><th>ID</th><th>Playbook</th><th>Recurrence</th><th>Next run (UTC)</th><th>Last run</th><th>Status</th><th>State</th><th>Actions</th></tr></thead>
				<tbody>
				<?php if ( ! $rows ) : ?>
					<tr><td colspan="8">No schedules yet.</td></tr>
				<?php else : foreach ( $rows as $r ) : ?>
					<tr>
						<td><code><?php echo esc_html( $r['schedule_id'] ); ?></code></td>
						<td><?php echo esc_html( $r['playbook_slug'] ); ?></td>
						<td><?php echo esc_html( $r['recurrence'] ); ?></td>
						<td><?php echo esc_html( (string) ( $r['next_run'] ?: '—' ) ); ?></td>
						<td><?php echo esc_html( (string) ( $r['last_run'] ?: '—' ) ); ?></td>
						<td><?php echo esc_html( (string) ( $r['last_status'] ?: '—' ) ); ?></td>
						<td><?php echo (int) $r['enabled'] === 1 ? 'enabled' : 'disabled'; ?></td>
						<td>
							<?php
							foreach ( array(
								'run'     => 'Run now',
								( (int) $r['enabled'] === 1 ? 'disable' : 'enable' ) => ( (int) $r['enabled'] === 1 ? 'Disable' : 'Enable' ),
								'delete'  => 'Delete',
							) as $do => $label ) :
								?>
								<form method="post" action="<?php echo esc_url( $action_url ); ?>" style="display:inline">
									<input type="hidden" name="action" value="bridgistic_schedule_action" />
									<input type="hidden" name="schedule_id" value="<?php echo esc_attr( $r['schedule_id'] ); ?>" />
									<input type="hidden" name="do" value="<?php echo esc_attr( $do ); ?>" />
									<?php wp_nonce_field( 'bridgistic_schedule_action' ); ?>
									<button class="button button-small <?php echo 'delete' === $do ? 'button-link-delete' : ''; ?>"><?php echo esc_html( $label ); ?></button>
								</form>
							<?php endforeach; ?>
						</td>
					</tr>
				<?php endforeach; endif; ?>
				</tbody>
			</table>
		</div>
		<?php
	}

	public function render_settings(): void {
		$list = (array) get_option( 'bridgistic_options_allowlist', array() );
		?>
		<div class="wrap">
			<h1>Settings</h1>
			<h2>Options allowlist</h2>
			<p>Only these option names can be read or written via the <code>options</code> tools. One per line. Trailing <code>*</code> wildcard allowed (e.g. <code>woocommerce_*</code>). Leave empty to use the safe defaults.</p>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="bridgistic_save_allowlist" />
				<?php wp_nonce_field( 'bridgistic_save_allowlist' ); ?>
				<textarea name="allowlist" rows="12" class="large-text code"><?php echo esc_textarea( implode( "\n", $list ) ); ?></textarea>
				<?php submit_button( 'Save allowlist' ); ?>
			</form>
		</div>
		<?php
	}
}
