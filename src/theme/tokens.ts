/**
 * Frosthalt design tokens — the single source of truth for the brand layer
 * on top of macOS system semantic colors.
 *
 * Semantic brand colors (`primary`, the status ramp, `destructive`) are mapped
 * to NSColor system semantic names via `PlatformColor`, so they adapt to
 * light/dark and the user's Accent Color automatically. No manual appearance
 * branching anywhere downstream.
 *
 * `primaryForeground` / `monoBg` / `monoFg` are the same hex in both
 * appearances (white over saturated fills; the mono viewer is dark in both
 * light and dark), so they stay plain hex strings — `PlatformColor` is only
 * for native semantic names.
 *
 * The status color *names* are exported as plain string constants
 * (`statusColorNames`) so the NSColor mapping is assertable in Jest without a
 * native runtime. `tokens` wraps them in `PlatformColor(...)` for runtime.
 */

import { PlatformColor } from 'react-native';
import type { TextStyle } from 'react-native';

/**
 * Plain-string NSColor names for the status ramp. The source of truth for
 * which NSColor each status maps to — assertable in Jest without a native
 * runtime (PlatformColor returns an opaque object needing the native runtime
 * to resolve).
 */
export const statusColorNames = {
  free: 'systemGreenColor',
  amber: 'systemOrangeColor',
  blocked: 'systemRedColor',
} as const;

export type StatusKey = keyof typeof statusColorNames;

/** Opaque PlatformColor return type (resolves to a native color at render time). */
type PlatformColorOutput = ReturnType<typeof PlatformColor>;

export interface Tokens {
  /** Brand accent — follows the user's System Settings Accent Color. */
  readonly primary: PlatformColorOutput;
  /** Status ramp — block/free state only, never chrome/decoration. */
  readonly status: {
    readonly free: PlatformColorOutput;
    readonly amber: PlatformColorOutput;
    readonly blocked: PlatformColorOutput;
  };
  /** Destructive actions (Panic unblock, Remove domain, Change password). */
  readonly destructive: PlatformColorOutput;
  /** White — static in both appearances (saturated fills behind it). */
  readonly primaryForeground: string;
  /** Mono hosts-viewer pair — dark in both appearances. */
  readonly monoBg: string;
  readonly monoFg: string;
  readonly typography: {
    readonly body: TextStyle;
    readonly label: TextStyle;
    readonly title: TextStyle;
    readonly countdown: TextStyle;
    readonly mono: TextStyle;
  };
  readonly rounded: {
    readonly sm: number;
    readonly md: number;
    readonly lg: number;
    /** Pill — used by the status badge and the countdown ring. */
    readonly full: number;
  };
  readonly spacing: {
    readonly xs: number;
    readonly sm: number;
    readonly md: number;
    readonly lg: number;
    readonly xl: number;
  };
}

/**
 * The token object every later surface imports. Typography/rounded/spacing are
 * pinned per DESIGN.md frontmatter; lineHeight values are the frontmatter
 * ratios resolved to pixels (React Native's `lineHeight` is a number, not a
 * CSS ratio string) — the ratio is kept in a trailing comment for traceability.
 */
export const tokens: Tokens = {
  primary: PlatformColor('controlAccentColor'),
  status: {
    free: PlatformColor(statusColorNames.free),
    amber: PlatformColor(statusColorNames.amber),
    blocked: PlatformColor(statusColorNames.blocked),
  },
  destructive: PlatformColor('systemRedColor'),
  primaryForeground: '#FFFFFF',
  monoBg: '#1E1E1E',
  monoFg: '#E6E6E6',
  typography: {
    body: {
      fontFamily: '-apple-system',
      fontSize: 13,
      fontWeight: '400',
      lineHeight: 19, // 13 * 1.45
    },
    label: {
      fontFamily: '-apple-system',
      fontSize: 11,
      fontWeight: '500',
      lineHeight: 14, // 11 * 1.3
    },
    title: {
      fontFamily: '-apple-system',
      fontSize: 17,
      fontWeight: '600',
      lineHeight: 21, // 17 * 1.25
    },
    countdown: {
      fontFamily: '-apple-system',
      fontSize: 28,
      fontWeight: '600',
      lineHeight: 28, // 28 * 1.0
      fontVariant: ['tabular-nums'],
    },
    mono: {
      fontFamily: 'SF Mono',
      fontSize: 12,
      fontWeight: '400',
      lineHeight: 18, // 12 * 1.5
    },
  },
  rounded: { sm: 4, md: 6, lg: 10, full: 9999 },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
};

/**
 * Maps a status key to its `PlatformColor` fill. Returns the same
 * `tokens.status[status]` object (constructed once), so the badge fill and the
 * exported status token can never diverge, and an out-of-set key resolves to
 * `undefined` rather than calling `PlatformColor(undefined)`. The underlying
 * name mapping (`statusColorNames`) remains the Jest-assertable source of
 * truth.
 */
export function statusFill(status: StatusKey): PlatformColorOutput {
  return tokens.status[status];
}
