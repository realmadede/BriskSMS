/**
 * SVG Filter DOM Pipeline for Liquid Glass Optical Refraction
 * Adapted from Glisse (https://github.com/0kzh/glisse)
 */

let sharedSvgContainer: SVGSVGElement | null = null;
let filterCount = 0;

/**
 * Returns or creates the shared hidden SVG container in document.body
 */
export function getSharedSvgContainer(): SVGSVGElement | null {
  if (typeof document === 'undefined') {
    return null;
  }

  if (sharedSvgContainer && document.body.contains(sharedSvgContainer)) {
    return sharedSvgContainer;
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'brisk-liquid-glass-svg-container');
  svg.style.position = 'absolute';
  svg.style.width = '0';
  svg.style.height = '0';
  svg.style.overflow = 'hidden';
  svg.style.pointerEvents = 'none';
  svg.style.visibility = 'hidden';

  document.body.appendChild(svg);
  sharedSvgContainer = svg;
  return sharedSvgContainer;
}

export interface SvgFilterHandle {
  filterId: string;
  updateScale: (scale: number) => void;
  destroy: () => void;
}

/**
 * Creates and attaches an SVG feDisplacementMap filter for an element
 */
export function createRefractionFilter(initialScale: number): SvgFilterHandle | null {
  const container = getSharedSvgContainer();
  if (!container) {
    return null;
  }

  filterCount += 1;
  const filterId = `brisk-glass-filter-${filterCount}`;

  const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
  filter.setAttribute('id', filterId);
  filter.setAttribute('x', '-20%');
  filter.setAttribute('y', '-20%');
  filter.setAttribute('width', '140%');
  filter.setAttribute('height', '140%');
  filter.setAttribute('color-interpolation-filters', 'sRGB');

  const displacement = document.createElementNS('http://www.w3.org/2000/svg', 'feDisplacementMap');
  displacement.setAttribute('in', 'SourceGraphic');
  displacement.setAttribute('scale', initialScale.toString());
  displacement.setAttribute('xChannelSelector', 'R');
  displacement.setAttribute('yChannelSelector', 'G');

  filter.appendChild(displacement);
  container.appendChild(filter);

  return {
    filterId,
    updateScale: (newScale: number) => {
      displacement.setAttribute('scale', newScale.toString());
    },
    destroy: () => {
      if (filter.parentNode) {
        filter.parentNode.removeChild(filter);
      }
    },
  };
}
