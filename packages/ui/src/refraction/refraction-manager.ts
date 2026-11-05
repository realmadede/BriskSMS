import { LensShape, LensConfig, DEFAULT_GLASS_CONFIG, calculateDisplacementScale } from './lens.js';
import { generateRimDataUrl } from './rim.js';
import { createRefractionFilter, SvgFilterHandle } from './svg.js';

export interface RefractionManagerOptions {
  config?: LensConfig;
  enableOpticalRefraction?: boolean;
  maxConcurrentFilters?: number;
}

let activeFilterCount = 0;
const MAX_CONCURRENT_FILTERS = 3;

export class RefractionManager {
  private resizeObserver: ResizeObserver | null = null;
  private filterHandle: SvgFilterHandle | null = null;
  private readonly config: LensConfig;
  private readonly enableOptical: boolean;

  constructor(options: RefractionManagerOptions = {}) {
    this.config = options.config || DEFAULT_GLASS_CONFIG;
    this.enableOptical = options.enableOpticalRefraction ?? this.detectHardwareCapability();
  }

  /**
   * Multi-factor hardware capability detection
   * Guards against GPU throttling, low-power mode, and user accessibility preferences
   */
  public detectHardwareCapability(): boolean {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return false;
    }

    // 1. Accessibility: Check user preference for reduced motion
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)')?.matches) {
      return false;
    }

    // 2. Accessibility: Check user preference for reduced transparency
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-transparency: reduce)')?.matches) {
      return false;
    }

    // 3. Browser CSS Support: Must support backdrop-filter
    if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || !CSS.supports('backdrop-filter', 'blur(1px)')) {
      return false;
    }

    // 4. Concurrency Guard: Enforce max 3 simultaneously active optical filters per page
    if (activeFilterCount >= MAX_CONCURRENT_FILTERS) {
      return false;
    }

    // 5. GPU Rendering Context: Test if WebGL context can be initialized without software fallback
    try {
      const canvas = document.createElement('canvas');
      const gl =
        canvas.getContext('webgl') ||
        (canvas as HTMLCanvasElement).getContext('experimental-webgl' as any);
      if (!gl) {
        return false;
      }
    } catch {
      return false;
    }

    return true;
  }

  /**
   * Binds liquid glass refraction management to a target DOM element
   */
  public bindElement(element: HTMLElement): () => void {
    if (typeof window === 'undefined') {
      return () => {};
    }

    element.classList.add('brisk-glass');

    if (!this.enableOptical) {
      // Graceful fallback: pure CSS backdrop-filter
      return () => {
        element.classList.remove('brisk-glass');
      };
    }

    activeFilterCount += 1;

    const updateGlass = () => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const radius = parseFloat(style.borderRadius) || 18;

      const shape: LensShape = {
        width: rect.width,
        height: rect.height,
        radius,
      };

      if (shape.width <= 0 || shape.height <= 0) {
        return;
      }

      const scale = calculateDisplacementScale(shape, this.config);
      element.style.setProperty('--lg-glass-bend', scale.toString());

      // 1. Initialize or update SVG displacement filter
      if (!this.filterHandle) {
        this.filterHandle = createRefractionFilter(scale);
        if (this.filterHandle) {
          element.style.setProperty('--lg-filter', `url(#${this.filterHandle.filterId}) saturate(1.4)`);
        }
      } else {
        this.filterHandle.updateScale(scale);
      }

      // 2. Generate specular rim lighting data URL
      const rimDataUrl = generateRimDataUrl(shape, 0.25, window.devicePixelRatio || 1);
      if (rimDataUrl) {
        element.style.setProperty('--lg-rim', `url("${rimDataUrl}")`);
        element.setAttribute('data-rim', 'true');
      }
    };

    updateGlass();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => updateGlass());
      this.resizeObserver.observe(element);
    }

    return () => {
      activeFilterCount = Math.max(0, activeFilterCount - 1);

      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }

      if (this.filterHandle) {
        this.filterHandle.destroy();
        this.filterHandle = null;
      }

      element.classList.remove('brisk-glass');
      element.removeAttribute('data-rim');
      element.style.removeProperty('--lg-glass-bend');
      element.style.removeProperty('--lg-filter');
      element.style.removeProperty('--lg-rim');
    };
  }
}
