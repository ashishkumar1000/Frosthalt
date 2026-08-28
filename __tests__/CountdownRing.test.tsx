/**
 * @format
 *
 * Story 4.3 — the CountdownRing SVG primitive tests.
 *
 * Uses the REAL react-native-svg module (it renders under Jest with
 * react-test-renderer's async `act` — verified; the JSON tree shows the
 * native view types RNSVGSvgView / RNSVGGroup / RNSVGCircle). The module
 * PARSES props at render time, so assertions target the parsed contract:
 *
 *   - `fill="none"`        -> `fill: null`
 *   - `strokeDasharray`    -> `[dashString, gapString]` (the dash+gap pair,
 *                             NOT a dashoffset — the spec's shrinking-arc
 *                             technique, pinned numerically here)
 *   - `strokeLinecap`      -> numeric enum (1 = "round"); the track circle
 *                             carries no linecap at all
 *   - PlatformColor stroke -> `{ type: 0, payload: { semantic: [name] } }`,
 *                             so the token indirection (no raw hex) stays
 *                             assertable end-to-end
 *   - `<G rotation={-90} originX originY>` is baked into a `matrix` by
 *                             react-native-svg; the matrix is asserted as
 *                             the exact rotation-about-center transform
 *
 * The ring is presentational — geometry math (r, C, dash lengths) is the
 * contract under test, plus the a11y-hidden attributes that keep VoiceOver
 * away from the SVG.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { tokens } from '../src/theme/tokens';
import { CountdownRing } from '../src/components/CountdownRing';

/** Parsed shape of a rendered SVG circle node's props in the JSON tree. */
interface CircleJsonProps {
  fill: unknown;
  stroke?: { type: number; payload: { semantic: string[] } };
  strokeWidth?: number;
  strokeDasharray?: string[];
  strokeLinecap?: number;
  cx: number;
  cy: number;
  r: number;
}

interface NodeJson {
  type: string;
  props: Record<string, unknown>;
  children?: NodeJson[];
}

/** Flattens the rendered JSON tree into a list of nodes. */
function flatten(node: NodeJson | null): NodeJson[] {
  if (node == null) return [];
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

async function renderRing(
  progress: number,
  size = 64,
  strokeWidth = 4,
): Promise<ReturnType<typeof ReactTestRenderer.create>> {
  let renderer!: ReturnType<typeof ReactTestRenderer.create>;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <CountdownRing
        size={size}
        strokeWidth={strokeWidth}
        trackColor={tokens.status.blocked}
        remainingColor={tokens.primary}
        progress={progress}
      />,
    );
  });
  return renderer;
}

function circlesOf(json: NodeJson | null): CircleJsonProps[] {
  return flatten(json)
    .filter((n) => n.type === 'RNSVGCircle')
    .map((n) => n.props as unknown as CircleJsonProps);
}

// I/O Matrix: snapshots — progress 0 / 0.5 / 1 produce distinct stable trees.
describe('CountdownRing progress snapshots', () => {
  test.each([
    [0, 'empty ring (expired)'],
    [0.5, 'half ring (mid-session)'],
    [1, 'full ring (session just started)'],
  ])('progress %s — %s', async (progress) => {
    const renderer = await renderRing(progress);
    expect(renderer.toJSON()).toMatchSnapshot();
  });
});

// Geometry contract: the arc shrinks via strokeDasharray dash+gap, where
// dash = C * progress and gap = C, with r = (size - strokeWidth) / 2 and
// C = 2 * PI * r (for 64/4: r = 30, C = 188.49555921538757).
test('the arc dasharray encodes dash = C * progress, gap = C', async () => {
  const C = 2 * Math.PI * 30;

  // Empty ring: the ARC is not rendered at all (review step-04: a zero-length
  // dash with round caps can draw a stray dot) — only the track remains.
  const empty = circlesOf((await renderRing(0)).toJSON() as NodeJson);
  expect(empty).toHaveLength(1);

  const half = circlesOf((await renderRing(0.5)).toJSON() as NodeJson);
  expect(half[1].strokeDasharray).toEqual([
    `${C * 0.5}`,
    `${C}`,
  ]);

  const full = circlesOf((await renderRing(1)).toJSON() as NodeJson);
  expect(full[1].strokeDasharray).toEqual([`${C}`, `${C}`]);
});

// Out-of-range progress is clamped so the dash never over/under-draws; an
// out-of-range value that clamps to 0 renders NO arc at all.
test('progress is clamped to 0..1', async () => {
  const C = 2 * Math.PI * 30;
  const over = circlesOf((await renderRing(1.4)).toJSON() as NodeJson);
  expect(over[1].strokeDasharray).toEqual([`${C}`, `${C}`]);
  const under = circlesOf((await renderRing(-0.2)).toJSON() as NodeJson);
  expect(under).toHaveLength(1); // track only — empty ring
});

