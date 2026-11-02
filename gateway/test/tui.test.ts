import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module
import { olderThan, pad, parseNetstat } from '../../scripts/tui.mjs';

describe('terminal control panel helpers', () => {
  it('compares bridge versions numerically', () => {
    expect(olderThan('2.0.0', '2.3.0')).toBe(true);
    expect(olderThan('2.10.0', '2.9.0')).toBe(false);
    expect(olderThan('2.3.0', '2.3.0')).toBe(false);
    expect(olderThan('0.1.0', '2.3.0')).toBe(true);
  });

  it('finds the listening process of a port in netstat output', () => {
    const text = [
      '  TCP    127.0.0.1:8787         0.0.0.0:0              LISTENING       4828',
      '  TCP    127.0.0.1:8787         127.0.0.1:64454        ESTABLISHED     4828',
      '  TCP    127.0.0.1:8788         0.0.0.0:0              LISTENING       4828',
      '  TCP    0.0.0.0:18787          0.0.0.0:0              LISTENING       9999',
    ].join('\r\n');
    expect(parseNetstat(text, 8787)).toEqual([4828]);
    expect(parseNetstat(text, 8788)).toEqual([4828]);
    expect(parseNetstat(text, 18787)).toEqual([9999]);
    expect(parseNetstat(text, 80)).toEqual([]);
  });

  it('pads and truncates table cells', () => {
    expect(pad('ab', 5)).toBe('ab   ');
    expect(pad('abcdefghij', 5)).toBe('abcd ');
  });
});
