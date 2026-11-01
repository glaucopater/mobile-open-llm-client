import { describe, expect, it } from 'vitest';

import { contrastRatio, theme } from '../theme';

/** AA for body text at the sizes used here (11–15px is not "large text"). */
const TEXT_MIN = 4.5;
/** AA for visible boundaries and controls (WCAG 1.4.11). */
const UI_MIN = 3;

const surfaces = [theme.bg, theme.surface, theme.surfaceAlt, theme.card];

describe('palette contrast', () => {
  it.each(surfaces)('keeps body text readable on %s', (surface) => {
    expect(contrastRatio(theme.text, surface)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrastRatio(theme.muted, surface)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrastRatio(theme.subtle, surface)).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it('keeps status text readable on its own tint', () => {
    expect(contrastRatio(theme.ok, theme.okSoft)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrastRatio(theme.warn, theme.warnSoft)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrastRatio(theme.danger, theme.dangerSoft)).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it('reads on filled controls, including the pressed state', () => {
    expect(contrastRatio('#FFFFFF', theme.accent)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrastRatio('#FFFFFF', theme.accentPressed)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrastRatio('#FFFFFF', theme.danger)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrastRatio('#FFFFFF', theme.dangerPressed)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrastRatio(theme.accentText, theme.accentSoft)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrastRatio(theme.muted, theme.disabled)).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it('makes boundaries visible against the surfaces they sit on', () => {
    expect(contrastRatio(theme.border, theme.bg)).toBeGreaterThanOrEqual(UI_MIN);
    expect(contrastRatio(theme.border, theme.surface)).toBeGreaterThanOrEqual(UI_MIN);
    expect(contrastRatio(theme.border, theme.surfaceAlt)).toBeGreaterThanOrEqual(UI_MIN);
    expect(contrastRatio(theme.borderStrong, theme.card)).toBeGreaterThanOrEqual(UI_MIN);
    expect(contrastRatio(theme.accent, theme.bg)).toBeGreaterThanOrEqual(UI_MIN);
  });
});
