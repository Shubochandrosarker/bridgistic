/**
 * OAuth 2.1, PKCE, and the site connection state machine.
 *
 * Weighted heavily toward refusals. Every accepted-when-it-should-not-be case
 * here is an account takeover or a site takeover.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateCodeVerifier,
  deriveCodeChallenge,
  isValidCodeVerifier,
  isValidCodeChallenge,
  verifyCodeChallenge,
  generateOpaqueToken,
  isRegisteredRedirectUri,
  verifyAuthorizationCode,
} from "../src/pkce.ts";
import type { AuthorizationCodeRecord } from "../src/pkce.ts";
import {
  canTransition,
  verifyConnection,
  claimConnection,
  isSiteUsable,
  canTransferSite,
  planRotation,
  canClaimMigratedSite,
  CONNECTION_STATES,
} from "../src/site-connection.ts";
import type { Connection, ConnectionState } from "../src/site-connection.ts";

// ------------------------------------------------------------------- PKCE ---

test("a generated pair verifies, and the shapes match RFC 7636", async () => {
  const verifier = generateCodeVerifier();
  const challenge = await deriveCodeChallenge(verifier);

  assert.ok(isValidCodeVerifier(verifier), `verifier out of spec: ${verifier}`);
  assert.ok(isValidCodeChallenge(challenge), `challenge out of spec: ${challenge}`);
  assert.equal((await verifyCodeChallenge(verifier, challenge, "S256")).ok, true);
});

test("verifiers are unpredictable", () => {
  const seen = new Set(Array.from({ length: 200 }, () => generateCodeVerifier()));
  assert.equal(seen.size, 200);
  assert.equal(new Set(Array.from({ length: 200 }, () => generateOpaqueToken())).size, 200);
});

test("the plain method is refused, whatever the client asks for", async () => {
  // `plain` sends the verifier as the challenge, which is the same as having
  // no PKCE at all. OAuth 2.1 drops it. Accepting it "for compatibility" means
  // an attacker who intercepts the code simply presents plain.
  const verifier = generateCodeVerifier();
  const plainAttack = await verifyCodeChallenge(verifier, verifier, "plain");
  assert.equal(plainAttack.ok, false);
  assert.equal(plainAttack.ok === false && plainAttack.reason, "unsupported_method");

  for (const method of ["", "s256", "S512", "none", "PLAIN"]) {
    const verdict = await verifyCodeChallenge(verifier, await deriveCodeChallenge(verifier), method);
    assert.equal(verdict.ok, false, `method "${method}" was accepted`);
  }
});

test("a wrong verifier does not verify", async () => {
  const challenge = await deriveCodeChallenge(generateCodeVerifier());
  const other = generateCodeVerifier();
  const verdict = await verifyCodeChallenge(other, challenge, "S256");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, "mismatch");
});

test("malformed verifiers and challenges are refused before comparison", async () => {
  const challenge = await deriveCodeChallenge(generateCodeVerifier());

  for (const bad of ["", "short", "a".repeat(42), "a".repeat(129), "has spaces in it".padEnd(50, "x"), "+/=".padEnd(50, "a")]) {
    const verdict = await verifyCodeChallenge(bad, challenge, "S256");
    assert.equal(verdict.ok, false, `verifier ${JSON.stringify(bad.slice(0, 20))} accepted`);
  }

  const verifier = generateCodeVerifier();
  for (const bad of ["", "a".repeat(42), "a".repeat(44), "not+base64url/at=all"]) {
    const verdict = await verifyCodeChallenge(verifier, bad, "S256");
    assert.equal(verdict.ok, false, `challenge ${JSON.stringify(bad)} accepted`);
  }
});

// --------------------------------------------------------- redirect URIs ----

test("redirect URIs match exactly, not by prefix or origin", () => {
  const registered = ["https://app.example.com/callback"];

  assert.ok(isRegisteredRedirectUri("https://app.example.com/callback", registered));

  // Every one of these has been a real account-takeover bug somewhere.
  for (const attack of [
    "https://app.example.com/callback/../../evil",
    "https://app.example.com/callback/extra",
    "https://app.example.com/callback?next=https://evil.test",
    "https://app.example.com/callback#@evil.test",
    "https://app.example.com.evil.test/callback",
    "https://evil.test/app.example.com/callback",
    "http://app.example.com/callback",
    "https://app.example.com:8443/callback",
    "https://APP.EXAMPLE.COM/callback",
    "//app.example.com/callback",
    "https://app.example.com/Callback",
  ]) {
    assert.ok(!isRegisteredRedirectUri(attack, registered), `${attack} was accepted`);
  }
});

test("loopback redirects may vary only their port, per RFC 8252", () => {
  // A native client's port is assigned at runtime and cannot be registered in
  // advance. Everything else about the URI must still match.
  const registered = ["http://127.0.0.1:1234/callback"];

  assert.ok(isRegisteredRedirectUri("http://127.0.0.1:49152/callback", registered));
  assert.ok(isRegisteredRedirectUri("http://127.0.0.1:1234/callback", registered));

  assert.ok(!isRegisteredRedirectUri("http://127.0.0.1:49152/other", registered), "path must match");
  assert.ok(!isRegisteredRedirectUri("http://127.0.0.2:49152/callback", registered), "host must match");
  assert.ok(
    !isRegisteredRedirectUri("http://localhost:49152/callback", registered),
    "the literal address, not a name that could resolve anywhere"
  );
  assert.ok(
    !isRegisteredRedirectUri("http://evil.test:49152/callback", ["http://evil.test:1234/callback"]),
    "the port concession is loopback-only"
  );
});

// ----------------------------------------------------- authorization code ---

const codeRecord = (overrides: Partial<AuthorizationCodeRecord> = {}): AuthorizationCodeRecord => ({
  code: "code-1",
  clientId: "client-1",
  redirectUri: "https://app.example.com/callback",
  codeChallenge: "",
  codeChallengeMethod: "S256",
  userId: "usr_1",
  organizationId: "org_1",
  scopes: ["posts:read"],
  createdAt: 1_800_000_000,
  expiresAt: 1_800_000_060,
  redeemedAt: null,
  ...overrides,
});

test("a correct token exchange succeeds", async () => {
  const verifier = generateCodeVerifier();
  const record = codeRecord({ codeChallenge: await deriveCodeChallenge(verifier) });

  const verdict = await verifyAuthorizationCode(
    { clientId: "client-1", redirectUri: "https://app.example.com/callback", codeVerifier: verifier },
    record,
    1_800_000_030
  );
  assert.equal(verdict.ok, true);
});

test("every term of the exchange is compared against what was recorded", async () => {
  const verifier = generateCodeVerifier();
  const challenge = await deriveCodeChallenge(verifier);
  const now = 1_800_000_030;
  const good = { clientId: "client-1", redirectUri: "https://app.example.com/callback", codeVerifier: verifier };

  const cases: [string, Parameters<typeof verifyAuthorizationCode>[0], AuthorizationCodeRecord | undefined, string][] = [
    ["an unknown code", good, undefined, "unknown_code"],
    ["a code presented by another client", { ...good, clientId: "client-2" }, codeRecord({ codeChallenge: challenge }), "client_mismatch"],
    [
      "a different redirect URI than the one used at authorize",
      { ...good, redirectUri: "https://app.example.com/other" },
      codeRecord({ codeChallenge: challenge }),
      "redirect_uri_mismatch",
    ],
    ["a wrong verifier", { ...good, codeVerifier: generateCodeVerifier() }, codeRecord({ codeChallenge: challenge }), "mismatch"],
    ["an expired code", good, codeRecord({ codeChallenge: challenge, expiresAt: now - 1 }), "expired"],
    ["a code already redeemed", good, codeRecord({ codeChallenge: challenge, redeemedAt: now - 1 }), "already_redeemed"],
  ];

  for (const [label, presented, record, expected] of cases) {
    const verdict = await verifyAuthorizationCode(presented, record, now);
    assert.equal(verdict.ok, false, `${label} was accepted`);
    assert.equal(verdict.ok === false && verdict.reason, expected, label);
  }
});

test("replay is reported distinctly from every other failure", async () => {
  // A second redemption means the code leaked or the client is broken. In the
  // first case the attacker already has a token, so the caller must be able to
  // tell this apart and revoke — treating it as a benign retry is the bug.
  const verifier = generateCodeVerifier();
  const record = codeRecord({
    codeChallenge: await deriveCodeChallenge(verifier),
    redeemedAt: 1_800_000_010,
  });
  const verdict = await verifyAuthorizationCode(
    { clientId: "client-1", redirectUri: "https://app.example.com/callback", codeVerifier: verifier },
    record,
    1_800_000_030
  );
  assert.equal(verdict.ok === false && verdict.reason, "already_redeemed");
});

// ------------------------------------------------- site connection machine --

const connection = (overrides: Partial<Connection> = {}): Connection => ({
  id: "con_1",
  organizationId: "org_1",
  siteUrl: "https://shop.example",
  state: "pending",
  createdAt: 1_800_000_000,
  expiresAt: 1_800_000_600,
  verifiedAt: null,
  claimedAt: null,
  siteId: null,
  ...overrides,
});

test("the transition table is an allowlist, and terminal states are terminal", () => {
  assert.ok(canTransition("pending", "verified"));
  assert.ok(canTransition("verified", "claimed"));

  // Cannot skip verification.
  assert.ok(!canTransition("pending", "claimed"));
  // Cannot go back and re-use a challenge.
  assert.ok(!canTransition("verified", "pending"));

  for (const terminal of ["claimed", "expired", "abandoned"] as ConnectionState[]) {
    for (const to of CONNECTION_STATES) {
      assert.ok(!canTransition(terminal, to), `${terminal} → ${to} should be refused`);
    }
  }
});

test("a challenge cannot be verified twice or after expiry", () => {
  const now = 1_800_000_300;

  assert.equal(verifyConnection(connection(), now).ok, true);

  const twice = verifyConnection(connection({ state: "verified" }), now);
  assert.equal(twice.ok, false);
  assert.match(twice.ok === false ? twice.reason : "", /already been verified/);

  // Checked at the transition rather than by a sweeper: a late sweeper is a
  // window in which an expired challenge still works.
  const expired = verifyConnection(connection({ expiresAt: now - 1 }), now);
  assert.equal(expired.ok, false);
  assert.match(expired.ok === false ? expired.reason : "", /expired/);
});

test("claiming requires verification, permission, headroom, and an unclaimed URL", () => {
  const base = {
    now: 1_800_000_300,
    actorMayConnect: true,
    currentSiteCount: 1,
    sitesMax: 3,
    urlAlreadyConnected: false,
  };
  const verified = connection({ state: "verified" });

  assert.equal(claimConnection(verified, base).ok, true);

  assert.equal(claimConnection(connection(), base).ok, false, "unverified");
  assert.equal(claimConnection(verified, { ...base, actorMayConnect: false }).ok, false, "no permission");

  const atLimit = claimConnection(verified, { ...base, currentSiteCount: 3 });
  assert.equal(atLimit.ok, false);
  assert.match(atLimit.ok === false ? atLimit.reason : "", /plan allows 3 sites/);

  // Connecting a site somebody else already has must not silently take it.
  const taken = claimConnection(verified, { ...base, urlAlreadyConnected: true });
  assert.equal(taken.ok, false);
  assert.match(taken.ok === false ? taken.reason : "", /transfer it/i);

  // Unlimited plans have no ceiling.
  assert.equal(claimConnection(verified, { ...base, currentSiteCount: 900, sitesMax: null }).ok, true);
});

test("a claimed site is not usable until it has been granted something", () => {
  // The correct default: connected, and authorised for nothing.
  const connected = { state: "connected" as const, grantCount: 0, hasLiveCredential: true };
  const verdict = isSiteUsable(connected);
  assert.equal(verdict.usable, false);
  assert.match(verdict.reason ?? "", /no permissions granted/);

  assert.equal(isSiteUsable({ ...connected, grantCount: 2 }).usable, true);
  assert.equal(isSiteUsable({ ...connected, grantCount: 2, hasLiveCredential: false }).usable, false);
  assert.equal(isSiteUsable({ state: "suspended", grantCount: 2, hasLiveCredential: true }).usable, false);
  assert.equal(isSiteUsable({ state: "disconnected", grantCount: 2, hasLiveCredential: true }).usable, false);
});

test("transfer needs permission on BOTH sides and refuses work in flight", () => {
  const base = {
    now: 1_800_000_000,
    actorMayTransferFromSource: true,
    actorMayConnectToTarget: true,
    siteState: "connected" as const,
    targetSiteCount: 1,
    targetSitesMax: 5,
    hasPendingApprovals: false,
    hasRunningJobs: false,
  };

  assert.equal(canTransferSite(base).ok, true);

  // Source-only permission would let somebody push a site and its credential
  // into an organization that never agreed to hold it.
  const pushed = canTransferSite({ ...base, actorMayConnectToTarget: false });
  assert.equal(pushed.ok, false);
  assert.match(pushed.reason ?? "", /both sides/);

  assert.equal(canTransferSite({ ...base, actorMayTransferFromSource: false }).ok, false);

  // A transfer mid-approval leaves it to be decided by people who cannot see
  // what it does.
  const pending = canTransferSite({ ...base, hasPendingApprovals: true });
  assert.equal(pending.ok, false);
  assert.match(pending.reason ?? "", /awaiting a decision/);

  assert.equal(canTransferSite({ ...base, hasRunningJobs: true }).ok, false);
  assert.equal(canTransferSite({ ...base, siteState: "suspended" }).ok, false);
  assert.equal(canTransferSite({ ...base, targetSiteCount: 5 }).ok, false);
});

test("rotation invalidates grants bound to the old credential and keeps scope grants", () => {
  const effect = planRotation(3, ["grant_a", "grant_b"]);

  assert.equal(effect.newVersion, 4);
  assert.equal(effect.retiredVersion, 3);
  // A grant is consent to a specific key. Re-pointing it at a new one is a
  // decision the person who granted it did not make.
  assert.deepEqual(effect.invalidatedGrantIds, ["grant_a", "grant_b"]);
  // Scope grants are the organization's policy, not the key's, so they survive.
  assert.equal(effect.scopeGrantsPreserved, true);
  assert.equal(effect.siteUnavailableDuringSwap, true);
});

test("a migrated site goes through a claim, and an owned one goes through transfer", () => {
  const now = 1_800_000_000;
  const base = { siteHasOwnerOrganization: false, claimVerified: true, claimExpiresAt: now + 600, now };

  assert.equal(canClaimMigratedSite(base).ok, true);

  const owned = canClaimMigratedSite({ ...base, siteHasOwnerOrganization: true });
  assert.equal(owned.ok, false);
  assert.match(owned.reason ?? "", /transfer/);

  assert.equal(canClaimMigratedSite({ ...base, claimVerified: false }).ok, false);
  assert.equal(canClaimMigratedSite({ ...base, claimExpiresAt: now - 1 }).ok, false);
});
