import { describe, expect, it } from 'vitest';
import { hashIp, normalizeIp } from './ip.js';

// Documentation ranges only (RFC 5737 / RFC 3849).
const SECRET = 'test-secret-with-at-least-32-characters!';

function hashes(raw: string, secret = SECRET) {
  const ip = normalizeIp(raw);
  if (!ip) throw new Error(`invalid test ip ${raw}`);
  const { ipHash, subnetHash } = hashIp(ip, secret);
  return { ip: ipHash.toString('hex'), net: subnetHash.toString('hex') };
}

describe('normalizeIp', () => {
  it('normalises IPv4 and derives the /24', () => {
    expect(normalizeIp('192.0.2.44')).toEqual({
      version: 4,
      address: '192.0.2.44',
      subnet: '192.0.2.0/24',
    });
  });

  it('expands IPv6 and derives the /64', () => {
    expect(normalizeIp('2001:db8:1:2::abcd')).toEqual({
      version: 6,
      address: '2001:0db8:0001:0002:0000:0000:0000:abcd',
      subnet: '2001:0db8:0001:0002::/64',
    });
  });

  it('maps different notations of the same IPv6 address to one form', () => {
    const forms = ['2001:db8::1', '2001:DB8:0:0:0:0:0:1', '2001:0db8::0:1', '[2001:db8::1]'];
    const normalized = new Set(forms.map((f) => normalizeIp(f)?.address));
    expect(normalized.size).toBe(1);
  });

  it('treats IPv4-mapped IPv6 as IPv4', () => {
    expect(normalizeIp('::ffff:192.0.2.44')).toEqual(normalizeIp('192.0.2.44'));
    expect(normalizeIp('::ffff:c000:22c')).toEqual(normalizeIp('192.0.2.44'));
  });

  it('handles special IPv6 forms', () => {
    expect(normalizeIp('::1')?.address).toBe('0000:0000:0000:0000:0000:0000:0000:0001');
    expect(normalizeIp('::')?.address).toBe('0000:0000:0000:0000:0000:0000:0000:0000');
    expect(normalizeIp('fe80::1%eth0')?.address).toBe('fe80:0000:0000:0000:0000:0000:0000:0001');
  });

  it.each(['', 'localhost', '999.1.1.1', '1.2.3', '2001:db8::1::2', 'abc'])('rejects %j', (raw) => {
    expect(normalizeIp(raw)).toBeUndefined();
  });
});

describe('hashIp', () => {
  it('returns 32-byte HMACs', () => {
    const ip = normalizeIp('192.0.2.44');
    if (!ip) throw new Error('unreachable');
    const { ipHash, subnetHash } = hashIp(ip, SECRET);
    expect(ipHash).toHaveLength(32);
    expect(subnetHash).toHaveLength(32);
  });

  it('gives the same IP the same hash (IPv4 and IPv6)', () => {
    expect(hashes('192.0.2.44')).toEqual(hashes('192.0.2.44'));
    expect(hashes('2001:db8::1')).toEqual(hashes('2001:0db8:0:0::1'));
  });

  it('gives addresses in the same subnet the same subnet hash but different IP hashes', () => {
    const a = hashes('192.0.2.44');
    const b = hashes('192.0.2.200');
    expect(a.net).toBe(b.net);
    expect(a.ip).not.toBe(b.ip);

    const c = hashes('2001:db8:1:2::aaaa');
    const d = hashes('2001:db8:1:2:ffff::1');
    expect(c.net).toBe(d.net);
    expect(c.ip).not.toBe(d.ip);
  });

  it('gives different subnets different subnet hashes', () => {
    expect(hashes('192.0.2.44').net).not.toBe(hashes('198.51.100.44').net);
    expect(hashes('2001:db8:1:2::1').net).not.toBe(hashes('2001:db8:1:3::1').net);
  });

  it('depends on the secret (keyed, not a plain hash)', () => {
    expect(hashes('192.0.2.44').ip).not.toBe(
      hashes('192.0.2.44', 'another-secret-32-chars-long!!!!').ip,
    );
  });

  it('keeps IP and subnet hash spaces apart', () => {
    // An address that equals a subnet string must not collide with that subnet's hash.
    const ip = hashes('192.0.2.0');
    expect(ip.ip).not.toBe(ip.net);
  });
});
