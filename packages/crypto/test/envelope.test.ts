/**
 * The compatibility half of this file is the important half.
 *
 * `engine-fixtures.json` was produced by the PINNED ENGINE's own
 * `cloud/src/crypto.ts` — not by the implementation under test. If these stop
 * decrypting, every credential already in the `tenants` table has become
 * unreadable, and the only recovery is asking every customer to reconnect.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encryptSecret, decryptSecret, isEnvelope, envelopeVersion, reseal } from "../src/envelope.ts";

const fixtures = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "engine-fixtures.json"), "utf8")
) as {
  key: string;
  cases: { plaintext: string; envelope: string }[];
  v1Case: { plaintext: string; envelope: string };
};

const KEY = fixtures.key;
/** A second, different key. Same shape, no relationship to the first. */
const OTHER_KEY = btoa("bridgistic-other-key-never-real!");

// ------------------------------------------------- compatibility (the point)

test("every envelope the engine wrote still decrypts", async () => {
  for (const { plaintext, envelope } of fixtures.cases) {
    assert.equal(
      await decryptSecret(envelope, KEY),
      plaintext,
      `an envelope written by the pinned engine no longer decrypts: ${envelope.slice(0, 40)}…`
    );
  }
});

test("the empty string round-trips as itself, not as absent", async () => {
  // An empty secret and a missing secret must not be the same value. If they
  // collapse, "this site has no credential" and "this site's credential is
  // empty" become one case, and only one of them is safe.
  const empty = fixtures.cases.find((c) => c.plaintext === "");
  assert.ok(empty);
  assert.equal(await decryptSecret(empty.envelope, KEY), "");
});

test("unicode survives the round trip byte for byte", async () => {
  const unicode = fixtures.cases.find((c) => c.plaintext.includes("🔐"));
  assert.ok(unicode);
  assert.equal(await decryptSecret(unicode.envelope, KEY), unicode.plaintext);
});

test("v1 untagged envelopes still decrypt", async () => {
  // Rows written before the version prefix existed. They are silently upgraded
  // when re-encrypted, but until then they have to keep working.
  assert.equal(envelopeVersion(fixtures.v1Case.envelope), 1);
  assert.equal(await decryptSecret(fixtures.v1Case.envelope, KEY), fixtures.v1Case.plaintext);
});

// ------------------------------------------------------------ round trip ----

test("what we write, we can read", async () => {
  for (const plaintext of ["", "a", "wpk_live_" + "x".repeat(64), "🔐", "x".repeat(10_000)]) {
    const sealed = await encryptSecret(plaintext, KEY);
    assert.equal(await decryptSecret(sealed, KEY), plaintext);
    assert.equal(envelopeVersion(sealed), 2, "new writes are v2");
  }
});

test("the IV is fresh every time, so the same secret never seals identically", async () => {
  // A reused IV under one key leaks plaintext relationships and breaks GCM's
  // authentication outright. It is the single mistake that turns this from
  // encryption into obfuscation.
  const sealed = await Promise.all(Array.from({ length: 100 }, () => encryptSecret("same secret", KEY)));
  assert.equal(new Set(sealed).size, 100);

  const ivs = sealed.map((s) => s.split(".")[2]);
  assert.equal(new Set(ivs).size, 100, "an IV repeated across encryptions");
});

test("the plaintext never appears in the envelope", async () => {
  const secret = "wpk_secret_do_not_leak_me_please";
  const sealed = await encryptSecret(secret, KEY);
  assert.ok(!sealed.includes(secret));
  assert.ok(!atob(sealed.split(".")[3]!).includes(secret));
});

// ---------------------------------------------------------- tamper + keys ---

test("the wrong key does not decrypt, and does not return garbage either", async () => {
  const sealed = await encryptSecret("wpk_secret", KEY);
  await assert.rejects(() => decryptSecret(sealed, OTHER_KEY));
});

test("a tampered ciphertext or tag is rejected, never silently accepted", async () => {
  // GCM authenticates. A corrupted or forged row must throw rather than
  // produce something — "no secret stored" and "this row was tampered with"
  // lead to very different code paths.
  const sealed = await encryptSecret("wpk_secret_abcdef", KEY);
  const [prefix, algo, iv, ct] = sealed.split(".") as [string, string, string, string];

  const flip = (b64: string) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const at = Math.floor(bytes.length / 2);
    bytes[at] = (bytes[at] ?? 0) ^ 0x01;
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  };

  await assert.rejects(
    () => decryptSecret(`${prefix}.${algo}.${iv}.${flip(ct)}`, KEY),
    "a flipped ciphertext bit was accepted"
  );
  await assert.rejects(
    () => decryptSecret(`${prefix}.${algo}.${flip(iv)}.${ct}`, KEY),
    "a flipped IV bit was accepted"
  );
  // Truncating the GCM tag.
  await assert.rejects(() => decryptSecret(`${prefix}.${algo}.${iv}.${ct.slice(0, -4)}`, KEY));
});

test("malformed envelopes throw a shape error, not a crypto error", async () => {
  for (const bad of ["", "not-an-envelope", "v2.aes256gcm.onlyonepart", "v2.aes256gcm..", "a.b.c.d.e"]) {
    await assert.rejects(() => decryptSecret(bad, KEY), `${JSON.stringify(bad)} was accepted`);
  }
});

test("a bad key is refused with a reason that does not contain the key", async () => {
  for (const bad of ["", btoa("too short"), btoa("x".repeat(31)), btoa("x".repeat(33))]) {
    await assert.rejects(
      () => encryptSecret("x", bad),
      (error: Error) => {
        assert.match(error.message, /32 bytes|valid base64/);
        assert.ok(!error.message.includes(bad) || bad === "", "the key value reached the error message");
        return true;
      }
    );
  }
});

// ---------------------------------------------------------------- rotation --

test("reseal moves a secret between keys without widening its exposure", async () => {
  const sealed = await encryptSecret("wpk_rotate_me", KEY);
  const resealed = await reseal(sealed, KEY, OTHER_KEY);

  assert.equal(await decryptSecret(resealed, OTHER_KEY), "wpk_rotate_me");
  await assert.rejects(() => decryptSecret(resealed, KEY), "the old key still opens the resealed row");
  assert.notEqual(resealed, sealed);
});

test("reseal on a row the old key cannot open fails rather than producing an empty secret", async () => {
  // The rotation walk must stop on a row it cannot read. Writing an empty
  // credential over an unreadable one turns a recoverable problem into a
  // permanent one.
  const sealed = await encryptSecret("wpk_x", KEY);
  await assert.rejects(() => reseal(sealed, OTHER_KEY, KEY));
});

test("isEnvelope recognises shape without needing a key", () => {
  assert.ok(isEnvelope(fixtures.cases[0]!.envelope));
  assert.ok(isEnvelope(fixtures.v1Case.envelope));
  for (const bad of ["", "plaintext-secret", "v2.aes256gcm.short.x", "a.b.c"]) {
    assert.ok(!isEnvelope(bad), `${JSON.stringify(bad)} looked like an envelope`);
  }
});
