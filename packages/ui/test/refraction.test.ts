import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceToRoundedRect,
  calculateDisplacementScale,
  generateRimMap,
  RefractionManager,
} from '../src/index.js';

describe('UI Refraction & Liquid Glass Engine', () => {
  it('should compute distance to rounded rectangle accurately', () => {
    const halfWidth = 100;
    const halfHeight = 50;
    const radius = 10;

    // Center point (0, 0) should be deeply inside (negative distance)
    const centerDist = distanceToRoundedRect(0, 0, halfWidth, halfHeight, radius);
    assert.ok(centerDist < 0);

    // Exact edge (100, 0) should be on boundary (distance ~ 0)
    const edgeDist = distanceToRoundedRect(100, 0, halfWidth, halfHeight, radius);
    assert.equal(Math.round(edgeDist), 0);

    // Outside point (110, 0) should have positive distance ~ 10
    const outsideDist = distanceToRoundedRect(110, 0, halfWidth, halfHeight, radius);
    assert.equal(Math.round(outsideDist), 10);
  });

  it('should calculate optical displacement scale proportionally', () => {
    const shape = { width: 400, height: 200, radius: 16 };
    const scale = calculateDisplacementScale(shape);

    assert.equal(typeof scale, 'number');
    assert.ok(scale > 0);
    // minDimension = 200, strength = 0.45, scale = 200 * 0.45 * 0.5 = 45
    assert.equal(scale, 45);
  });

  it('should generate valid specular rim map data matching dimensions', () => {
    const shape = { width: 100, height: 50, radius: 12 };
    const rim = generateRimMap(shape, 0.3, 1);

    assert.equal(rim.columns, 100);
    assert.equal(rim.rows, 50);
    assert.equal(rim.data.length, 100 * 50 * 4);
    // Ensure data buffer is populated
    assert.ok(rim.data instanceof Uint8ClampedArray);
  });

  it('should instantiate RefractionManager with safe graceful degradation', () => {
    const manager = new RefractionManager();
    assert.ok(manager);
    // In headless Node/Bun environment without window, should safely default
    assert.equal(manager.detectHardwareCapability(), false);
  });
});

