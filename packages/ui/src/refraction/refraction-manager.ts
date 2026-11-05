import { LensShape, LensConfig, DEFAULT_GLASS_CONFIG, calculateDisplacementScale } from './lens.js';
import { generateRimMap } from './rim.js';

export interface RefractionManagerOptions {
  config?: LensConfig;
  enableOpticalRefraction?: boolean;
  maxFps?: number;
}

export class RefractionManager {
  private resizeObserver: ResizeObserver | null = null;
  private readonly config: LensConfig;
  private readonly enableOptical: boolean;

  constructor(options: RefractionManagerOptions = {}) {
    this.config = options.config || DEFAULT_GLASS_CONFIG;
    // Determine if hardware supports dynamic optical refraction safely
    this.enableOptical = options.enableOpticalRefraction ?? this.detectHardwareCapability();
  }

  /**
   * Safe capability detection for enterprise environments
   * Disables heavy SVG displacement shaders on low-power devices
   */
  public detectHardwareCapability(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }

    // Check prefers-reduced-motion
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return false;
    }

    // Check hardware concurrency (disable on low-end dual-core machines)
    if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) {
      return false;
    }

    return true;
  }

  /**
   * Binds glass refraction management to a target DOM element
   */
  public bindElement(element: HTMLElement): () => void {
    if (typeof window === 'undefined') {
      return () => {};
    }

    // Set base glass class
    element.classList.add('brisk-glass');

    if (!this.enableOptical) {
      // Graceful degradation: rely on CSS backdrop-filter only
      return () => {
        element.classList.remove('brisk-glass');
      };
    }

    const updateGlass = () => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const radius = parseFloat(style.borderRadius) || 16;

      const shape: LensShape = {
        width: rect.width,
        height: rect.height,
        radius,
      };

      const scale = calculateDisplacementScale(shape, this.config);
      element.style.setProperty('--lg-glass-bend', scale.toString());

      // Generate specular rim shine map
      const rim = generateRimMap(shape, 0.25, window.devicePixelRatio || 1);
      if (rim.columns > 0 && rim.rows > 0) {
        element.setAttribute('data-rim', 'true');
      }
    };

    updateGlass();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => updateGlass());
      this.resizeObserver.observe(element);
    }

    return () => {
      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }
      element.classList.remove('brisk-glass');
      element.removeAttribute('data-rim');
    };
  }
}