// Defensive (review step-04): the arc circle is dropped entirely at progress
// 0 — the track stays, the empty ring cannot grow a stray round-cap dot.
test('progress 0 renders only the track (no zero-length arc)', async () => {
  const json = (await renderRing(0)).toJSON() as NodeJson;
  const circles = circlesOf(json);
  expect(circles).toHaveLength(1);
  // The surviving circle IS the track (no dasharray, no linecap).
  expect(circles[0].strokeDasharray).toBeUndefined();
  expect(circles[0].strokeLinecap).toBeUndefined();
});

// Defensive (review step-04): NaN progress degrades to an EMPTY ring — no
// crash, no NaN dash string, same tree as progress 0.
test('NaN progress renders the empty-ring tree without crashing', async () => {
  const nanJson = (await renderRing(Number.NaN)).toJSON() as NodeJson;
  const circles = circlesOf(nanJson);
  expect(circles).toHaveLength(1);
  expect(circles[0].strokeDasharray).toBeUndefined();
  // Same tree as progress 0 — NaN and 0 are visually identical.
  expect(nanJson).toEqual((await renderRing(0)).toJSON());
});

// Defensive (review step-04): size <= strokeWidth clamps r to 0 — no crash,
// no negative radius, no degenerate negative-C dash.
test('a degenerate size (4px ring with 4px stroke) clamps r to 0 without crashing', async () => {
  const renderer = await renderRing(0.5, 4, 4);
  const circles = circlesOf(renderer.toJSON() as NodeJson);
  expect(circles).toHaveLength(2);
  for (const c of circles) {
    expect(c.r).toBe(0);
    expect(c.cx).toBe(2);
    expect(c.cy).toBe(2);
    // The dash must never go negative (C = 2*PI*0 = 0 -> "0 0", a finite,
    // zero-length pattern — and the arc's dasharray is at worst "0 0").
    if (c.strokeDasharray != null) {
      for (const seg of c.strokeDasharray) {
        expect(Number(seg)).not.toBeLessThan(0);
      }
    }
  }
});

// Both circles are strokes over a transparent fill — fill="none" parses to
// null, and BOTH the track and the arc carry it.
test('both circles render with fill none over the shared geometry', async () => {
  const circles = circlesOf((await renderRing(0.5)).toJSON() as NodeJson);
  expect(circles).toHaveLength(2);
  for (const c of circles) {
    expect(c.fill).toBeNull();
    expect(c.cx).toBe(32);
    expect(c.cy).toBe(32);
    expect(c.r).toBe(30);
    expect(c.strokeWidth).toBe(4);
  }
});

// The track circle carries no linecap; the arc is round-capped (the spec's
// rounded arc ends; "round" parses to the numeric enum 1).
test('the arc uses a round linecap and the track does not', async () => {
  const circles = circlesOf((await renderRing(0.25)).toJSON() as NodeJson);
  expect(circles[0].strokeLinecap).toBeUndefined();
  expect(circles[1].strokeLinecap).toBe(1);
});

// Token indirection: strokes arrive as PlatformColor objects from tokens.*
// and survive parsing with their NSColor semantic names — no raw hex.
test('strokes carry the PlatformColor semantic names from tokens', async () => {
  const circles = circlesOf((await renderRing(0.5)).toJSON() as NodeJson);
  expect(circles[0].stroke?.payload.semantic).toEqual(['systemRedColor']);
  expect(circles[1].stroke?.payload.semantic).toEqual(['controlAccentColor']);
});

// Rotation: react-native-svg bakes <G rotation={-90} originX originY> into a
// matrix. rotate(-90) about (size/2, size/2) is exactly
// [cos, sin, -sin, cos, ox + (oy*sin - ox*cos), oy + (ox*sin - oy*cos)]
// = [~0, -1, 1, ~0, 0, size] — asserted for both the 64px surface ring and
// a second size so the origin math is pinned, not hard-coded.
describe('the group rotation is -90deg about the centre', () => {
  test.each([
    [64, 4],
    [16, 1.5],
  ])('size %ipx (stroke %s)', async (size, strokeWidth) => {
    const renderer = await renderRing(0.5, size, strokeWidth);
    const groups = flatten(renderer.toJSON() as NodeJson).filter(
      (n) => n.type === 'RNSVGGroup' && Array.isArray(n.props.matrix),
    );
    expect(groups.length).toBeGreaterThanOrEqual(1);
    const matrix = groups[0].props.matrix as number[];
    const expected = [
      6.123233995736766e-17, // cos(-90deg)
      -1, // sin(-90deg)
      1, // -sin(-90deg)
      6.123233995736766e-17, // cos(-90deg)
      0, // tx
      size, // ty (rotation about size/2, size/2)
    ];
    expect(matrix).toHaveLength(6);
    matrix.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 9));
  });
});

// Accessibility: the ring is purely visual — the numeral next to it carries
// the announce, so the SVG hides itself from VoiceOver.
test('the SVG hides itself from accessibility', async () => {
  const renderer = await renderRing(0.5);
  const json = renderer.toJSON() as unknown as NodeJson;
  expect(json.type).toBe('RNSVGSvgView');
  expect(json.props.accessibilityElementsHidden).toBe(true);
  expect(json.props.importantForAccessibility).toBe('no');
});