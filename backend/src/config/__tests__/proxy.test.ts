import { trustProxyHops } from '../proxy';

describe('trustProxyHops', () => {
  it('defaults to 1 when unset or blank', () => {
    expect(trustProxyHops(undefined)).toBe(1);
    expect(trustProxyHops('')).toBe(1);
    expect(trustProxyHops('  ')).toBe(1);
  });

  it('accepts small non-negative integers', () => {
    expect(trustProxyHops('0')).toBe(0);
    expect(trustProxyHops('2')).toBe(2);
    expect(trustProxyHops(' 3 ')).toBe(3);
  });

  it.each(['-1', '1.5', 'true', 'loopback', '2,3', '11'])('falls back to 1 for %s', (raw) => {
    expect(trustProxyHops(raw)).toBe(1);
  });
});
