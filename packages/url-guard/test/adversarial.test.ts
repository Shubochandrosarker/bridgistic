/**
 * Adversarial tests for the SSRF boundary.
 *
 * Written as an attacker rather than as an author: the interesting cases are
 * the ones where a parser somewhere disagrees with a parser somewhere else,
 * because that disagreement is the whole bug class.
 *
 * Every payload here reaches a real target if it gets through.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSiteUrl } from "../src/url.ts";
import { checkAddress, checkIpv4, checkIpv6, parseIpv6 } from "../src/address.ts";
import { checkResolvesPublic } from "../src/resolve.ts";
import { checkSiteConnection } from "../src/index.ts";

const refused = (raw: string) => !checkSiteUrl(raw).ok;

// ------------------------------------------------------------ loopback ------

test("loopback, in every spelling anyone has tried", () => {
  for (const address of [
    "127.0.0.1",
    "127.0.0.2",
    "127.1.1.1",
    "0.0.0.0",
    "0.0.0.1",
  ]) {
    assert.equal(checkIpv4(address).public, false, `${address} was treated as public`);
  }

  for (const host of [
    "https://localhost/",
    "https://LOCALHOST/",
    "https://localhost.localdomain/",
    "https://ip6-localhost/",
    "https://anything.localhost/",
    "https://server.local/",
    "https://db.internal/",
    "https://box.lan/",
    "https://x.home.arpa/",
  ]) {
    assert.ok(refused(host), `${host} was accepted`);
  }
});

test("obfuscated IPv4 — decimal, octal, hex and short forms", () => {
  // Every one of these is 127.0.0.1 to a resolver, and none is a dotted quad.
  for (const host of [
    "https://2130706433/", // decimal
    "https://0x7f000001/", // hex
    "https://0177.0.0.1/", // octal first octet
    "https://127.1/", // short form
    "https://127.0.1/", // three-part short form
    "https://0x7f.0x0.0x0.0x1/", // hex per octet
    "https://017700000001/", // full octal
  ]) {
    assert.ok(refused(host), `${host} was accepted`);
  }
});

test("cloud metadata, by address and by name", () => {
  // 169.254.169.254 returns instance credentials on every major cloud.
  assert.equal(checkIpv4("169.254.169.254").public, false);
  assert.equal(checkIpv4("169.254.0.1").public, false);
  for (const host of [
    "https://metadata.google.internal/",
    "https://metadata/",
    "https://instance-data/",
    "https://metadata.goog/",
  ]) {
    assert.ok(refused(host), `${host} was accepted`);
  }
});

test("every RFC1918 range and the reserved blocks around them", () => {
  for (const address of [
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.255.255",
    "100.64.0.1", // carrier-grade NAT
    "198.18.0.1", // benchmarking
    "192.0.0.1", // IETF protocol assignments
    "192.0.2.1", // TEST-NET-1
    "198.51.100.1", // TEST-NET-2
    "203.0.113.1", // TEST-NET-3
    "192.88.99.1", // 6to4 relay anycast
    "224.0.0.1", // multicast
    "255.255.255.255", // broadcast
    "240.0.0.1", // reserved
  ]) {
    assert.equal(checkIpv4(address).public, false, `${address} was treated as public`);
  }

  // The addresses immediately outside those ranges must still be public, or
  // the guard is refusing real customers.
  for (const address of ["172.15.255.255", "172.32.0.1", "11.0.0.1", "100.63.255.255", "9.9.9.9", "8.8.8.8"]) {
    assert.equal(checkIpv4(address).public, true, `${address} was wrongly refused`);
  }
});

// ---------------------------------------------------------------- IPv6 ------

test("IPv6 loopback, link-local and unique-local", () => {
  for (const address of [
    "::1",
    "0:0:0:0:0:0:0:1",
    "::",
    "fe80::1",
    "FE80::1",
    "fe80::1%eth0", // zone index names a local interface by definition
    "fc00::1",
    "fd12:3456:789a::1",
    "fec0::1",
    "ff02::1", // multicast
    "2001:db8::1", // documentation
    "2002::1", // 6to4
  ]) {
    assert.equal(checkIpv6(address).public, false, `${address} was treated as public`);
  }

  for (const address of ["2606:4700:4700::1111", "2a00:1450:4009:815::200e"]) {
    assert.equal(checkIpv6(address).public, true, `${address} was wrongly refused`);
  }
});

test("IPv4-mapped IPv6 is judged by the address it wraps", () => {
  // ::ffff:127.0.0.1 reaches 127.0.0.1. A check that only looks at the v6 form
  // sees a normal-looking address and lets it through.
  for (const address of [
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "::127.0.0.1",
    "[::ffff:192.168.1.1]",
    "::ffff:7f00:1", // the same address written in hex
  ]) {
    assert.equal(checkIpv6(address).public, false, `${address} was treated as public`);
  }

  assert.equal(checkIpv6("::ffff:8.8.8.8").public, true, "a mapped public address is public");
});

test("IPv6 expansion is correct, so the range checks act on real values", () => {
  assert.deepEqual(parseIpv6("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(parseIpv6("fe80::1"), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(parseIpv6("2001:db8::"), [0x2001, 0x0db8, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(parseIpv6("::ffff:127.0.0.1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);

  // Malformed input must be null rather than a partially-parsed guess: a guess
  // becomes a range check against the wrong number.
  assert.equal(parseIpv6("1:2:3:4:5:6:7"), null, "too few groups");
  assert.equal(parseIpv6("1:2:3:4:5:6:7:8:9"), null, "too many groups");
  assert.equal(parseIpv6("1::2::3"), null, "two elisions");
  assert.equal(parseIpv6("12345::"), null, "group out of range");
  assert.equal(parseIpv6("gggg::"), null, "not hex");
});

// ------------------------------------------------------------- URL shape ----

test("credentials in the URL are refused", () => {
  // https://real-site.example@127.0.0.1/ reads as real-site.example to a human
  // skimming it, and connects to 127.0.0.1.
  assert.ok(refused("https://user:pass@example.com/"));
  assert.ok(refused("https://real-site.example@127.0.0.1/"));
  assert.ok(refused("https://admin@internal.example.com/"));
});

test("non-default ports are refused", () => {
  // A custom port is how a proxied internal service is normally reached.
  for (const host of ["https://example.com:8080/", "https://example.com:22/", "https://example.com:6379/"]) {
    assert.ok(refused(host), `${host} was accepted`);
  }
  assert.ok(checkSiteUrl("https://example.com:443/").ok, "the default port written out is fine");
});

test("non-https schemes are refused", () => {
  for (const raw of [
    "http://example.com/",
    "file:///etc/passwd",
    "ftp://example.com/",
    "gopher://example.com:70/_",
    "dict://example.com:2628/",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "jar:http://example.com!/",
  ]) {
    assert.ok(refused(raw), `${raw} was accepted`);
  }
});

test("whitespace, control characters and newline injection are refused", () => {
  for (const raw of [
    "https://example.com\n/",
    "https://example.com\r\nHost: internal",
    "https://exa mple.com/",
    "https://example.com /",
    "https://example.com\u0000/",
    "https://example\u007f.com/",
  ]) {
    assert.ok(refused(raw), `${JSON.stringify(raw)} was accepted`);
  }

  // Surrounding whitespace is trimmed rather than rejected: people paste
  // addresses with a stray space or newline, and refusing that is a support
  // ticket rather than a security control. What matters is that nothing
  // survives INSIDE the address.
  for (const raw of ["  https://example.com/  ", "\thttps://example.com/", "https://example.com/\n"]) {
    assert.ok(checkSiteUrl(raw).ok, `${JSON.stringify(raw)} should trim to a valid address`);
  }
});

test("malformed and oversized hostnames are refused", () => {
  assert.ok(refused(""));
  assert.ok(refused("   "));
  assert.ok(refused("not a url"));
  assert.ok(refused("https://"));
  assert.ok(refused("https://-leading.example.com/"));
  assert.ok(refused("https://trailing-.example.com/"));
  assert.ok(refused("https://double..dot.example.com/"));
  assert.ok(refused("https://.example.com/"));
  assert.ok(refused(`https://${"a".repeat(64)}.example.com/`), "label over 63 octets");
  assert.ok(refused(`https://${"a.".repeat(200)}example.com/`), "hostname over 253 octets");
  assert.ok(refused(`https://example.com/${"a".repeat(3000)}`), "over the length ceiling");
});

test("a bare hostname with no dot is refused", () => {
  assert.ok(refused("https://intranet/"));
  assert.ok(refused("https://wordpress/"));
});

test("a legitimate site address is accepted, with its origin normalised", () => {
  const result = checkSiteUrl("https://Example.COM/wp-admin/?x=1#frag");
  assert.equal(result.ok, true);
  assert.equal(result.origin, "https://example.com", "path, query and fragment are dropped");
  assert.equal(result.hostname, "example.com");

  for (const raw of [
    "https://shop.example.co.uk/",
    "https://my-site.example.com",
    "https://xn--bcher-kva.example",
  ]) {
    assert.ok(checkSiteUrl(raw).ok, `${raw} was wrongly refused`);
  }
});

// -------------------------------------------------- BR-005: DNS rebinding ---

/** A DoH stub returning the given addresses. */
function resolver(map: Record<string, { type: number; data: string }[]>) {
  return async (input: string): Promise<Response> => {
    const name = new URL(input).searchParams.get("name") ?? "";
    const type = Number(new URL(input).searchParams.get("type"));
    const answers = (map[name] ?? []).filter((a) => a.type === type);
    return new Response(JSON.stringify({ Status: 0, Answer: answers }), { status: 200 });
  };
}

