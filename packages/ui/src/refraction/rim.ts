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

/**
 * Converts RimMapData into an optimized CSS data URL via offscreen canvas
 */
export function generateRimDataUrl(shape: LensShape, shine: number, density: number): string | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const rim = generateRimMap(shape, shine, density);
  if (rim.columns <= 0 || rim.rows <= 0) {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = rim.columns;
  canvas.height = rim.rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }

  const imageData = new ImageData(rim.data, rim.columns, rim.rows);
  ctx.putImageData(imageData, 0, 0);

  return canvas.toDataURL('image/png');
}
