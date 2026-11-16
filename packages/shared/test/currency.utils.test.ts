import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toMinorUnits, toMajorUnits, formatTzs } from '../src/utils/currency.utils.js';

describe('Currency Utils', () => {
  it('should convert major units to minor cents without floating-point errors', () => {
    assert.equal(toMinorUnits(50000), 5000000n);
    assert.equal(toMinorUnits('50000.50'), 5000050n);
    assert.equal(toMinorUnits('50,000.5'), 5000050n);
    assert.equal(toMinorUnits(0.01), 1n);
    assert.equal(toMinorUnits(19.99), 1999n);
    assert.equal(toMinorUnits('1.005'), 101n);
    assert.equal(toMinorUnits('9007199254740993.99'), 900719925474099399n);
    assert.throws(() => toMinorUnits('50abc'));
    assert.throws(() => toMinorUnits(Number.NaN));
    assert.throws(() => toMinorUnits(Number.POSITIVE_INFINITY));
  });

  it('should convert minor units to major units correctly', () => {
    assert.equal(toMajorUnits(5000000n), 50000);
    assert.equal(toMajorUnits(5000050n), 50000.5);
    assert.equal(toMajorUnits(1999n), 19.99);
  });

  it('should format Tanzanian Shilling display correctly', () => {
    const formatted = formatTzs(5000000n);
    assert.match(formatted, /50,000/);
  });
});

