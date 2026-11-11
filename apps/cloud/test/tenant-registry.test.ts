/**
 * Tests for src/tenant-registry.ts - TenantRegistry.resolve() must always
 * return the single bound connection regardless of the `alias` argument
 * passed in, per its own docblock: "Every OAuth grant here is scoped to
 * exactly one WordPress site ... simpler by construction, since 'which
 * site' was already decided at connect time, not per call."
 *
 * Run: npx tsx --test test/tenant-registry.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TenantRegistry } from "../src/tenant-registry.js";
import type { Connection } from "../src/types.js";

const CONNECTION: Connection = {
  alias: "default",
  siteUrl: "https://example.com",
  keyId: "k_abc123",
  secret: "s_very_secret_value",
};

describe("TenantRegistry.resolve", () => {
  test("returns the bound connection when called with no alias", () => {
    const registry = new TenantRegistry(CONNECTION);
    assert.deepEqual(registry.resolve(), CONNECTION);
  });

  test("returns the bound connection when called with undefined", () => {
    const registry = new TenantRegistry(CONNECTION);
    assert.deepEqual(registry.resolve(undefined), CONNECTION);
  });

  test("returns the SAME bound connection regardless of the alias argument", () => {
    const registry = new TenantRegistry(CONNECTION);
    for (const alias of ["", "default", "some-other-site", "guns2ammo", "🙃", "null", "__proto__"]) {
      assert.deepEqual(registry.resolve(alias), CONNECTION);
    }
  });

  test("resolve() is not affected by an alias that matches nothing about the connection", () => {
    const registry = new TenantRegistry(CONNECTION);
    const resolved = registry.resolve("this-alias-does-not-exist-anywhere");
    assert.equal(resolved.siteUrl, CONNECTION.siteUrl);
    assert.equal(resolved.keyId, CONNECTION.keyId);
    assert.equal(resolved.secret, CONNECTION.secret);
  });
});

describe("TenantRegistry.list", () => {
  test("returns exactly one entry describing the bound connection", () => {
    const registry = new TenantRegistry(CONNECTION);
    const list = registry.list();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], { alias: CONNECTION.alias, siteUrl: CONNECTION.siteUrl });
  });

  test("reflects whatever alias/siteUrl the connection was constructed with", () => {
    const other: Connection = { alias: "my-site", siteUrl: "https://my-site.test", keyId: "k", secret: "s" };
    const registry = new TenantRegistry(other);
    assert.deepEqual(registry.list(), [{ alias: "my-site", siteUrl: "https://my-site.test" }]);
  });
});
