import { LensShape, distanceToRoundedRect } from './lens.js';

export const RIM_WIDTH = 1.22;
export const EDGE_WIDTH = 0.5;

export interface RimMapData {
  columns: number;
  rows: number;
  data: Uint8ClampedArray;
}

/**
 * Generates specular rim highlight pixel data matching Apple's .glassEffect()
 */
export function generateRimMap(
  shape: LensShape,
  shine: number,
  density: number,
): RimMapData {
  const columns = Math.max(1, Math.round(shape.width * density));
  const rows = Math.max(1, Math.round(shape.height * density));
  const data = new Uint8ClampedArray(columns * rows * 4);

  const halfWidth = shape.width / 2;
  const halfHeight = shape.height / 2;
  const corner = Math.min(shape.radius, Math.min(halfWidth, halfHeight));

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const x = ((col + 0.5) / columns) * shape.width - halfWidth;
      const y = ((row + 0.5) / rows) * shape.height - halfHeight;
      const depth = -distanceToRoundedRect(x, y, halfWidth, halfHeight, corner);

      if (depth < -0.5 || depth > 2 * RIM_WIDTH) {
        continue;
      }

      // Compute specular edge luminance
      const alpha = Math.max(0, Math.min(255, Math.round(shine * 255 * (1 - depth / (2 * RIM_WIDTH)))));
      const idx = (row * columns + col) * 4;
      data[idx] = 255;     // R
      data[idx + 1] = 255; // G
      data[idx + 2] = 255; // B
      data[idx + 3] = alpha; // Alpha
    }
  }

  return { columns, rows, data };
}

