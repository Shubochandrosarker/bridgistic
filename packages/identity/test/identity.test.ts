import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  can,
  isRole,
  permissionForRiskClass,
  canDecideApproval,
  canChangeRole,
} from "../src/roles.ts";
import type { Role, Permission } from "../src/roles.ts";
import {
  generateApiKey,
  parseApiKey,
  verifyApiKey,
  hashSecret,
  constantTimeEqual,
  maskApiKey,
} from "../src/api-key.ts";
import type { StoredKey } from "../src/api-key.ts";
import {
  checkSession,
  isStepUpFresh,
  stepUpReasonForRiskClass,
  sessionsToRevoke,
  STEP_UP_WINDOW_SECONDS,
} from "../src/session.ts";
import type { SessionState } from "../src/session.ts";

// ------------------------------------------------------------------- roles --

test("every role is in the matrix and holds only defined permissions", () => {
  const known = new Set<string>(PERMISSIONS);
  for (const role of ROLES) {
    const held = ROLE_PERMISSIONS[role];
    assert.ok(held !== undefined, `${role} is missing from the matrix`);
    for (const permission of held) {
      assert.ok(known.has(permission), `${role} holds undefined permission "${permission}"`);
    }
  }
});

test("owner holds everything; nothing else does", () => {
  for (const permission of PERMISSIONS) {
    assert.ok(can("owner", permission), `owner lacks ${permission}`);
  }
  for (const role of ROLES) {
    if (role === "owner") continue;
    assert.ok(
      PERMISSIONS.some((p) => !can(role, p)),
      `${role} holds every permission, which makes it a second owner`
    );
  }
});

test("only an owner can delete the organization or manage billing", () => {
  for (const role of ROLES) {
    if (role !== "owner") assert.ok(!can(role, "org.delete"), `${role} can delete the organization`);
  }
  const billers = ROLES.filter((r) => can(r, "billing.manage"));
  assert.deepEqual(billers.sort(), ["billing_manager", "owner"]);
});

test("an approver cannot execute, and an operator cannot approve", () => {
  // Separation of duty. Either half failing makes approval a formality.
  assert.ok(can("approver", "approval.decide"));
  for (const permission of [
    "tool.content_write",
    "tool.operational",
    "tool.destructive",
    "tool.code_execution",
  ] as Permission[]) {
    assert.ok(!can("approver", permission), `approver can ${permission}`);
  }

  assert.ok(can("operator", "tool.destructive"));
  assert.ok(!can("operator", "approval.decide"), "an operator who can approve is unsupervised");
});

test("an operator cannot widen its own reach", () => {
  // The failure this prevents: an operator grants themselves a scope, or mints
  // a key with more than they have, and the role boundary stops meaning
  // anything.
  for (const permission of [
    "site.grant_scope",
    "member.change_role",
    "member.invite",
    "apikey.create",
    "site.rotate_credentials",
  ] as Permission[]) {
    assert.ok(!can("operator", permission), `operator can ${permission}`);
  }
});

test("a billing seat has no reach into any connected site", () => {
  // Finance should not be a path to a customer's WordPress install.
  for (const permission of PERMISSIONS) {
    if (permission.startsWith("site.") || permission.startsWith("tool.") || permission.startsWith("snapshot.")) {
      assert.ok(!can("billing_manager", permission), `billing_manager can ${permission}`);
    }
  }
});

test("a support auditor can read what happened and cause nothing new", () => {
  assert.ok(can("support_auditor", "audit.read"));
  for (const permission of PERMISSIONS) {
    if (permission.startsWith("tool.") || permission.startsWith("snapshot.") || permission.startsWith("site.")) {
      assert.ok(!can("support_auditor", permission), `support_auditor can ${permission}`);
    }
  }
});

test("a viewer changes nothing", () => {
  for (const permission of PERMISSIONS) {
    const isRead = /\.(read)$/.test(permission);
    if (!isRead) assert.ok(!can("viewer", permission), `viewer can ${permission}`);
  }
});

