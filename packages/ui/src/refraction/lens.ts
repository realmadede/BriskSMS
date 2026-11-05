/**
 * Optical Lens Geometry & Dispersion Calculations
 * Adapted from Glisse (https://github.com/0kzh/glisse)
 */

export interface LensShape {
  width: number;
  height: number;
  radius: number;
}

export interface LensConfig {
  /** Strength of light bending (0.0 to 1.0) */
  strength: number;

  /** Chromatic dispersion: how far red/blue split (0.0 to 1.0) */
  dispersion: number;

  /** Depth of the lens rim (relative fraction of shorter side) */
  depth: number;

  /** Dome curvature sag factor */
  dome: number;
}

export const DEFAULT_GLASS_CONFIG: LensConfig = {
  strength: 0.45,
  dispersion: 0.4,
  depth: 0.25,
  dome: 0.5,
};

/**
 * Calculates distance from a point to a rounded rectangle edge
 */
export function distanceToRoundedRect(
  x: number,
  y: number,
  halfWidth: number,
  halfHeight: number,
  radius: number,
): number {
  const qx = Math.abs(x) - halfWidth + radius;
  const qy = Math.abs(y) - halfHeight + radius;
  const rx = Math.max(0, qx);
  const ry = Math.max(0, qy);
  return Math.sqrt(rx * rx + ry * ry) + Math.min(0, Math.max(qx, qy)) - radius;
}

/**
 * Computes SVG feDisplacementMap scale attribute
 */
export function calculateDisplacementScale(shape: LensShape, config: LensConfig = DEFAULT_GLASS_CONFIG): number {
  const minDimension = Math.min(shape.width, shape.height);
  return Math.round(minDimension * config.strength * 0.5);
}
