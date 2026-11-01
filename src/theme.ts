/**
 * Single light palette for the whole app (the app config pins
 * `userInterfaceStyle: "light"`, so there is no dark variant to switch).
 *
 * Every pair used in the UI is checked against WCAG 2.1 in
 * `src/__tests__/theme.test.ts`: body text is at least 4.5:1 and visible
 * boundaries / controls are at least 3:1. Never use `opacity` to dim text —
 * it lowers contrast without changing the token, which is what made the
 * previous screens unreadable.
 */
export const theme = {
  /** Screen background. */
  bg: '#FFFFFF',
  /** Assistant bubbles, cards, editor panels. */
  surface: '#F5F7FA',
  /** User bubbles and selected chips. */
  surfaceAlt: '#E8F1FB',
  /** Inner cards sitting on a surface. */
  card: '#FFFFFF',

  /** Body text. */
  text: '#111827',
  /** Secondary text (endpoints, notes) — still AA on every surface. */
  muted: '#414E5C',
  /** Placeholder and label text — AA on white and on surfaces. */
  subtle: '#4A5A68',

  /** Visible boundary between components (≥3:1 against every surface). */
  border: '#7C8B99',
  /** Stronger boundary for inputs and unselected buttons. */
  borderStrong: '#5A6B7B',

  /** Interactive fill; white text on it is AA. */
  accent: '#0B5C86',
  /** Pressed state of an accent-filled control; white text stays AA. */
  accentPressed: '#084A6B',
  /** Accent as text or link on light surfaces. */
  accentText: '#0A5175',
  /** Accent as a background tint; `accentText` and `text` on it are AA. */
  accentSoft: '#DCEBF7',
  /** Fill of a disabled control. */
  disabled: '#DDE3EA',

  ok: '#15703B',
  okSoft: '#E4F1E9',
  warn: '#7C4E06',
  warnSoft: '#F7EAD8',
  danger: '#A02531',
  /** Pressed state of a danger-filled control; white text stays AA. */
  dangerPressed: '#7C1B24',
  dangerSoft: '#F8E5E6',
} as const;

export type ThemeToken = (typeof theme)[keyof typeof theme];

/** Relative luminance of a `#RRGGBB` colour, per WCAG 2.1. */
export function relativeLuminance(hex: string): number {
  const channels = [0, 2, 4].map((offset) => {
    const byte = parseInt(hex.slice(offset + 1, offset + 3), 16) / 255;

    return byte <= 0.03928 ? byte / 12.92 : Math.pow((byte + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG 2.1 contrast ratio between two colours, from 1 (identical) to 21. */
export function contrastRatio(foreground: string, background: string): number {
  const foregroundLum = relativeLuminance(foreground);
  const backgroundLum = relativeLuminance(background);
  const lighter = Math.max(foregroundLum, backgroundLum);
  const darker = Math.min(foregroundLum, backgroundLum);

  return (lighter + 0.05) / (darker + 0.05);
}