test("an unknown risk class denies rather than falling through", () => {
  assert.equal(permissionForRiskClass("safe_read"), "tool.read");
  assert.equal(permissionForRiskClass("destructive"), "tool.destructive");
  assert.equal(permissionForRiskClass("credential"), "tool.code_execution");
  assert.equal(
    permissionForRiskClass("some_future_class"),
    null,
    "a class nobody has mapped yet must not be permitted by default"
  );
});

test("isRole rejects anything not in the list", () => {
  assert.ok(isRole("owner"));
  assert.ok(!isRole("superuser"));
  assert.ok(!isRole("OWNER"), "role names are exact");
});

// ------------------------------------------------------- separation of duty --

test("nobody approves their own request", () => {
  const self = canDecideApproval({ userId: "usr_1", role: "approver" }, { userId: "usr_1" });
  assert.equal(self.ok, false);
  assert.match(self.reason ?? "", /cannot approve your own/i);

  const other = canDecideApproval({ userId: "usr_2", role: "approver" }, { userId: "usr_1" });
  assert.equal(other.ok, true);

  // Even an owner. Especially an owner — they are the likeliest to be alone.
  const owner = canDecideApproval({ userId: "usr_1", role: "owner" }, { userId: "usr_1" });
  assert.equal(owner.ok, false);

  const wrongRole = canDecideApproval({ userId: "usr_2", role: "operator" }, { userId: "usr_1" });
  assert.equal(wrongRole.ok, false);
});

test("role changes cannot be used to escalate", () => {
  const admin = { userId: "usr_admin", role: "admin" as Role };
  const member = { userId: "usr_member", role: "viewer" as Role };
  const owner = { userId: "usr_owner", role: "owner" as Role };

  // An admin cannot mint an owner — that is the escalation path.
  assert.equal(canChangeRole(admin, member, "owner", { ownerCount: 1 }).ok, false);
  // …nor demote one.
  assert.equal(canChangeRole(admin, owner, "viewer", { ownerCount: 2 }).ok, false);
  // …nor change their own role.
  assert.equal(canChangeRole(admin, admin, "owner", { ownerCount: 1 }).ok, false);
  // A role without the permission cannot do it at all.
  assert.equal(canChangeRole({ userId: "u", role: "operator" }, member, "admin", { ownerCount: 1 }).ok, false);

  // What an admin CAN do.
  assert.equal(canChangeRole(admin, member, "operator", { ownerCount: 1 }).ok, true);
});

test("the last owner cannot be demoted", () => {
  const owner = { userId: "usr_1", role: "owner" as Role };
  const other = { userId: "usr_2", role: "owner" as Role };

  const last = canChangeRole(owner, other, "admin", { ownerCount: 1 });
  assert.equal(last.ok, false);
  assert.match(last.reason ?? "", /last owner/i);

  assert.equal(canChangeRole(owner, other, "admin", { ownerCount: 2 }).ok, true);
});

// --------------------------------------------------------------- API keys ---

test("a generated key round-trips, and its secret is never the stored value", async () => {
  const key = await generateApiKey("live");
  const parsed = parseApiKey(key.plaintext);

  assert.ok(parsed);
  assert.equal(parsed.publicId, key.publicId);
  assert.equal(parsed.environment, "live");
  assert.equal(await hashSecret(parsed.secret), key.secretHash);

  // The stored hash must not contain the secret, and the plaintext must not be
  // recoverable from anything we keep.
  assert.ok(!key.secretHash.includes(parsed.secret));
  assert.notEqual(key.secretHash, parsed.secret);
});

test("keys are unique across generations", async () => {
  const keys = await Promise.all(Array.from({ length: 50 }, () => generateApiKey("live")));
  assert.equal(new Set(keys.map((k) => k.plaintext)).size, 50);
  assert.equal(new Set(keys.map((k) => k.publicId)).size, 50);
});

