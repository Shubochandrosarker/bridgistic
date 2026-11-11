import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkSiteUrl } from "../src/url-guard.js";

/**
 * The Worker fetches whatever address a stranger types into the connect form,
 * so every case below is a request-forgery target rather than a formatting
 * nicety. Each block names the class of address it is closing off.
 */

const refuses = (raw: string) => {
  const result = checkSiteUrl(raw);
  assert.equal(result.ok, false, `expected ${raw} to be refused, got ${JSON.stringify(result)}`);
  assert.ok(result.reason && result.reason.length > 0, "a refusal must carry a reason the user can act on");
  assert.equal(result.origin, undefined, "a refused URL must not yield a usable origin");
};

const accepts = (raw: string, origin: string) => {
  const result = checkSiteUrl(raw);
  assert.equal(result.ok, true, `expected ${raw} to be accepted, got ${JSON.stringify(result)}`);
  assert.equal(result.origin, origin);
};

describe("url-guard: accepts real public WordPress addresses", () => {
  test("plain https origin", () => accepts("https://example.com", "https://example.com"));
  test("path and query are dropped", () => accepts("https://example.com/blog?x=1", "https://example.com"));
  test("subdomains", () => accepts("https://shop.example.co.uk", "https://shop.example.co.uk"));
  test("surrounding whitespace is trimmed", () => accepts("  https://example.com  ", "https://example.com"));
  test("host case is normalised", () => accepts("https://EXAMPLE.com", "https://example.com"));
  test("explicit default port collapses", () => accepts("https://example.com:443", "https://example.com"));
  test("punycode host", () => accepts("https://xn--bcher-kva.example", "https://xn--bcher-kva.example"));
});

describe("url-guard: scheme and transport", () => {
  test("http is refused", () => refuses("http://example.com"));
  test("file:// is refused", () => refuses("file:///etc/passwd"));
  test("gopher:// is refused", () => refuses("gopher://example.com"));
  test("ftp:// is refused", () => refuses("ftp://example.com"));
  test("javascript: is refused", () => refuses("javascript:alert(1)"));
  test("data: is refused", () => refuses("data:text/html,hi"));
  test("scheme-relative is refused", () => refuses("//example.com"));
  test("bare hostname is refused", () => refuses("example.com"));
});

describe("url-guard: loopback and localhost", () => {
  test("localhost", () => refuses("https://localhost"));
  test("localhost with port", () => refuses("https://localhost:8443"));
  test("127.0.0.1", () => refuses("https://127.0.0.1"));
  test("127.0.0.2 (all of 127/8)", () => refuses("https://127.0.0.2"));
  test("0.0.0.0", () => refuses("https://0.0.0.0"));
  test("IPv6 loopback", () => refuses("https://[::1]"));
  test("IPv6 unspecified", () => refuses("https://[::]"));
  test("expanded IPv6 loopback", () => refuses("https://[0:0:0:0:0:0:0:1]"));
  test("IPv4-mapped IPv6 loopback", () => refuses("https://[::ffff:127.0.0.1]"));
  test(".localhost suffix", () => refuses("https://site.localhost"));
});

describe("url-guard: private and reserved ranges", () => {
  test("10/8", () => refuses("https://10.1.2.3"));
  test("172.16/12 lower bound", () => refuses("https://172.16.0.1"));
  test("172.31/12 upper bound", () => refuses("https://172.31.255.254"));
  test("172.32 is outside 172.16/12 but still a bare IP", () => refuses("https://172.32.0.1"));
  test("192.168/16", () => refuses("https://192.168.1.1"));
  test("100.64/10 carrier-grade NAT", () => refuses("https://100.64.0.1"));
  test("unique-local IPv6 fc00::/7", () => refuses("https://[fd00::1]"));
  test("link-local IPv6 fe80::/10", () => refuses("https://[fe80::1]"));
  test("multicast", () => refuses("https://239.1.1.1"));
  test("broadcast", () => refuses("https://255.255.255.255"));
});

describe("url-guard: cloud metadata services", () => {
  // 169.254.169.254 is the single most valuable SSRF target in any cloud
  // environment: it hands out instance credentials to anything that asks.
  test("AWS/GCP/Azure IMDS by address", () => refuses("https://169.254.169.254/latest/meta-data/"));
  test("all of link-local 169.254/16", () => refuses("https://169.254.1.1"));
  test("GCP metadata by name", () => refuses("https://metadata.google.internal/computeMetadata/v1/"));
  test("bare metadata hostname", () => refuses("https://metadata"));
  test(".internal suffix", () => refuses("https://db.internal"));
});

describe("url-guard: obfuscated IPv4 forms", () => {
  // All four of these resolve to 127.0.0.1 but sail past a dotted-quad regex.
  test("bare decimal", () => refuses("https://2130706433"));
  test("bare hex", () => refuses("https://0x7f000001"));
  test("dotted octal", () => refuses("https://0177.0.0.1"));
  test("dotted hex", () => refuses("https://0x7f.0x0.0x0.0x1"));
  test("short form 127.1", () => refuses("https://127.1"));
});

describe("url-guard: credential and port tricks", () => {
  test("embedded credentials", () => refuses("https://user:pass@example.com"));
  test("credentials disguising an internal host", () => refuses("https://example.com@127.0.0.1"));
  test("username only", () => refuses("https://admin@example.com"));
  test("non-default port", () => refuses("https://example.com:8443"));
  test("common internal service port", () => refuses("https://example.com:6379"));
});

describe("url-guard: malformed input", () => {
  test("empty string", () => refuses(""));
  test("whitespace only", () => refuses("   "));
  test("not a URL", () => refuses("not a url"));
  test("hostname with no dot", () => refuses("https://intranet"));
  test("double dot in host", () => refuses("https://example..com"));
  test("leading hyphen", () => refuses("https://-example.com"));
  test("absurdly long input", () => refuses(`https://${"a".repeat(3000)}.com`));
});

describe("url-guard: allowInsecure escape hatch", () => {
  test("permits http and loopback only when explicitly asked", () => {
    const result = checkSiteUrl("http://localhost:80", true);
    assert.equal(result.ok, true);
  });

  test("is off by default, so request-handling code cannot reach it by accident", () => {
    assert.equal(checkSiteUrl("http://localhost:80").ok, false);
  });
});
