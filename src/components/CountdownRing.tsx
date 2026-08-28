/**
 * CountdownRing — the hybrid countdown ring primitive (Story 4.3, UX-DR5).
 *
 * Pure presentational SVG via react-native-svg: a full `track` circle and a
 * shrinking `remaining` arc stacked in one rotated group. The arc shrinks
 * via a single `strokeDasharray` rewrite (the dash+gap pattern, NOT
 * `stroke-dashoffset`) — a plain React re-render per tick, no
 * `Animated`/Reanimated worklet overhead for a once-per-second value.
 *
 * Geometry:
 *   - `r = (size - strokeWidth) / 2` — the stroke is INSET so the bounding
 *     box matches `size` exactly and the round caps never clip at the edges.
 *   - `C = 2 * Math.PI * r` — the circumference, pre-computed OUTSIDE the
 *     JSX (useMemo) so React never recomputes it during a per-second render.
 *   - `<G rotation={-90} originX={size/2} originY={size/2}>` wraps BOTH
 *     circles so the arc starts at 12 o'clock and shrinks clockwise — the
 *     universally-recognised countdown direction.
 *   - `progress === 1` = full ring remaining (session just started);
 *     `progress === 0` = empty (expired).
 *
 * Colours arrive as `tokens.*` PlatformColor objects and are passed through
 * verbatim — the token indirection stays mandatory (no raw hex here or at
 * any call site).
 *
 * Accessibility: the ring is purely visual — `accessibilityElementsHidden` +
 * `importantForAccessibility="no"` keep VoiceOver from announcing the SVG
 * itself; the tabular `mm:ss` numeral next to it carries the announce.
 */

import React, { useMemo } from 'react';
import { G, Circle, Svg } from 'react-native-svg';
import type { SvgProps, GProps, CircleProps } from 'react-native-svg';
import type { PlatformColorOutput } from '../theme/tokens';

// react-native-svg ships its primitives as ES classes whose type declarations
// predate the React 19 JSX element typing this app compiles against — using
// the class values directly as JSX fails TS2607/TS2786. The runtime values
// ARE function-compatible components (they render via react-native-svg's
// internal createElement path), so alias them to function-component types
// once here; the aliasing is contained to this file and the props contracts
// stay react-native-svg's own.
const SvgView = Svg as unknown as React.FC<SvgProps>;
const GView = G as unknown as React.FC<GProps>;
const CircleView = Circle as unknown as React.FC<CircleProps>;

export interface CountdownRingProps {
  /** Outer size in px (square). The Timer surface uses 64; the 4.4 header mini ring will use 16. */
  size?: number;
  /** Stroke width in px (Timer surface: 4; 4.4 header mini ring: 1.5). */
  strokeWidth?: number;
  /** Full-circle track colour — `tokens.status.blocked` on the Timer surface. */
  trackColor: PlatformColorOutput;
  /** Remaining-arc colour — `tokens.primary` on the Timer surface. */
  remainingColor: PlatformColorOutput;
  /**
   * Fraction of the ring still remaining, `0..1` (`1 - remaining/total`).
   * `1` = full ring; `0` = empty. Clamped defensively so a drifted value
   * never over- or under-draws the dash.
   */
  progress: number;
}

export function CountdownRing({
  size = 64,
  strokeWidth = 4,
  trackColor,
  remainingColor,
  progress,
}: CountdownRingProps): React.ReactElement {
  // Pre-compute the geometry ONCE per size/strokeWidth change — never inside
  // the JSX, so the per-tick re-render only rewrites the dasharray string.
  // The radius clamps at 0: `size <= strokeWidth` (a degenerate call site)
  // must not yield a negative r / a negative-C dash.
  const { r, C } = useMemo(() => {
    const radius = Math.max(0, (size - strokeWidth) / 2);
    return { r: radius, C: 2 * Math.PI * radius };
  }, [size, strokeWidth]);

  // Defensive NaN guard: a malformed value must degrade to an EMPTY ring,
  // never to a NaN dash string.
  const clamped = Number.isFinite(progress)
    ? Math.min(1, Math.max(0, progress))
    : 0;
  const center = size / 2;
  // Dash+gap pattern (NOT dashoffset): dash length = C * progress, gap = C.
  // A single string value rewritten per tick — the canonical shrinking ring.
  const dashArray = `${C * clamped} ${C}`;

  return (
    <SvgView
      width={size}
      height={size}
      // The numeral carries the announce; VoiceOver must not read the SVG.
      accessibilityElementsHidden={true}
      importantForAccessibility="no"
    >
      <GView rotation={-90} originX={center} originY={center}>
        {/* Track — the full circle behind the arc. */}
        <CircleView
          cx={center}
          cy={center}
          r={r}
          stroke={trackColor}
          strokeWidth={strokeWidth}
          fill="none"
        />
        {/* Remaining arc — starts at 12 o'clock, shrinks clockwise. Rendered
            ONLY while there is remaining time: a zero-length dash with
            strokeLinecap="round" is renderer-dependent and can draw a stray
            dot at 12 o'clock on an empty ring. */}
        {clamped > 0 ? (
          <CircleView
            cx={center}
            cy={center}
            r={r}
            stroke={remainingColor}
            strokeWidth={strokeWidth}
            fill="none"
            strokeDasharray={dashArray}
            strokeLinecap="round"
          />
        ) : null}
      </GView>
    </SvgView>
  );
}