test("a key carries a recognisable prefix so a scanner can catch it", async () => {
  // A key that looks like a random string is one no secret scanner will find
  // in a public commit.
  const key = await generateApiKey("live");
  assert.ok(key.plaintext.startsWith("brg_live_"));
});

test("malformed keys are rejected without saying which part was wrong", () => {
  for (const bad of [
    "",
    "brg_live_short_x",
    "brg_live_a1b2c3d4e5f6g7h8", // no secret
    "wrong_live_a1b2c3d4_" + "b".repeat(24),
    "brg_prod_a1b2c3d4_" + "b".repeat(24), // unknown environment
    "brg_live_UPPERCASE_" + "b".repeat(24),
    "brg_live_" + "b".repeat(8) + "_" + "b".repeat(23), // secret one short
    "brg_live_" + "b".repeat(8) + "_" + "aeiou".repeat(5), // outside the alphabet
  ]) {
    assert.equal(parseApiKey(bad), null, `${JSON.stringify(bad)} parsed`);
  }
});

test("verification refuses revoked, expired and wrong-environment keys", async () => {
  const key = await generateApiKey("live");
  const now = 1_800_000_000;

  const base: StoredKey = {
    id: "key_1",
    organizationId: "org_1",
    publicId: key.publicId,
    secretHash: key.secretHash,
    environment: "live",
    revokedAt: null,
    expiresAt: null,
  };
  const lookup = (stored: StoredKey) => async () => stored;

  assert.equal((await verifyApiKey(key.plaintext, lookup(base), { environment: "live", now })).ok, true);

  const revoked = await verifyApiKey(key.plaintext, lookup({ ...base, revokedAt: now - 1 }), {
    environment: "live",
    now,
  });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.ok === false && revoked.reason, "revoked");

  const expired = await verifyApiKey(key.plaintext, lookup({ ...base, expiresAt: now - 1 }), {
    environment: "live",
    now,
  });
  assert.equal(expired.ok === false && expired.reason, "expired");

  // A live key presented to staging, and a staging key presented to live.
  const crossed = await verifyApiKey(key.plaintext, lookup(base), { environment: "test", now });
  assert.equal(crossed.ok === false && crossed.reason, "wrong_environment");

  const unknown = await verifyApiKey(key.plaintext, async () => undefined, { environment: "live", now });
  assert.equal(unknown.ok === false && unknown.reason, "unknown");
});

test("a key whose secret does not match its row is refused", async () => {
  const real = await generateApiKey("live");
  const other = await generateApiKey("live");
  const now = 1_800_000_000;

  // Right public id, wrong secret — the substitution an attacker who has seen
  // a key id in a log would try.
  const forged = `brg_live_${real.publicId}_${parseApiKey(other.plaintext)!.secret}`;
  const verdict = await verifyApiKey(
    forged,
    async () => ({
      id: "key_1",
      organizationId: "org_1",
      publicId: real.publicId,
      secretHash: real.secretHash,
      environment: "live" as const,
      revokedAt: null,
      expiresAt: null,
    }),
    { environment: "live", now }
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, "bad_secret");
});

test("constant-time comparison is still correct", () => {
  assert.ok(constantTimeEqual("abc", "abc"));
  assert.ok(!constantTimeEqual("abc", "abd"));
  assert.ok(!constantTimeEqual("abc", "ab"));
  assert.ok(!constantTimeEqual("", "a"));
  assert.ok(constantTimeEqual("", ""));
});

test("a masked key shows which key it is and nothing that authenticates", async () => {
  const key = await generateApiKey("live");
  const masked = maskApiKey(key.plaintext);
  const secret = parseApiKey(key.plaintext)!.secret;

  assert.ok(masked.includes(key.publicId), "a person must be able to tell which key this is");
  assert.ok(!masked.includes(secret), "the secret leaked into the mask");
  assert.equal(maskApiKey("garbage"), "brg_…");
});

