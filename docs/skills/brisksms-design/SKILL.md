---
name: brisksms-design
description: Canonical cross-platform design system and visual governance skill for the BriskSMS Web application (Angular 19+) and Android application (Jetpack Compose), featuring the warm editorial Stitch aesthetic and performance-guarded Liquid Glass.
---

# BriskSMS Cross-Platform Design System & Visual Governance

This skill is the **authoritative, non-negotiable visual specification** for all user interface engineering across the BriskSMS platform. All automated coding agents and human engineers must consult and strictly adhere to this document before creating or modifying UI components on the Web or Android.

---

## 1. Visual Philosophy & Core Identity

BriskSMS balances the tactile warmth and editorial prestige of modern luxury product design (the **Stitch Reference**) with the high-trust, mission-critical clarity of a commercial financial platform.

### Core Visual Attributes:
1. **Warm Bone/Sand Atmosphere:** Reject sterile, cold grey SaaS backgrounds in favor of an ambient gradient transitioning from Bone (`#EAE6DF`) to Sand (`#DCD6CB`), framed by ultra-fine hairline strokes.
2. **Bold Geometric Typography:** High-impact geometric grotesque typography (Plus Jakarta Sans / Inter Display) featuring tight letter spacing and distinct hierarchy.
3. **Pill Action Architecture:** High-contrast pill buttons utilizing Warm Ochre (`#C2B28F`) for primary actions and Deep Obsidian (`#121212`) for high-contrast secondary actions.
4. **Selective Liquid Glass (Glisse Material):** Diffuse, hardware-accelerated translucent glass with specular rim reflections and optical refraction, reserved strictly for floating and focal surfaces.
5. **Architectural Separation:**
   - **Public Marketing Website:** Full editorial composition, narrative typography, chrome liquid spheres, and generous negative space.
   - **Authenticated Business Application:** High-density, uncluttered financial dashboards, readable transaction tables, real-time device health feeds, and accessible forms sharing the exact same color, typography, and glass material foundation.

---

## 2. Color Palette & Semantic Roles

All colors are defined as design tokens. Hardcoding raw hex values in components is strictly prohibited.

### 2.1. Light Theme (Primary / Editorial Daylight)
| Token Name | Hex / Value | Semantic Role | Contrast vs Canvas |
|---|---|---|---|
| `color-canvas-base` | `#EAE6DF` | Primary background canvas (Bone) | Base |
| `color-canvas-deep` | `#DCD6CB` | Gradient anchor & card undertone (Sand) | 1.1:1 |
| `color-surface-glass` | `rgba(255, 255, 255, 0.65)` | Frosted glass card & container fill | Base |
| `color-surface-active` | `rgba(236, 236, 240, 0.85)`| Hover and active state surface | 1.1:1 |
| `color-surface-solid` | `#F5F3EF` | Solid opaque surface for dense tables | Base |
| `color-accent-primary`| `#C2B28F` | Warm Ochre / Sand Gold primary CTA pill | 3.5:1 (Pill background) |
| `color-accent-hover`  | `#B2A27E` | Darkened Ochre hover state | 3.9:1 |
| `color-contrast-pill` | `#121212` | Deep Obsidian high-contrast action pill | 12.4:1 |
| `color-text-primary`  | `#121212` | Primary headlines, titles, and amounts | **12.4:1 (WCAG AAA)** |
| `color-text-secondary`| `#666666` | Secondary body text and labels | **4.8:1 (WCAG AA)** |
| `color-text-tertiary` | `#8E8A82` | Metadata, timestamps, and captions | 3.2:1 (Non-body) |
| `color-border-hairline`| `rgba(18, 18, 18, 0.08)` | 0.5px ultra-fine card & structural border | Crisp delimiter |
| `color-status-verified`| `#2E7D32` | M-Pesa / Verified payment green | 4.6:1 |
| `color-status-review`  | `#ED6C02` | Discrepancy / Review Required amber | 4.5:1 |
| `color-status-rejected`| `#D32F2F` | Duplicate / Fraud / Error crimson | 4.7:1 |

