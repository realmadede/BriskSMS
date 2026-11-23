import { describe, it, expect } from 'bun:test';
// qr.js is a plain browser script; in Node/Bun it exports through module.exports

const qr = require('../src/assets/js/qr.js');

describe('QR encoder', () => {
  it('matches the Reed-Solomon vector from the QR specification worked example', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(qr.rsRemainder(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('grows the symbol with the text and refuses what it cannot hold', () => {
    expect(qr.buildMatrix('a').length).toBe(21);
    expect(qr.buildMatrix('x'.repeat(213)).length).toBe(57);
    expect(() => qr.buildMatrix('x'.repeat(214))).toThrow();
  });

  it('draws the three finder patterns', () => {
    const m = qr.buildMatrix('BriskSMS');
    const n = m.length;
    for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      expect(m[y][x]).toBe(true);
      expect(m[y + 3][x + 3]).toBe(true);
      expect(m[y + 1][x + 1]).toBe(false);
    }
  });
});
