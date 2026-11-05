/**
 * BriskSMS Web Client Entry Point
 * Implements Stitch Design System & Refraction Engine
 */
import { RefractionManager } from '@brisksms/ui';

export function initializeApp(): void {
  const refraction = new RefractionManager();
  console.log('[BriskSMS] Web application initialized. Optical capability:', refraction.detectHardwareCapability());
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    initializeApp();
  });
}

