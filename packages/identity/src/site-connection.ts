/**
 * Site connection, claiming and transfer, as a state machine.
 *
 * Written as pure transitions rather than as route handlers because the
 * dangerous part of this flow is not any single step — it is the orderings
 * nobody thought about. A state machine makes "verified twice", "claimed
 * without verifying", "transferred while suspended" and "reconnected after
 * deletion" into cases that either have an answer here or fail closed.
 *
 * The flow, from the brief:
 *
 *   1. organization exists
 *   2. user starts a connection            → pending
 *   3. Bridgistic issues a short-lived challenge
 *   4. the plugin proves it holds the challenge
 *   5. a signed connection is established  → verified
 *   6. the site identity is recorded
 *   7. the user claims or confirms it      → claimed
 *   8. scopes are granted explicitly
 *   9. the credential version is stored
 *  10. a health check confirms it
 *  11. the site is visible to the organization
 *
 * Nothing is skippable. A site is not usable until it is `claimed` AND has at
 * least one grant, and neither of those happens implicitly.
 */

export const CONNECTION_STATES = ["pending", "verified", "claimed", "expired", "abandoned"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const SITE_STATES = ["connected", "suspended", "disconnected"] as const;
export type SiteState = (typeof SITE_STATES)[number];

/**
 * A pending connection is an unauthenticated write path into an organization.
 * Ten minutes is enough to paste a URL and click a button in wp-admin, and not
 * enough to leave open while somebody goes to lunch.
 */
export const CONNECTION_CHALLENGE_TTL_SECONDS = 600;

/** A claim on a migrated site needs a person to act, so it gets longer. */
export const OWNERSHIP_CLAIM_TTL_SECONDS = 24 * 60 * 60;

export interface Connection {
  readonly id: string;
  readonly organizationId: string;
  readonly siteUrl: string;
  readonly state: ConnectionState;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly verifiedAt: number | null;
  readonly claimedAt: number | null;
  readonly siteId: string | null;
}

export type TransitionResult =
  | { readonly ok: true; readonly next: ConnectionState }
  | { readonly ok: false; readonly reason: string };

/**
 * Legal transitions. Anything absent is refused.
 *
 * An allowlist rather than a list of forbidden moves: a state added later
 * inherits "nothing is allowed until somebody says so" instead of silently
 * inheriting every transition nobody remembered to forbid.
 */
const ALLOWED: Readonly<Record<ConnectionState, readonly ConnectionState[]>> = {
  pending: ["verified", "expired", "abandoned"],
  // A verified connection can still be abandoned — somebody may verify and
  // then decide not to add the site — but it can never go back to pending.
  // Re-issuing a challenge means starting a new connection, so a challenge
  // cannot be replayed against a connection that already used one.
  verified: ["claimed", "expired", "abandoned"],
  // Terminal.
  claimed: [],
  expired: [],
  abandoned: [],
};

export function canTransition(from: ConnectionState, to: ConnectionState): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

/**
 * Verify: the plugin proved it holds the challenge.
 *
 * The proof itself is an HMAC check in the transport; this decides whether the
 * connection is in a state where a proof means anything.
 */
export function verifyConnection(connection: Connection, now: number): TransitionResult {
  if (connection.state !== "pending") {
    return {
      ok: false,
      reason:
        connection.state === "verified"
          ? "This connection has already been verified. Start a new one to reconnect."
          : `A ${connection.state} connection cannot be verified.`,
    };
  }
  // Expiry is checked before the transition, not by a sweeper, because a
  // sweeper that is late is a window in which an expired challenge still works.
  if (connection.expiresAt <= now) {
    return { ok: false, reason: "This connection request has expired. Start a new one." };
  }
  return { ok: true, next: "verified" };
}

export interface ClaimContext {
  readonly now: number;
  /** The actor holds `site.connect` in this organization. */
  readonly actorMayConnect: boolean;
  /** Sites the organization already has, against its plan's `sites.max`. */
  readonly currentSiteCount: number;
  /** `null` is unlimited. */
  readonly sitesMax: number | null;
  /** True when this URL is already connected to SOME organization. */
  readonly urlAlreadyConnected: boolean;
}

/**
 * Claim: the site becomes the organization's.
 *
 * The site-count check lives here rather than at connection start on purpose.
 * Checking at the start means a customer at their limit is refused before they
 * find out whether the connection even works, and two concurrent connections
 * can both pass a check made before either completed. Checking at the point of
 * commit is the only place the number is real.
 */
export function claimConnection(connection: Connection, context: ClaimContext): TransitionResult {
  if (!context.actorMayConnect) {
    return { ok: false, reason: "You do not have permission to connect a site to this organization." };
  }
  if (connection.state !== "verified") {
    return { ok: false, reason: `A ${connection.state} connection cannot be claimed. Verify it first.` };
  }
  if (connection.expiresAt <= context.now) {
    return { ok: false, reason: "This connection request has expired. Start a new one." };
  }

  // One WordPress install belongs to exactly one organization. Moving it is an
  // explicit, audited transfer — never an implicit re-claim, or connecting a
  // site somebody else already has would silently take it from them.
  if (context.urlAlreadyConnected) {
    return {
      ok: false,
      reason:
        "This site is already connected to an organization. If it is yours, transfer it from there — " +
        "connecting it again would take it from whoever has it now without telling them.",
    };
  }

  if (context.sitesMax !== null && context.currentSiteCount >= context.sitesMax) {
    return {
      ok: false,
      reason: `Your plan allows ${context.sitesMax} site${context.sitesMax === 1 ? "" : "s"}. Disconnect one or upgrade.`,
    };
  }

  return { ok: true, next: "claimed" };
}

/**
 * Is this site usable yet?
 *
 * Claimed is necessary and not sufficient: a site with no grants has been
 * connected and authorised for nothing, which is the correct default. The
 * dashboard shows it as "connected, no permissions granted" rather than
 * pretending it is ready.
 */
export function isSiteUsable(site: {
  readonly state: SiteState;
  readonly grantCount: number;
  readonly hasLiveCredential: boolean;
}): { readonly usable: boolean; readonly reason?: string } {
  if (site.state === "suspended") {
    return { usable: false, reason: "This site is suspended. No calls will reach it until it is resumed." };
  }
  if (site.state === "disconnected") {
    return { usable: false, reason: "This site is disconnected. Reconnect it to use it again." };
  }
  if (!site.hasLiveCredential) {
    return { usable: false, reason: "This site has no live credential. Rotate or reconnect it." };
  }
  if (site.grantCount === 0) {
    return {
      usable: false,
      reason: "This site has no permissions granted yet. Grant the scopes it should allow before using it.",
    };
  }
  return { usable: true };
}

export interface TransferContext {
  readonly now: number;
  readonly actorMayTransferFromSource: boolean;
  readonly actorMayConnectToTarget: boolean;
  readonly siteState: SiteState;
  readonly targetSiteCount: number;
  readonly targetSitesMax: number | null;
  /** True when a destructive action on this site is awaiting a decision. */
  readonly hasPendingApprovals: boolean;
  /** True when a scheduled job on this site is mid-run. */
  readonly hasRunningJobs: boolean;
}

/**
 * Transfer a site between organizations.
 *
 * Requires permission in BOTH organizations. Permission in the source alone
 * would let somebody push a site — and its credential — into an organization
 * that never agreed to hold it.
 *
 * Refused while work is in flight. A transfer mid-run would leave an approval
 * pointing at an organization that no longer owns the site, and the approval
 * would then be decided by people who cannot see what it does.
 */
export function canTransferSite(context: TransferContext): { readonly ok: boolean; readonly reason?: string } {
  if (!context.actorMayTransferFromSource) {
    return { ok: false, reason: "You do not have permission to transfer this site out of its organization." };
  }
  if (!context.actorMayConnectToTarget) {
    return {
      ok: false,
      reason:
        "You do not have permission to add a site to the destination organization. A transfer needs permission " +
        "on both sides — otherwise a site and its credential could be pushed into an organization that never " +
        "agreed to hold it.",
    };
  }
  if (context.siteState !== "connected") {
    return { ok: false, reason: `A ${context.siteState} site cannot be transferred. Resume or reconnect it first.` };
  }
  if (context.hasPendingApprovals) {
    return {
      ok: false,
      reason:
        "This site has approvals awaiting a decision. Transferring now would leave them to be decided by people " +
        "who cannot see what they do. Resolve them first.",
    };
  }
  if (context.hasRunningJobs) {
    return { ok: false, reason: "A scheduled job is running on this site. Wait for it to finish." };
  }
  if (context.targetSitesMax !== null && context.targetSiteCount >= context.targetSitesMax) {
    return { ok: false, reason: "The destination organization is at its plan's site limit." };
  }
  return { ok: true };
}

/**
 * What a credential rotation invalidates.
 *
 * Rotation writes a new immutable version. Every grant and session bound to
 * the previous one stops being valid — they are not silently rebound, because
 * a grant is consent to a specific key, and re-pointing it at a new key is a
 * decision the person who granted it did not make.
 */
export interface RotationEffect {
  readonly newVersion: number;
  readonly retiredVersion: number;
  /** OAuth grants issued against the old credential, now invalid. */
  readonly invalidatedGrantIds: readonly string[];
  /** Scope grants survive: they are the organization's policy, not the key's. */
  readonly scopeGrantsPreserved: true;
  /**
   * Whether the site can serve calls during the swap.
   *
   * It cannot: there is a moment where the plugin holds the new key and we
   * have not recorded it, or the reverse. Saying so lets the caller show
   * "rotating" rather than a string of signature failures.
   */
  readonly siteUnavailableDuringSwap: true;
}

export function planRotation(
  currentVersion: number,
  grantsOnCurrentVersion: readonly string[]
): RotationEffect {
  return {
    newVersion: currentVersion + 1,
    retiredVersion: currentVersion,
    invalidatedGrantIds: [...grantsOnCurrentVersion],
    scopeGrantsPreserved: true,
    siteUnavailableDuringSwap: true,
  };
}

/**
 * A migrated site has no user attached — the legacy `tenants` table had no
 * concept of one — so it cannot simply be handed to whoever asks first.
 *
 * The claimant proves control of the site the same way a new connection does.
 * The site is visible as "unclaimed" to nobody until then; it is not listed to
 * an organization that has not proved it owns it.
 */
export function canClaimMigratedSite(context: {
  readonly siteHasOwnerOrganization: boolean;
  readonly claimVerified: boolean;
  readonly claimExpiresAt: number;
  readonly now: number;
}): { readonly ok: boolean; readonly reason?: string } {
  if (context.siteHasOwnerOrganization) {
    return {
      ok: false,
      reason: "This site already belongs to an organization. Use transfer, which is audited on both sides.",
    };
  }
  if (context.claimExpiresAt <= context.now) {
    return { ok: false, reason: "This claim has expired. Start a new one." };
  }
  if (!context.claimVerified) {
    return { ok: false, reason: "Prove control of the site before claiming it." };
  }
  return { ok: true };
}
