/**
 * IP pseudonymisation (AGENTS.md rule 1): only keyed HMAC-SHA256 hashes of the full address and of
 * its subnet (/24 for IPv4, /64 for IPv6) are ever stored. Plain addresses are only held in local
 * variables while processing.
 */
import { createHmac } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

export interface NormalizedIp {
  version: 4 | 6;
  /** Canonical text form: dotted IPv4, or fully expanded lowercase IPv6. */
  address: string;
  /** Canonical subnet: `a.b.c.0/24` or the first four IPv6 groups + `::/64`. */
  subnet: string;
}

export interface IpHashes {
  ipHash: Buffer;
  subnetHash: Buffer;
}

function expandIpv6(address: string): string[] | undefined {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);

  // Embedded IPv4 tail (e.g. ::ffff:192.0.2.1) → two hex groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (isIPv4(tail)) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 && missing !== 0) return undefined;
  if (missing < 0) return undefined;
  const groups = [...head, ...new Array<string>(missing).fill('0'), ...rest];
  return groups.map((g) => g.padStart(4, '0'));
}

/**
 * Validates and canonicalises an address so that different notations of the same address hash
 * identically. IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are treated as IPv4.
 */
export function normalizeIp(raw: string): NormalizedIp | undefined {
  const input = raw.trim().replace(/^\[|\]$/g, '');
  if (isIPv4(input)) {
    const parts = input.split('.').map(Number);
    return {
      version: 4,
      address: parts.join('.'),
      subnet: `${parts.slice(0, 3).join('.')}.0/24`,
    };
  }
  if (!isIPv6(input)) return undefined;
  const groups = expandIpv6(input);
  if (!groups) return undefined;
  const mapped = groups.slice(0, 5).every((g) => g === '0000') && groups[5] === 'ffff';
  if (mapped) {
    const hi = parseInt(groups[6] ?? '0', 16);
    const lo = parseInt(groups[7] ?? '0', 16);
    return normalizeIp(
      `${String(hi >> 8)}.${String(hi & 255)}.${String(lo >> 8)}.${String(lo & 255)}`,
    );
  }
  return {
    version: 6,
    address: groups.join(':'),
    subnet: `${groups.slice(0, 4).join(':')}::/64`,
  };
}

/** Keyed hashes of address and subnet. Distinct prefixes keep the two hash spaces apart. */
export function hashIp(ip: NormalizedIp, secret: string): IpHashes {
  const hmac = (value: string) => createHmac('sha256', secret).update(value).digest();
  return { ipHash: hmac(`ip:${ip.address}`), subnetHash: hmac(`net:${ip.subnet}`) };
}
