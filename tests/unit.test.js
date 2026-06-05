import { describe, it, expect } from 'vitest';
import { maxYear, calcGapScore } from '../utils.js';

// ── maxYear ───────────────────────────────────────────────────

describe('maxYear', () => {
  it('extracts year from plain version', () => {
    expect(maxYear('2019')).toBe('2019');
  });

  it('picks the highest year from compound version', () => {
    expect(maxYear('2006+AMD1:2015')).toBe('2015');
  });

  it('picks higher year from two years in version string', () => {
    expect(maxYear('2015+Cor1:2016')).toBe('2016');
  });

  it('returns null for null input', () => {
    expect(maxYear(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(maxYear('')).toBeNull();
  });

  it('returns null when no 4-digit sequence present', () => {
    expect(maxYear('Rev.3')).toBeNull();
  });

  it('returns null for dash placeholder', () => {
    expect(maxYear('—')).toBeNull();
  });
});

// ── calcGapScore ──────────────────────────────────────────────

describe('calcGapScore', () => {
  it('returns 0 for empty changes', () => {
    expect(calcGapScore([])).toBe(0);
  });

  it('scores high impact as 20', () => {
    expect(calcGapScore([{ impact: 'high' }])).toBe(20);
  });

  it('scores medium impact as 10', () => {
    expect(calcGapScore([{ impact: 'medium' }])).toBe(10);
  });

  it('scores low impact as 5', () => {
    expect(calcGapScore([{ impact: 'low' }])).toBe(5);
  });

  it('sums mixed impacts correctly', () => {
    // high(20) + medium(10) + low(5) = 35
    expect(calcGapScore([
      { impact: 'high' },
      { impact: 'medium' },
      { impact: 'low' },
    ])).toBe(35);
  });

  it('caps total at 100', () => {
    // 6 × high = 120 → capped at 100
    const changes = Array(6).fill({ impact: 'high' });
    expect(calcGapScore(changes)).toBe(100);
  });

  it('treats unknown impact as low (5)', () => {
    expect(calcGapScore([{ impact: 'critical' }])).toBe(5);
  });
});
