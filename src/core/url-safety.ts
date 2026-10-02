import { isIP } from "node:net";

// Address and URL safety for monitored endpoints (SP-02.3).
// The same functions run twice: when a service is saved, and again by the worker
// when it connects, because a host name can resolve somewhere else later.

type Cidr4 = readonly [base: string, bits: number, name: string];

// IPv4 ranges that must never be contacted.
const FORBIDDEN_V4: readonly Cidr4[] = [
  ["0.0.0.0", 8, "this network"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "carrier-grade NAT"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local, includes the cloud metadata address"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.0.2.0", 24, "documentation"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 3, "multicast, reserved and broadcast"],
];

function v4ToInt(ip: string): number {
  const [a = 0, b = 0, c = 0, d = 0] = ip.split(".").map(Number);
  return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
}

function inCidr4(ip: number, base: string, bits: number): boolean {
  const shift = 32 - bits;
  return ip >>> shift === v4ToInt(base) >>> shift;
}

function isForbiddenV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return FORBIDDEN_V4.some(([base, bits]) => inCidr4(n, base, bits));
}

/** Expands an IPv6 address to its eight 16-bit groups, or null if it is malformed. */
function parseV6(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);

  // A trailing dotted IPv4 part becomes two groups.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = tail.split(".").map(Number);
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...rest];
  }
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : Number.NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

function embeddedV4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function isForbiddenV6(g: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  // ::/96 covers the unspecified address (::), loopback (::1) and old IPv4-compatible forms
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
  // ::ffff:0:0/96, an IPv4 address carried inside IPv6
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return isForbiddenV4(embeddedV4(g6, g7));
  // 64:ff9b::/96, NAT64: judged by the IPv4 address it carries
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isForbiddenV4(embeddedV4(g6, g7));
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  // 2002::/16, 6to4: judged by the IPv4 address it carries
  if (g0 === 0x2002) return isForbiddenV4(embeddedV4(g1, g2));
  if (g0 === 0x2001 && g1 === 0) return true; // 2001::/32 Teredo
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** True when the address must never be contacted. Anything that is not a valid IP address is refused. */
export function isForbiddenIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isForbiddenV4(ip);
  if (kind === 6) {
    const groups = parseV6(ip);
    return groups === null ? true : isForbiddenV6(groups);
  }
  return true;
}

export function stripBrackets(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "");
}

const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".localdomain", ".home.arpa"];

export interface UrlCheck {
  url: URL | null;
  issues: string[];
}

/**
 * Syntax and literal-host checks for a service URL. Whether a host name resolves to a safe
 * address is checked separately, because DNS lookups are asynchronous.
 * `new URL()` normalises numeric host forms (2130706433, 0x7f000001, 0177.0.0.1, 127.1) to dotted
 * decimal, so those spellings of 127.0.0.1 are caught by the same IP check.
 */
export function checkServiceUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { url: null, issues: ["is not a valid URL"] };
  }
  const issues: string[] = [];
  if (url.protocol !== "http:" && url.protocol !== "https:") issues.push("must use http or https");
  if (url.username || url.password) issues.push("must not contain credentials");

  const host = stripBrackets(url.hostname).toLowerCase().replace(/\.$/, "");
  if (!host) {
    issues.push("must include a host");
  } else if (isIP(host)) {
    if (isForbiddenIp(host)) issues.push("host is a private, loopback or link-local address");
  } else if (host === "localhost" || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) {
    issues.push("host is not publicly routable");
  } else if (!host.includes(".")) {
    issues.push("host must be a public domain name");
  }
  return { url, issues };
}