### 2.2. Dark Theme (Midnight / Low-Light Operations)
| Token Name | Hex / Value | Semantic Role |
|---|---|---|
| `color-canvas-base` | `#141416` | Deep obsidian canvas |
| `color-canvas-deep` | `#1A1A1E` | Elevated surface base |
| `color-surface-glass` | `rgba(32, 32, 36, 0.65)` | Translucent dark glass container |
| `color-text-primary`  | `#FFFFFF` | Primary headlines and amounts (15.8:1) |
| `color-text-secondary`| `#A0A0A8` | Secondary labels (6.2:1) |
| `color-accent-primary`| `#D4C5A2` | Brightened Ochre for dark contrast |
| `color-border-hairline`| `rgba(255, 255, 255, 0.12)` | Hairline stroke in dark mode |

---

## 3. Typography & Hierarchy

BriskSMS utilizes **Plus Jakarta Sans** (with **Inter Display** as native fallback).

### Fluid Type Scale (CSS Clamp):
- **Display Hero (`type-display`):** `clamp(40px, 6vw + 1rem, 76px)` | Weight: 700 | Tracking: `-0.035em` | Line Height: `1.05`
- **Heading 1 (`type-h1`):** `clamp(28px, 3.5vw + 0.5rem, 44px)` | Weight: 600 | Tracking: `-0.025em` | Line Height: `1.15`
- **Heading 2 (`type-h2`):** `clamp(22px, 2.5vw + 0.5rem, 32px)` | Weight: 600 | Tracking: `-0.02em` | Line Height: `1.2`
- **Heading 3 (`type-h3`):** `clamp(18px, 1.5vw + 0.5rem, 24px)` | Weight: 600 | Tracking: `-0.015em` | Line Height: `1.3`
- **Body Large (`type-body-lg`):** `clamp(16px, 1.2vw + 0.5rem, 18px)` | Weight: 400 | Tracking: `0` | Line Height: `1.55`
- **Body Regular (`type-body`):** `15px` | Weight: 400 | Tracking: `0` | Line Height: `1.5`
- **Caption / Meta (`type-caption`):** `13px` | Weight: 500 | Tracking: `+0.01em` | Line Height: `1.4`
- **Monospace Financial (`type-mono`):** `JetBrains Mono, SF Mono, monospace` (used for M-Pesa transaction codes, hashes, and IP addresses).

---

## 4. Spacing, Radii & Elevations

- **Base Spacing Grid:** 4px baseline unit.
  - Scale: `4px` (`xs`), `8px` (`sm`), `12px` (`md`), `16px` (`lg`), `24px` (`xl`), `32px` (`2xl`), `48px` (`3xl`), `64px` (`4xl`).
- **Corner Radii:**
  - `radius-pill`: `9999px` (Primary and secondary action buttons, status badges).
  - `radius-card`: `18px` (Financial cards, device health panels, modal containers).
  - `radius-surface`: `24px` (Enclosing viewport canvas frame).
  - `radius-control`: `10px` (Input fields, dropdowns, table search bars).
- **Elevations & Ambient Shadows:**
  - `shadow-diffuse`: `0 8px 32px -4px rgba(45, 40, 30, 0.06), 0 1px 2px rgba(45, 40, 30, 0.04)`
  - `shadow-floating`: `0 16px 48px -8px rgba(45, 40, 30, 0.12), 0 2px 6px rgba(45, 40, 30, 0.06)`
  - `shadow-glass-inset`: `inset 0 0 0 0.5px var(--brisk-border-hairline)`

---

## 5. Liquid Glass Material Principles (Glisse Integration)

Liquid Glass is a **material enhancement**, not a blanket surface replacement.