// --------------------------------------------------------------- sessions ---

const session = (overrides: Partial<SessionState> = {}): SessionState => ({
  userId: "usr_1",
  organizationId: "org_1",
  createdAt: 1_800_000_000,
  expiresAt: 1_800_040_000,
  steppedUpAt: null,
  revokedAt: null,
  credentialVersion: 3,
  ...overrides,
});

test("a session is refused once expired, revoked, or issued before a rotation", () => {
  const now = 1_800_010_000;
  const context = { now, currentCredentialVersion: 3 };

  assert.equal(checkSession(session(), context).ok, true);

  const expired = checkSession(session({ expiresAt: now - 1 }), context);
  assert.equal(expired.ok === false && expired.reason, "expired");

  const revoked = checkSession(session({ revokedAt: now - 1 }), context);
  assert.equal(revoked.ok === false && revoked.reason, "revoked");

  // "Log out everywhere" is a button that does nothing without this.
  const stale = checkSession(session({ credentialVersion: 2 }), context);
  assert.equal(stale.ok === false && stale.reason, "stale_credential");

  // A session issued at the current version survives.
  assert.equal(checkSession(session({ credentialVersion: 3 }), context).ok, true);
});

test("step-up freshness is measured, and a never-stepped-up session is not fresh", () => {
  const now = 1_800_000_000;

  assert.equal(isStepUpFresh(session(), "destructive", now).fresh, false);
  assert.equal(isStepUpFresh(session({ steppedUpAt: now - 10 }), "destructive", now).fresh, true);
  assert.equal(
    isStepUpFresh(session({ steppedUpAt: now - STEP_UP_WINDOW_SECONDS.destructive - 1 }), "destructive", now).fresh,
    false
  );

  // Code execution has a tighter window than everything else.
  assert.ok(STEP_UP_WINDOW_SECONDS.code_execution < STEP_UP_WINDOW_SECONDS.destructive);
  const between = now - STEP_UP_WINDOW_SECONDS.code_execution - 1;
  assert.equal(isStepUpFresh(session({ steppedUpAt: between }), "destructive", now).fresh, true);
  assert.equal(isStepUpFresh(session({ steppedUpAt: between }), "code_execution", now).fresh, false);
});

test("a step-up timestamped in the future is not evidence", () => {
  // A clock problem or a forged value. Either way it is not proof somebody was
  // at the keyboard, and treating it as fresh would make it a bypass.
  const now = 1_800_000_000;
  assert.equal(isStepUpFresh(session({ steppedUpAt: now + 600 }), "destructive", now).fresh, false);
});

test("step-up is required for exactly the gated classes", () => {
  assert.equal(stepUpReasonForRiskClass("destructive"), "destructive");
  assert.equal(stepUpReasonForRiskClass("credential"), "destructive");
  assert.equal(stepUpReasonForRiskClass("code_execution"), "code_execution");
  for (const cls of ["safe_read", "sensitive_read", "content_write", "operational", "local"]) {
    assert.equal(stepUpReasonForRiskClass(cls), null, `${cls} should not need step-up`);
  }
});

test("revoking a user's sessions can keep the one doing the revoking", () => {
  const sessions = [session(), session(), session({ userId: "usr_2" }), session({ revokedAt: 1 })];
  const id = (s: SessionState) => `${s.userId}:${s.createdAt}:${sessions.indexOf(s)}`;

  const all = sessionsToRevoke(sessions, { userId: "usr_1" }, id);
  assert.equal(all.length, 2, "only usr_1's live sessions");

  // Logging somebody out mid-password-change trains them not to change it.
  const keeping = sessionsToRevoke(sessions, { userId: "usr_1", keepSessionId: id(sessions[0]!) }, id);
  assert.equal(keeping.length, 1);
});
