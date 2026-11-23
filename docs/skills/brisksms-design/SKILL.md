---
name: brisksms-design
description: Canonical cross-platform design system and visual governance skill for the BriskSMS Web application (`apps/web` Glisse HTML portal & planned Angular 19+ SPA) and Android application (Jetpack Compose), featuring the warm editorial Stitch aesthetic and performance-guarded Liquid Glass.
---

# BriskSMS Cross-Platform Design System & Visual Governance

This skill is the **authoritative, non-negotiable visual specification** for all user interface engineering across the BriskSMS platform. All automated coding agents and human engineers must consult and strictly adhere to this document before creating or modifying UI components on the Web or Android.

---

## 1. Visual Philosophy & Core Identity

BriskSMS balances the tactile warmth and editorial prestige of modern luxury product design (the **Stitch Reference**) with the high-trust, mission-critical clarity of a commercial financial platform.

### Core Visual Attributes:
1. **Warm Bone/Sand Atmosphere:** Reject sterile, cold grey SaaS backgrounds in favor of an ambient gradient transitioning from Bone (`#EAE6DF`) to Sand (`#DCD6CB`), framed by ultra-fine hairline strokes.
2. **Geometric Typography:** Geometric grotesque typography (Plus Jakarta Sans / Inter Display), weights 400 to 600 only, sentence case, with hierarchy from size and color instead of weight.
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
| `color-accent-ink`    | `#6E5F3D` | Ochre used as text, links and focus rings on light surfaces (Ochre itself is ~2:1 as text) | **5.0:1 (WCAG AA)** |
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
| `color-surface-raised` | `#2A2A2F` | Selected / raised surface step (e.g. active nav indicator) |
| `color-status-rejected`| `#F07171` | Crimson as text on dark surfaces (`#D32F2F` is ~3.4:1 there) |

---

## 3. Typography & Hierarchy

BriskSMS utilizes **Plus Jakarta Sans** (with **Inter Display** as native fallback).