test("BR-005: a public hostname resolving to a private address is refused", () => {
  // This is the whole finding. The URL parses cleanly — it is a normal domain
  // name — and it points at the inside of the network.
  return checkResolvesPublic("evil.example.com", {
    fetchImpl: resolver({ "evil.example.com": [{ type: 1, data: "10.0.0.5" }] }),
  }).then((result) => {
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /10\.0\.0\.5/);
    assert.match(result.reason ?? "", /private/);
  });
});

test("BR-005: one private address among several public ones still refuses", async () => {
  // A rebinding payload is usually a name with two records. Requiring EVERY
  // address to be public is the difference between catching that and not.
  const result = await checkResolvesPublic("split.example.com", {
    fetchImpl: resolver({
      "split.example.com": [
        { type: 1, data: "93.184.216.34" },
        { type: 1, data: "127.0.0.1" },
      ],
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /127\.0\.0\.1/);
});

test("BR-005: an AAAA record pointing inside is caught too", async () => {
  // Checking only A records is a bypass that costs one character to exploit.
  const result = await checkResolvesPublic("v6.example.com", {
    fetchImpl: resolver({
      "v6.example.com": [
        { type: 1, data: "93.184.216.34" },
        { type: 28, data: "::1" },
      ],
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /::1/);
});

test("a hostname that resolves entirely to public addresses is allowed", async () => {
  const result = await checkResolvesPublic("example.com", {
    fetchImpl: resolver({
      "example.com": [
        { type: 1, data: "93.184.216.34" },
        { type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" },
      ],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.addresses.length, 2);
});

test("resolution fails closed", async () => {
  // An SSRF guard that opens when the network is bad is one an attacker can
  // open by making the network bad.
  const cases: [string, Parameters<typeof checkResolvesPublic>[1]][] = [
    ["resolver throws", { fetchImpl: async () => { throw new Error("network down"); } }],
    ["resolver 500s", { fetchImpl: async () => new Response("", { status: 500 }) }],
    ["resolver returns HTML", { fetchImpl: async () => new Response("<html>", { status: 200 }) }],
    ["no records at all", { fetchImpl: resolver({}) }],
    [
      "resolver hangs",
      {
        fetchImpl: () => new Promise<Response>(() => {}),
        timeoutMs: 20,
      },
    ],
    [
      "answer section is not an array",
      { fetchImpl: async () => new Response(JSON.stringify({ Answer: "nope" }), { status: 200 }) },
    ],
    [
      "answer entries are malformed",
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ Answer: [{ type: "1", data: 42 }, null] }), { status: 200 }),
      },
    ],
  ];

  for (const [label, options] of cases) {
    const result = await checkResolvesPublic("example.com", options);
    assert.equal(result.ok, false, `${label}: resolution should have failed closed`);
    assert.ok(result.reason, `${label}: no reason given`);
  }
});

test("checkSiteConnection refuses at the parse step without spending a lookup", async () => {
  // Otherwise this endpoint is a way to make us resolve arbitrary names.
  let resolved = 0;
  const result = await checkSiteConnection("https://127.0.0.1/", {
    fetchImpl: async () => {
      resolved++;
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(resolved, 0, "a hopeless address must not cost a DNS lookup");
});

test("checkSiteConnection requires both layers to pass", async () => {
  const fetchImpl = resolver({ "good.example.com": [{ type: 1, data: "93.184.216.34" }] });

  const good = await checkSiteConnection("https://good.example.com/", { fetchImpl });
  assert.equal(good.ok, true);
  assert.equal(good.origin, "https://good.example.com");
  assert.deepEqual(good.addresses, ["93.184.216.34"]);

  const rebind = await checkSiteConnection("https://good.example.com/", {
    fetchImpl: resolver({ "good.example.com": [{ type: 1, data: "192.168.1.1" }] }),
  });
  assert.equal(rebind.ok, false, "parse passed, DNS did not — the connection is still refused");
});

test("a refusal names the address so the site owner can fix their DNS", async () => {
  // This is somebody's own hostname resolving to their own network. Telling
  // them "refused" without saying what resolved where turns a two-minute DNS
  // fix into a support ticket.
  const result = await checkSiteConnection("https://mysite.example/", {
    fetchImpl: resolver({ "mysite.example": [{ type: 1, data: "10.1.2.3" }] }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /mysite\.example resolves to 10\.1\.2\.3/);
});

test("checkAddress dispatches v4 and v6 correctly", () => {
  assert.equal(checkAddress("8.8.8.8").public, true);
  assert.equal(checkAddress("10.0.0.1").public, false);
  assert.equal(checkAddress("::1").public, false);
  assert.equal(checkAddress("[::1]").public, false);
  assert.equal(checkAddress("2606:4700::1111").public, true);
  assert.equal(checkAddress("not an address").public, false, "unparseable is refused, not assumed public");
});
