/**
 * Is this IP address one a server should refuse to talk to?
 *
 * Split out from the URL check because it has to run twice, on different
 * inputs: once on a literal a caller typed, and once on every address DNS
 * resolved a hostname to. The second is the one that matters for BR-005, and
 * it cannot share code with the first unless the address logic is separate
 * from the URL parsing.
 *
 * The policy is deny-by-default over the IANA special-purpose registries
 * rather than allow-by-default with a blocklist. A blocklist of "private"
 * ranges is a list somebody has to remember to update; anything unrecognised
 * should be refused, not permitted because nobody thought of it yet.
 */

export type AddressVerdict =
  | { readonly public: true }
  | { readonly public: false; readonly reason: string };

const PUBLIC: AddressVerdict = { public: true };

function reject(reason: string): AddressVerdict {
  return { public: false, reason };
}

/** Parse a dotted-quad into four octets, or null if it is not one. */
export function parseIpv4(host: string): readonly number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // "01" and "0x1" are not decimal octets. Node's parser and a WordPress
    // host's resolver may disagree about them, and where two parsers disagree
    // is where a bypass lives.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * IPv4 special-purpose ranges, from the IANA registry.
 *
 * Anything not explicitly global-reachable is refused.
 */
export function checkIpv4(host: string): AddressVerdict {
  const octets = parseIpv4(host);
  if (octets === null) return reject("not a well-formed IPv4 address");
  const [a, b, c] = octets as [number, number, number, number];

  if (a === 0) return reject("0.0.0.0/8 — this network");
  if (a === 10) return reject("10.0.0.0/8 — private");
  if (a === 127) return reject("127.0.0.0/8 — loopback");
  if (a === 100 && b >= 64 && b <= 127) return reject("100.64.0.0/10 — carrier-grade NAT");
  // 169.254.169.254 is the cloud metadata address on AWS, GCP, Azure, Oracle
  // and DigitalOcean. Reaching it from a server usually returns credentials.
  if (a === 169 && b === 254) return reject("169.254.0.0/16 — link-local, including cloud metadata");
  if (a === 172 && b >= 16 && b <= 31) return reject("172.16.0.0/12 — private");
  if (a === 192 && b === 0 && c === 0) return reject("192.0.0.0/24 — IETF protocol assignments");
  if (a === 192 && b === 0 && c === 2) return reject("192.0.2.0/24 — TEST-NET-1");
  if (a === 192 && b === 88 && c === 99) return reject("192.88.99.0/24 — 6to4 relay anycast");
  if (a === 192 && b === 168) return reject("192.168.0.0/16 — private");
  if (a === 198 && (b === 18 || b === 19)) return reject("198.18.0.0/15 — benchmarking");
  if (a === 198 && b === 51 && c === 100) return reject("198.51.100.0/24 — TEST-NET-2");
  if (a === 203 && b === 0 && c === 113) return reject("203.0.113.0/24 — TEST-NET-3");
  if (a >= 224 && a <= 239) return reject("224.0.0.0/4 — multicast");
  if (a >= 240) return reject("240.0.0.0/4 — reserved, including 255.255.255.255 broadcast");

  return PUBLIC;
}

/** Expand an IPv6 address to its eight 16-bit groups, or null if malformed. */
export function parseIpv6(raw: string): readonly number[] | null {
  let text = raw.trim().toLowerCase().replace(/^\[|\]$/g, "");

  // A zone index ("fe80::1%eth0") names a local interface by definition.
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  // A trailing IPv4 part ("::ffff:127.0.0.1") becomes two groups.
  const v4 = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const octets = parseIpv4(v4[1]!);
    if (octets === null) return null;
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, v4.index)}${high}:${low}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const piece of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };

  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;

  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

export function checkIpv6(raw: string): AddressVerdict {
  const groups = parseIpv6(raw);
  if (groups === null) return reject("not a well-formed IPv6 address");
  const [g0, g1] = groups as [number, number, ...number[]];

  if (groups.every((g) => g === 0)) return reject(":: — unspecified");
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return reject("::1 — loopback");

  // An IPv4-mapped or IPv4-compatible address wraps a v4 address; the wrapped
  // one decides. ::ffff:127.0.0.1 reaches the same place as 127.0.0.1, and a
  // check that only looks at the v6 form lets it through.
  const mapped = g0 === 0 && g1 === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0;
  if (mapped && (groups[5] === 0xffff || groups[5] === 0)) {
    const a = (groups[6]! >> 8) & 0xff;
    const b = groups[6]! & 0xff;
    const c = (groups[7]! >> 8) & 0xff;
    const d = groups[7]! & 0xff;
    const inner = checkIpv4(`${a}.${b}.${c}.${d}`);
    if (!inner.public) return reject(`IPv4-mapped address wrapping ${a}.${b}.${c}.${d} — ${inner.reason}`);
  }

  if ((g0 & 0xfe00) === 0xfc00) return reject("fc00::/7 — unique local");
  if ((g0 & 0xffc0) === 0xfe80) return reject("fe80::/10 — link-local");
  if ((g0 & 0xffc0) === 0xfec0) return reject("fec0::/10 — deprecated site-local");
  if (g0 === 0x2001 && (g1 & 0xff00) === 0x0000) return reject("2001:0000::/32 — Teredo");
  if (g0 === 0x2001 && g1 === 0x0db8) return reject("2001:db8::/32 — documentation");
  if (g0 === 0x2002) return reject("2002::/16 — 6to4");
  if ((g0 & 0xff00) === 0xff00) return reject("ff00::/8 — multicast");

  return PUBLIC;
}

/** Judge any literal address, v4 or v6. */
export function checkAddress(address: string): AddressVerdict {
  const text = address.trim();
  if (text.includes(":") || text.startsWith("[")) return checkIpv6(text);
  return checkIpv4(text);
}