### 5.1. Where Liquid Glass MUST Be Used:
- Sticky/floating top navigation bar (`.brisk-glass-nav`).
- Left floating micro-rail (`.brisk-nav-rail`).
- Modal dialogs and cashier alert sheets.
- High-level metric summary cards (Today's revenue, active device quorum).
- Contextual action menus and dropdown popovers.

### 5.2. Where Liquid Glass MUST NOT Be Used:
- Dense financial transaction tables (`normalized_payments`).
- Continuous audit logs (`audit_logs`).
- Complex multi-field forms and data-entry inputs.
- Dense lists with >10 simultaneously visible items.
- *Reason:* Preserves 60fps scrolling, prevents GPU thermal throttling on POS terminals, and guarantees WCAG AA contrast for small numbers.

### 5.3. Safe Refraction Constraints:
- Maximum **3 simultaneous SVG displacement filters** active in any single viewport.
- If hardware capability detection fails, elements automatically degrade to hardware-accelerated CSS `backdrop-filter: blur(16px)` without SVG optical displacement.

---

## 6. Component Specifications

### 6.1. Buttons
- **Primary Pill (`BriskButton variant="ochre"`):**
  - Background: `var(--brisk-accent-primary)` (`#C2B28F`)
  - Text: `var(--brisk-text-primary)` (`#121212`), Font Weight: 600
  - Shape: Pill (`9999px`), Height: 44px (touch-friendly)
- **Contrast Pill (`BriskButton variant="obsidian"`):**
  - Background: `var(--brisk-contrast-pill)` (`#121212`)
  - Text: `#FFFFFF`, Font Weight: 600
  - Shape: Pill (`9999px`), Height: 44px
- **Ghost Glass Pill (`BriskButton variant="glass"`):**
  - Background: `var(--brisk-surface-glass)`
  - Inset stroke: 0.5px `var(--brisk-border-hairline)`
  - Text: `var(--brisk-text-primary)`

### 6.2. Status Communication (Non-Color Dependency)
Every status indicator must display **both** an explicit symbol/icon and text:
- `[VERIFIED]` (Green `#2E7D32` with checkmark icon)
- `[REVIEW_REQUIRED]` (Amber `#ED6C02` with alert triangle icon)
- `[REJECTED]` (Crimson `#D32F2F` with cross icon)
- `[OBSERVED]` (Muted Umber `#666666` with pulse dot)

---

## 7. Responsive & Adaptive Layout Guidelines

### 7.1. Viewport Breakpoints
- **Compact Mobile (320px – 390px):** Single-column stack, full-width pill buttons, collapsed mobile navigation, zero decorative chrome spheres.
- **Standard Mobile (391px – 480px):** Single-column, touch-optimized rows, compact badges.
- **Tablet Portrait (481px – 768px):** 2-column adaptive layout, bottom navigation bar.
- **Tablet Landscape / Laptop (769px – 1024px):** Multi-column, floating left rail, top navigation.
- **Desktop Standard (1025px – 1440px):** Full Stitch editorial layout, 3 chrome spheres visible.
- **Large Display / TV (1441px – 1920px+):** Max-width container capped at 1600px, 10-foot UI font scale, prominent keyboard focus rings.
- **Foldable Devices:** Adaptive split-pane layout (left: ingestion stream; right: payment detail and invoice match).

---

## 8. Platform Implementation Rules

### 8.1. Web Implementation (Angular 19+)
- Implement via Standalone Components and Signals.
- Never install `react` or `react-dom`.
- Apply Liquid Glass via the `@brisksms/ui` Angular Directive:
  ```html
  <div briskLiquidGlass [enableRefraction]="true" class="brisk-glass-card">
    <h3>Today's Ingestion</h3>
  </div>
  ```
- All DOM observers (`ResizeObserver`) must be cleaned up in `ngOnDestroy`.

### 8.2. Android Implementation (Kotlin + Jetpack Compose)
- Use standard Jetpack Compose Material3 theming.
- Map BriskSMS tokens to `BriskTheme`:
  ```kotlin
  @Composable
  fun BriskTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit)
  ```
- Apply glass material via native Compose modifier:
  ```kotlin
  Modifier.briskGlass(cornerRadius = 18.dp)
  ```
- Uses `RenderEffect.createBlurEffect()` on Android 12+ (API 31+) and translucent surface fallbacks on older Android releases (API 26–30).

---

## 9. Performance & Accessibility Governance

1. **Accessibility Target:** WCAG 2.2 Level AA mandatory across all screens.
2. **Reduced Motion:** When `prefers-reduced-motion` is active:
   - All CSS transitions: `duration: 0ms !important`.
   - Spheres and background ambient lighting: completely stationary.
3. **Reduced Transparency:** When `prefers-reduced-transparency` is active, glass opacity increases to 95% solid tone.
4. **Visual Regression Gate:** Pull requests modifying UI components must pass automated Playwright visual screenshot comparisons across all 9 documented breakpoints.

---

## 10. Anti-AI-Slop Governance & The 9-Pass Quality Rubric

To prevent user interfaces from degrading into generic, "vibecoded" AI aesthetics, all UI components must project the dignity, restraint, and tactile precision of an institutional financial platform.

### 10.1. Prohibited AI Clichés (The Negative Constraints Catalog)
When generating or modifying UI code, automated agents must strictly avoid the following patterns:

1. **No Generic Purple/Neon Mesh Gradients:**
   - ❌ Banned: `bg-gradient-to-r from-purple-500 via-indigo-500 to-pink-500`, radial glow washes, or saturated dark-mode violet backgrounds.
   - ✅ Required: Anchor all canvases strictly in Stitch Bone (`#EAE6DF`), Sand (`#DCD6CB`), or Deep Obsidian (`#141416`).
2. **No Glowing Shadows or High-Contrast Neon Borders:**
   - ❌ Banned: `box-shadow: 0 0 20px rgba(168,85,247,0.5)`, colored halos, or fluorescent outlines.
   - ✅ Required: Restrained 0.5px hairline strokes (`border-hairline`: `rgba(18, 18, 18, 0.08)`) and ambient diffuse shadows.
3. **No Emoji UI Labels or Badges:**
   - ❌ Banned: `New ✨`, `Pro 🚀`, `Dashboard 📊`, `Settings ⚙️`, or emoji in buttons/tabs.
   - ✅ Required: Clean typographic badges and monochrome, contextual vector line icons (stroke-width 1.5).
4. **No Hyperbolic / Robotic Marketing Copy:**
   - ❌ Banned: *"Supercharge your business with next-gen automated AI magic!"*
   - ✅ Required: Clear, institutional financial language: *"Reconciled 1,420 M-Pesa transactions in the last 24 hours."*
5. **No Constant Looping Animations or Disorienting Keyframes:**
   - ❌ Banned: `animate-pulse`, continuous border rotation, or bouncing elements on static cards.
   - ✅ Required: Functional micro-transitions ($\le 200\text{ms}$, ease-out) that strictly respect `prefers-reduced-motion`.
6. **No Abstract AI Art Tropes:**
   - ❌ Banned: Stock 3D glass robots, floating AI brains, circuit board textures, or generic futuristic blobs.
   - ✅ Required: Authentic financial data tables, device telemetry feeds, and provider badges (Vodacom, Mixx, Airtel, HaloPesa, CRDB, NMB).

### 10.2. The 9-Pass Ordered Refactoring Rubric
When designing, refactoring, or auditing any UI screen (Angular Web or Jetpack Compose), the engineer or agent must evaluate and refine the interface sequentially through these nine ordered passes:

1. **Pass 1 — Spacing:** Establish rhythmic, mathematical distribution using the 4px baseline grid (`4, 8, 12, 16, 24, 32, 48px`). Eliminate uneven margins and padding before touching any styling.
2. **Pass 2 — Color:** Verify all colors map to official tokens (`color-canvas-base`, `color-accent-primary`, etc.). Strip ungrounded dark neutrals and unapproved hex values.
3. **Pass 3 — Icons:** Ensure icons are uniform, sized to 20px/24px with 1.5px stroke width. Eliminate purely decorative or mismatched icon sets.
4. **Pass 4 — Copy:** Audit text for clarity and tone. Eliminate marketing fluff. Format financial currency strictly as `TZS` or `Tsh` with comma grouping (e.g., `TZS 50,000`).
5. **Pass 5 — Typography:** Enforce the Plus Jakarta Sans / Inter Display type scale. Restrict font weights to 400 (body), 500 (metadata/captions), and 600 (headers). Enable `font-variant-numeric: tabular-nums` on all amounts.
6. **Pass 6 — Layout:** Validate alignment, responsive viewport stacking across breakpoints, and container max-widths. Ensure dense tables remain scannable without excessive whitespace.
7. **Pass 7 — Details:** Refine micro-geometry: 0.5px hairline borders, pill radii (`9999px`) on action buttons, card radii (`18px`), and accessible high-contrast focus rings.
8. **Pass 8 — Visuals:** Ensure focal elements (Liquid Glass cards, device health pills) have purpose. Check that Glisse glass is applied only to floating/focal elements and never to dense data tables.
9. **Pass 9 — Motion:** Verify transitions are purposeful, concise ($\le 200\text{ms}$), and completely disabled under `prefers-reduced-motion`.


