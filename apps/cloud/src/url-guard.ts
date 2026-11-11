/**
 * SSRF guard for the one place this Worker takes a URL from a stranger.
 *
 * `/authorize` accepts a site address typed into a form and then makes
 * server-side requests to it: the OAuth token exchange, and afterwards every
 * signed MCP tool call. Without validation that is a request-forgery primitive
 * pointed at whatever the Worker can reach - and Cloudflare Workers can reach
 * plenty, including a customer's own origin via a `*.workers.dev`-adjacent
 * route or a private address if the zone is fronting one.
 *
 * The policy is deliberately narrow: public, https, default port, no
 * credentials, no IP literals at all. A production WordPress install has a
 * hostname; anything reaching for a raw address is either misconfigured or
 * probing, and both deserve the same answer.
 *
 * Note on DNS rebinding: a hostname that resolves to a private address at
 * fetch time cannot be caught here, because Workers cannot resolve a name
 * before fetching it. That residual risk is documented in
 * docs/CLOUD_CONNECTOR.md rather than papered over.
 */

/** Human-readable reason a URL was refused; safe to show a user. */
export type UrlRejection = string;

export interface UrlCheck {
  ok: boolean;
  /** Normalised origin (scheme + host, no trailing slash) when ok. */
  origin?: string;
  reason?: UrlRejection;
}

/** Hostnames that always mean "this machine" regardless of DNS. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  // Cloud metadata services, by name.
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

/** Suffixes that only ever resolve inside a private network. */
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".localdomain"];

function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Decimal, octal, and hex forms of an IPv4 address ("2130706433",
 * "0177.0.0.1", "0x7f000001") all resolve to the same place as the dotted
 * form but sail past a dotted-quad regex, so they are matched separately.
 */
function isObfuscatedIpv4(host: string): boolean {
  if (/^\d+$/.test(host)) return true; // bare decimal
  if (/^0x[0-9a-f]+$/i.test(host)) return true; // bare hex
  // Any dotted form whose parts are octal or hex rather than plain decimal.
  if (/^(0[0-7]*|0x[0-9a-f]+|\d+)(\.(0[0-7]*|0x[0-9a-f]+|\d+)){1,3}$/i.test(host)) {
    return host.split(".").some((part) => /^0[0-7]+$/.test(part) || /^0x/i.test(part));
  }
  return false;
}

/** RFC1918 + loopback + link-local + carrier-grade NAT + broadcast/metadata. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // malformed dotted-quad: refuse rather than guess
  }
  const [a, b] = parts;

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast

  return false;
}

/** Loopback, unique-local, link-local, and IPv4-mapped IPv6. */
function isPrivateIpv6(host: string): boolean {
  // URL parsing leaves IPv6 hosts bracketed.
  const raw = host.replace(/^\[|\]$/g, "").toLowerCase();

  if (raw === "::1" || raw === "::" || raw === "0:0:0:0:0:0:0:1") return true;
  if (raw.startsWith("fe80") || raw.startsWith("fec0")) return true; // link-local / site-local
  if (/^f[cd][0-9a-f]{2}:/.test(raw)) return true; // fc00::/7 unique-local

  // ::ffff:127.0.0.1 and ::127.0.0.1 wrap an IPv4 address; judge the wrapped one.
  const mapped = raw.match(/(?:^::ffff:|^::)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);

  return false;
}

/**
 * Validate a user-supplied WordPress site address.
 *
 * @param raw          Address as typed.
 * @param allowInsecure Permit http:// and private hosts. Only ever true in
 *                      local development, never from request-handling code.
 */
export function checkSiteUrl(raw: string, allowInsecure = false): UrlCheck {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { ok: false, reason: "Enter your WordPress site address." };
  }
  if (trimmed.length > 2000) {
    return { ok: false, reason: "That address is too long to be a site URL." };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "That is not a valid web address. Include https:// at the start." };
  }

  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) {
    return { ok: false, reason: "The site address must start with https:// — Bridgistic will not send signed credentials over an unencrypted connection." };
  }

  if (url.username || url.password) {
    return { ok: false, reason: "Remove the username/password from the address. Bridgistic authorises through your WordPress admin, not the URL." };
  }

  // A non-default port is how a proxied internal service is usually reached;
  // a public WordPress install is on 443.
  if (url.port && url.port !== "443" && !(allowInsecure && url.port === "80")) {
    return { ok: false, reason: "Use the site's normal https address without a custom port." };
  }

  const host = url.hostname.toLowerCase();

  if (allowInsecure) {
    return { ok: true, origin: url.origin };
  }

  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, reason: "That address points at a private or local network, which the cloud connector cannot reach. Use the site's public address." };
  }

  if (host.startsWith("[")) {
    if (isPrivateIpv6(host)) {
      return { ok: false, reason: "That address points at a private or local network, which the cloud connector cannot reach. Use the site's public address." };
    }
    return { ok: false, reason: "Enter the site's domain name rather than a raw IP address." };
  }

  if (isIpv4Literal(host)) {
    if (isPrivateIpv4(host)) {
      return { ok: false, reason: "That address points at a private or local network, which the cloud connector cannot reach. Use the site's public address." };
    }
    return { ok: false, reason: "Enter the site's domain name rather than a raw IP address." };
  }

  if (isObfuscatedIpv4(host)) {
    return { ok: false, reason: "Enter the site's domain name rather than a raw IP address." };
  }

  // A hostname with no dot cannot be a public FQDN; it is an intranet name.
  if (!host.includes(".")) {
    return { ok: false, reason: "Enter the site's full public domain, for example https://example.com." };
  }

  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith("-") || host.endsWith("-") || host.includes("..")) {
    return { ok: false, reason: "That domain name is not valid." };
  }

  return { ok: true, origin: url.origin };
}
