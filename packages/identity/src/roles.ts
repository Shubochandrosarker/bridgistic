/**
 * Roles and what they may do.
 *
 * The permission matrix is data, not a pile of `if (role === "admin")`. Those
 * scatter, and once they scatter nobody can answer "what can an Operator do?"
 * without reading every route — which means the answer changes without anyone
 * deciding it should.
 *
 * Two principles decide the shape:
 *
 *  1. **Separation of duty.** An Approver approves; an Operator executes.
 *     Whether one person may hold both roles is an organization's decision,
 *     but the *roles* must be separable or approval is theatre — a gate you
 *     open for yourself has stopped being a gate.
 *
 *  2. **Least privilege by default.** A new permission added to this file is
 *     granted to nobody until it is listed. The matrix is explicit per role;
 *     there is no "everything except" shorthand, because that shorthand is how
 *     a new dangerous permission quietly lands in a role that should not have
 *     it.
 */

export const ROLES = [
  "owner",
  "admin",
  "operator",
  "approver",
  "viewer",
  "billing_manager",
  "support_auditor",
] as const;

export type Role = (typeof ROLES)[number];

/**
 * Everything a role can be permitted to do.
 *
 * Deliberately fine-grained where the risk differs. `site.connect` and
 * `site.delete` are not the same act, and neither is `approval.request` and
 * `approval.decide`.
 */
export const PERMISSIONS = [
  // Organization
  "org.read",
  "org.update",
  "org.delete",
  "member.read",
  "member.invite",
  "member.remove",
  "member.change_role",

  // Sites
  "site.read",
  "site.connect",
  "site.update",
  "site.transfer",
  "site.suspend",
  "site.delete",
  "site.rotate_credentials",
  "site.grant_scope",
  "site.revoke_scope",

  // Execution
  "tool.read",
  "tool.content_write",
  "tool.operational",
  "tool.destructive",
  "tool.code_execution",

  // Approvals — requesting and deciding are separate on purpose.
  "approval.request",
  "approval.decide",

  // Safety
  "snapshot.create",
  "snapshot.restore",
  "snapshot.delete",

  // Scheduling
  "job.read",
  "job.write",
  "job.run_now",

  // Keys and machine identities
  "apikey.read",
  "apikey.create",
  "apikey.revoke",

  // Billing
  "billing.read",
  "billing.manage",

  // Audit
  "audit.read",
  "usage.read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Read-only permissions, shared by every role that can see anything at all. */
const READ_ONLY: readonly Permission[] = [
  "org.read",
  "member.read",
  "site.read",
  "tool.read",
  "job.read",
  "usage.read",
];

/**
 * The matrix. Every role lists every permission it holds.
 *
 * Written out rather than composed from "viewer plus these", because
 * composition hides what a role can do behind an inheritance chain, and the
 * question people ask is always "what can this role do", never "what does it
 * add".
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  /** Everything, including deleting the organization. Exactly one is required. */
  owner: [...PERMISSIONS],

  /**
   * Everything operational. Cannot delete the organization or change billing —
   * the two acts whose blast radius is the company rather than the software.
   */
  admin: [
    ...READ_ONLY,
    "org.update",
    "member.invite",
    "member.remove",
    "member.change_role",
    "site.connect",
    "site.update",
    "site.transfer",
    "site.suspend",
    "site.delete",
    "site.rotate_credentials",
    "site.grant_scope",
    "site.revoke_scope",
    "tool.content_write",
    "tool.operational",
    "tool.destructive",
    "tool.code_execution",
    "approval.request",
    "approval.decide",
    "snapshot.create",
    "snapshot.restore",
    "snapshot.delete",
    "job.write",
    "job.run_now",
    "apikey.read",
    "apikey.create",
    "apikey.revoke",
    "billing.read",
    "audit.read",
  ],

  /**
   * Does the work. Can run anything, including destructive tools — but every
   * gated call still needs an approval, and an Operator cannot grant one.
   *
   * Cannot widen its own reach: no scope grants, no member changes, no API
   * keys. An Operator who could grant themselves a scope would be an Admin
   * with extra steps.
   */
  operator: [
    ...READ_ONLY,
    "tool.content_write",
    "tool.operational",
    "tool.destructive",
    "tool.code_execution",
    "approval.request",
    "snapshot.create",
    "snapshot.restore",
    "job.write",
    "job.run_now",
    "audit.read",
  ],

  /**
   * Decides on approvals and nothing else.
   *
   * Deliberately cannot execute. An approver who could also run the thing they
   * approved would make the two-person rule a formality, and the whole reason
   * the role exists is that somebody who is not doing the work looks at it
   * first.
   */
  approver: [...READ_ONLY, "approval.decide", "audit.read"],

  /** Sees the state of things. Changes nothing. */
  viewer: [...READ_ONLY],

  /**
   * Pays the bills. Has no reach into any connected site — a finance seat
   * should not be a path to a customer's WordPress install.
   */
  billing_manager: ["org.read", "member.read", "usage.read", "billing.read", "billing.manage"],

  /**
   * Reads the audit trail for support and incident work.
   *
   * Notably cannot read sites or run tools: this role exists to answer "what
   * happened", and answering that does not require the ability to make more of
   * it happen.
   */
  support_auditor: ["org.read", "member.read", "audit.read", "usage.read"],
};

