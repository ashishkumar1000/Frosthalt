/**
 * The focus-session duration presets — single-sourced in the domain layer
 * (Story 6.3).
 *
 * Story 4.1 defined this list inside `TimerDurationPicker.tsx`; Story 6.3
 * hoists it here so the menu bar's "Start 25-min focus" quick-start and the
 * Timer surface's chip row read the SAME constant (the 6.2
 * `badgeStateLabels` hoist pattern): 25 minutes — the quick-start duration —
 * is `PRESET_MINUTES[0]`, and the UI chips render the same array. UI → domain
 * only; nothing in the domain layer imports the components.
 */

/** The three preset minute values the chip row offers (and the menu bar's quick-start uses the first). */
export const PRESET_MINUTES = [25, 45, 60] as const;
