/**
 * What a tool snapshots before it runs.
 *
 * SECURITY_MODEL §3 gates `operational`, `destructive` and `code_execution`
 * behind a snapshot, and the executor takes one before the call. Taking it
 * requires knowing WHAT to capture, and the plugin captures exactly five
 * things: one post, one user, one option, a list of named tables, or one file.
 *
 * So "requires a snapshot" is not a property a tool can have on its own. It
 * needs a target the platform can construct from the call's own arguments, and
 * for a number of tools no such target exists. Those are listed below with the
 * reason, and they are DENIED rather than run without the snapshot their class
 * requires — a gate that reports "rollback available" over a snapshot of the
 * wrong thing, or of nothing, is worse than no gate, because it is the thing
 * an operator checks before approving.
 */

/** The capture types the plugin implements. Anything else is not a snapshot. */
export type SnapshotType = "post" | "user" | "option" | "tables" | "file";

export interface SnapshotTarget {
  readonly type: SnapshotType;
  /** Shape is per type, and must match what `Snapshot::capture` reads. */
  readonly target: Record<string, unknown>;
}

/** Why a tool that requires a snapshot cannot have one taken. */
export interface SnapshotUnavailable {
  readonly reason: string;
}

export type SnapshotPlan = SnapshotTarget | SnapshotUnavailable;

export function isUnavailable(plan: SnapshotPlan): plan is SnapshotUnavailable {
  return "reason" in plan;
}

/**
 * Tools whose snapshot cannot be targeted, and why.
 *
 * Written out rather than inferred, so each is a decision somebody made and
 * can revisit — and so adding a tool to this list is a visible act rather than
 * a missing case that silently falls through to "no snapshot".
 */
const UNAVAILABLE: Readonly<Record<string, string>> = Object.freeze({
  bridgistic_execute_php:
    "Arbitrary PHP can change anything on the site, so there is no bounded target to capture. " +
    "The plugin has no whole-site capture, and a snapshot of the wrong thing would be reported " +
    "to the approver as a rollback path that does not exist.",

  bridgistic_db_query:
    "The tables a statement touches are only knowable by parsing the SQL, and a parser that is " +
    "wrong about a DELETE is worse than no snapshot. The plugin's own Guard already snapshots " +
    "the affected tables for a destructive write, on the site, where the statement is understood.",

  bridgistic_create_user:
    "Nothing exists yet to capture. The rollback for a created user is deleting it, which is a " +
    "different operation, not a restore.",

  // Playbooks and schedules live in `{prefix}bridgistic_playbooks` and
  // `{prefix}bridgistic_schedules`. `Snapshot::safe_table` requires an exact
  // table name and `site-info` does not report the site's table prefix, so the
  // platform cannot name the table it would have to capture.
  bridgistic_playbook_save: PREFIX_UNKNOWN("playbooks"),
  bridgistic_playbook_run: PREFIX_UNKNOWN("playbooks"),
  bridgistic_playbook_delete: PREFIX_UNKNOWN("playbooks"),
  bridgistic_schedule_create: PREFIX_UNKNOWN("schedules"),
  bridgistic_schedule_toggle: PREFIX_UNKNOWN("schedules"),
  bridgistic_schedule_delete: PREFIX_UNKNOWN("schedules"),
  bridgistic_schedule_run_now: PREFIX_UNKNOWN("schedules"),

  bridgistic_snapshot_restore:
    "A restore must capture the same target the snapshot being restored covers, and only the " +
    "site knows what that snapshot holds. Restoring is refused until the plugin reports a " +
    "snapshot's type and target, or takes the pre-restore capture itself.",
});

function PREFIX_UNKNOWN(what: string): string {
  return (
    `Bridgistic ${what} live in a plugin table named with the site's own table prefix. ` +
    `Snapshot::safe_table needs the exact name and site-info does not report the prefix, ` +
    `so the platform cannot name the table to capture.`
  );
}

/**
 * The snapshot to take before `tool` runs with `args`.
 *
 * Returns `undefined` when the tool needs no snapshot at all. Callers must
 * treat an unavailable plan as a refusal, not as "skip the snapshot".
 */
export function snapshotTargetFor(
  tool: string,
  args: Record<string, unknown>
): SnapshotPlan | undefined {
  const unavailable = UNAVAILABLE[tool];
  if (unavailable !== undefined) return { reason: unavailable };

  switch (tool) {
    case "bridgistic_update_user":
      return identified("user", args.id);

    case "bridgistic_update_option":
      return typeof args.name === "string" && args.name.length > 0
        ? { type: "option", target: { name: args.name } }
        : { reason: "The option to snapshot was not named." };

    case "bridgistic_toggle_plugin":
      // Activating or deactivating a plugin rewrites `active_plugins`, and
      // putting that option back is what undoes it.
      return { type: "option", target: { name: "active_plugins" } };

    case "bridgistic_fs_write":
    case "bridgistic_fs_delete":
      return typeof args.path === "string" && args.path.length > 0
        ? { type: "file", target: { path: args.path } }
        : { reason: "The file to snapshot was not named." };

    case "bridgistic_woo_update_order_status":
      // A WooCommerce order is a post, and its status lives in that row. This
      // holds for the classic post storage; a site on High-Performance Order
      // Storage keeps orders in a separate table, and BR-020 tracks that.
      return identified("post", args.id);

    default:
      return undefined;
  }
}

function identified(type: "post" | "user", id: unknown): SnapshotPlan {
  const numeric = typeof id === "number" ? id : Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return { reason: "The record to snapshot was not identified." };
  }
  return { type, target: { id: numeric } };
}