// Built with an explicit reduce rather than Object.fromEntries, which widens
// the key type to string and needs a cast to get back — and a cast here would
// hide a role missing from the matrix, which is the one mistake this structure
// exists to prevent.
const PERMISSION_SETS: Readonly<Record<Role, ReadonlySet<Permission>>> = ROLES.reduce(
  (sets, role) => {
    sets[role] = new Set(ROLE_PERMISSIONS[role]);
    return sets;
  },
  {} as Record<Role, ReadonlySet<Permission>>
);

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Does `role` hold `permission`? The only way to ask. */
export function can(role: Role, permission: Permission): boolean {
  return PERMISSION_SETS[role]?.has(permission) ?? false;
}

/**
 * The permission a tool's risk class needs, on top of its scope.
 *
 * Scope says "this site allows this category of work". Role says "this person
 * is allowed to do it". Both, always: a Viewer on a site granted `posts:write`
 * still may not write, and an Operator on a site with no grant still may not.
 */
export function permissionForRiskClass(riskClass: string): Permission | null {
  switch (riskClass) {
    case "local":
    case "safe_read":
    case "sensitive_read":
      return "tool.read";
    case "content_write":
      return "tool.content_write";
    case "operational":
      return "tool.operational";
    case "destructive":
      return "tool.destructive";
    case "credential":
      // No role short of Admin may create a WordPress user, and it is gated
      // as code execution because that is what a new administrator is.
      return "tool.code_execution";
    case "code_execution":
      return "tool.code_execution";
    default:
      // An unrecognised class denies. A new class added without a mapping must
      // not fall through to permitted.
      return null;
  }
}

/**
 * May `approver` decide an approval that `requester` asked for?
 *
 * Self-approval is refused. An organization with one Operator who is also the
 * only Approver has not configured two-person control, and telling them so at
 * the moment it matters is better than letting them believe they have it.
 */
export function canDecideApproval(
  approver: { readonly userId: string; readonly role: Role },
  requester: { readonly userId: string }
): { readonly ok: boolean; readonly reason?: string } {
  if (!can(approver.role, "approval.decide")) {
    return { ok: false, reason: `The ${approver.role} role cannot decide approvals.` };
  }
  if (approver.userId === requester.userId) {
    return {
      ok: false,
      reason:
        "You cannot approve your own request. Approval exists so somebody who is not doing the work looks at " +
        "it first; approving your own removes the only thing it was protecting against.",
    };
  }
  return { ok: true };
}

/**
 * May `actor` change `target`'s role to `next`?
 *
 * Three rules, all of which exist because of a specific way this goes wrong:
 *
 *  - You cannot grant a role you do not hold. Otherwise an Admin promotes
 *    themselves to Owner via a colleague.
 *  - You cannot change your own role. Otherwise the check above is one hop
 *    away from useless.
 *  - The last Owner cannot be demoted or removed. An organization with no
 *    Owner cannot manage billing, delete itself, or recover — and the support
 *    path for that is a human restoring a database row.
 */
export function canChangeRole(
  actor: { readonly userId: string; readonly role: Role },
  target: { readonly userId: string; readonly role: Role },
  next: Role,
  context: { readonly ownerCount: number }
): { readonly ok: boolean; readonly reason?: string } {
  if (!can(actor.role, "member.change_role")) {
    return { ok: false, reason: `The ${actor.role} role cannot change member roles.` };
  }
  if (actor.userId === target.userId) {
    return { ok: false, reason: "You cannot change your own role." };
  }
  if (next === "owner" && actor.role !== "owner") {
    return { ok: false, reason: "Only an owner can make somebody else an owner." };
  }
  if (target.role === "owner" && actor.role !== "owner") {
    return { ok: false, reason: "Only an owner can change another owner's role." };
  }
  if (target.role === "owner" && next !== "owner" && context.ownerCount <= 1) {
    return {
      ok: false,
      reason: "This is the last owner. Make somebody else an owner first, or the organization cannot be managed.",
    };
  }
  return { ok: true };
}