### Fluid Type Scale (CSS Clamp):
- **Display Hero (`type-display`):** `clamp(40px, 6vw + 1rem, 76px)` | Weight: 600 | Tracking: `-0.035em` | Line Height: `1.05`
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
  - `shadow-button`: `0 2px 6px rgba(25, 20, 15, 0.14)` (primary pills; neutral, never an Ochre glow)
  - `shadow-glass-inset`: `inset 0 0 0 0.5px var(--brisk-border-hairline)`
  - On the public pages these are the CSS variables `--shadow-diffuse`, `--shadow-floating` and `--shadow-button` in `apps/web/src/assets/css/site.css`. Resting cards use diffuse, hover states and floating objects use floating. Do not write one-off `box-shadow` values.

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
- Current implementation (`apps/android/app/src/main/java/tz/co/brisksms/ui/`):
  - `theme/BriskTheme.kt` wraps the app (`MainActivity`) and maps every Material 3 color role to tokens, so no baseline purple can leak into fields, dialogs or focus states.
  - Plus Jakarta Sans 400/500/600 is bundled in `res/font`; figures use tabular numerals; IDs, endpoints and references use `BriskMonoStyle`.
  - Icons are Lucide SVGs converted to vector drawables (`res/drawable/ic_*.xml`) with a 1.5 stroke; licenses in `apps/android/THIRD_PARTY_NOTICES.md`.
  - Shared building blocks live in `components/BriskComponents.kt` (`BriskCard`, `StatusTag`, `KeyValueRow`, pill buttons, `PerforatedDivider`).
  - The five-tab bar is `GlassTabBar` (`components/GlassTabBar.kt`): a floating Liquid Glass capsule with a specular top rim, a neutral diffuse shadow and a glass lens that slides to the selected tab in 200ms. The fill is translucent without a backdrop blur (API 26 to 30 fallback; a real blur needs API 31+ and is not implemented), so a canvas-coloured fade sits behind it and scrolling screens add `LocalBottomBarInset` to their bottom padding.
  - Android cards, dialogs and grouped lists use a 22dp radius (`BriskShapes.large`); the 18px `radius-card` above stays the web value. Android lens and sheet motion uses a stiff spring (damping 0.85, medium stiffness, about 200 to 250ms to settle) with a light haptic tick on selection, which replaces the 200ms ease-out rule on this platform.
  - Payments and Messaging are lazy lists built from these pieces; Device health, Settings and Overview use `CollapsingScreen` (large title, collapsing top bar, static sections), and `DetailSheet` is the shared bottom sheet. The Payments screen (`ui/payment/PaymentIntelligenceScreen.kt`) is the reference for the iOS 26 structure: a 34sp large title that fades into a solid compact `GlassTopBar` on scroll, a `GlassSegmented` filter, per-day grouped inset lists (`groupedShape`, rows solid, no glass on the list) and a detail `ModalBottomSheet`. The top bar and sheet are opaque because there is no backdrop blur below Android 12. Glass material on Android is gradients and transforms only so it looks the same from API 26 up: `glassBrush` (lit from above, denser toward the lower edge) for the tab bar body, `GlassLens` (raised capsule with its own sheen, rim and shadow) for the tab bar and segmented control, and `rememberLensStretch` (the lens widens about 8% while it travels). Real backdrop blur needs API 31 and is deliberately not used.
  - The receipt tear line (`PerforatedDivider`) is the app's signature detail and is used only on the pairing slip and the Overview "Today" card.
  - Launcher icon (`res/mipmap-anydpi-v26/ic_launcher.xml`) and the in-app mark (`ic_brisk_mark.xml`) are drawn from the web mark `apps/web/src/assets/brand/favicon.svg`; there is one logo across platforms.

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
   - **Public marketing exception (approved, `apps/web/src/index.html` and `developers.html` only):** the landing page may run slow ambient loops: drifting Ochre/Sand/white radial blobs (`.drift`), the supported-provider marquee, the Stage 02 relay `live-dot` pulse and phone float, the integrations code rain and the hero CTA shine. Both public pages may use the 450ms letter roll on button and nav-link hover. Both share one header (`apps/web/src/partials/header.html`, inserted by `server.ts`), a glass bar that condenses into a floating pill on scroll, and the shared interaction layer in `apps/web/src/assets/{css,js}/site.*`. That layer covers a dot cursor with a trailing ring that opens over clickable elements, secondary hero/CTA buttons pulled up to 12px toward the pointer, and "venom" on the primary Ochre buttons (header, hero, final CTA), where an SVG goo filter lets a chain of Ochre droplets stretch out of the pill toward the pointer. Keep venom to at most 3 buttons per viewport (the §5.3 filter budget). The pointer layer only switches on for a fine hovering pointer, and gives the native cursor and plain solid buttons back over inputs and code, on touch devices and under reduced motion. Blobs and code rain pause while off-screen, the marquee pauses on hover, and every one of them stops under `prefers-reduced-motion`. Pseudo-element animations need their own reduced-motion rule, because `*` does not match `::after`. The landing page also has a code-generated hero illustration (inline SVG, a payment slip matched to an invoice, 10s loop that pauses off-screen and shows its finished state under reduced motion, hidden below 1100px), a scroll-driven rail with numbered nodes on the payment journey, and numbered step circles with drawn connectors in "A clearer workflow". All three use only palette tokens and neutral shadows. None of this may appear in the merchant console (`console.html`) or the Android app, where rule #1 and rule #5 apply in full.
   - **Setup guide exception (approved 22 November 2026 at the product owner's request, `apps/web/src/getting-started.html` only):** a 12s hero illustration loop (pairing code, scan, phone going Active) that pauses off-screen and shows its finished state under reduced motion; one-shot scroll reveals staggered within a group; a step number that pops in with a connector line that draws; hover lifts of at most 3px; the on-page link that marks the section being read. No drifting blobs, cursor layer, venom buttons or code rain. All of it stops under `prefers-reduced-motion`, and content stays fully visible without JavaScript or if the script fails to start (a 2.5s safety timer removes the hidden start state). The merchant console and Android app are still excluded.
   - **Shadows and gradients:** shadows are neutral and come from the three elevation tokens in §4. A colored shadow or glow is banned. The one carve-out is the venom droplet filter on the primary Ochre buttons, which is part of the approved exception above. A gradient is allowed only as a neutral tone shift (e.g. the card surface), a mask or scrim, or inside the approved ambient effects (blobs, code rain, hero shine). Never a hue-to-hue gradient on a surface, text or border.
   - **Type:** weights above 600 are banned, as are uppercase or wide-tracked labels (write labels in sentence case in the markup, not only through `text-transform`), negative tracking on text below about 20px, and exclamation marks in interface text.
6. **No Abstract AI Art Tropes:**
   - ❌ Banned: Stock 3D glass robots, floating AI brains, circuit board textures, or generic futuristic blobs.
   - ✅ Required: Authentic financial data tables, device telemetry feeds, and provider badges (Vodacom, Mixx, Airtel, HaloPesa, CRDB, NMB).

### 10.2. The 9-Pass Ordered Refactoring Rubric
When designing, refactoring, or auditing any UI screen (Angular Web or Jetpack Compose), the engineer or agent must evaluate and refine the interface sequentially through these nine ordered passes:

1. **Pass 1 — Spacing:** Establish rhythmic, mathematical distribution using the 4px baseline grid (`4, 8, 12, 16, 24, 32, 48px`). Eliminate uneven margins and padding before touching any styling.
2. **Pass 2 — Color:** Verify all colors map to official tokens (`color-canvas-base`, `color-accent-primary`, etc.). Strip ungrounded dark neutrals and unapproved hex values.
3. **Pass 3 — Icons:** Ensure icons are uniform, sized to 20px/24px with 1.5px stroke width. Eliminate purely decorative or mismatched icon sets.
4. **Pass 4 — Copy:** Audit text for clarity and tone. Eliminate marketing fluff. Format financial currency strictly as `TZS` or `Tsh` with comma grouping (e.g., `TZS 50,000`).
5. **Pass 5 — Typography:** Enforce the Plus Jakarta Sans / Inter Display type scale. Restrict font weights to 400 (body), 500 (metadata/captions), and 600 (headers and display); 700 and above are not used. Sentence-case all labels. Enable `font-variant-numeric: tabular-nums` on all amounts.
6. **Pass 6 — Layout:** Validate alignment, responsive viewport stacking across breakpoints, and container max-widths. Ensure dense tables remain scannable without excessive whitespace.
7. **Pass 7 — Details:** Refine micro-geometry: 0.5px hairline borders, pill radii (`9999px`) on action buttons, card radii (`18px`), and accessible high-contrast focus rings.
8. **Pass 8 — Visuals:** Ensure focal elements (Liquid Glass cards, device health pills) have purpose. Check that Glisse glass is applied only to floating/focal elements and never to dense data tables.
9. **Pass 9 — Motion:** Verify transitions are purposeful, concise ($\le 200\text{ms}$), and completely disabled under `prefers-reduced-motion`.


