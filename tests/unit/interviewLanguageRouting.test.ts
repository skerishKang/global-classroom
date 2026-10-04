import { test, expect, describe } from 'vitest';
import {
  InterviewLanguagePolicy,
  detectSourceLanguageHeuristic,
  formatPairRules,
  formatTargetBadge,
  getDefaultTargets,
  getTargetsForSource,
  parsePairRules,
  pickActiveTarget,
  sanitizeTargets,
} from '../../utils/interviewLanguageRouting';

describe('interviewLanguageRouting', () => {
  test('default targets are ko + en', () => {
    expect(getDefaultTargets()).toEqual(['ko', 'en']);
  });

  test('auto routing: source is excluded', () => {
    const policy: InterviewLanguagePolicy = { targets: ['ko', 'en'] };
    expect(getTargetsForSource('ko', policy)).toEqual(['en']);
    expect(getTargetsForSource('en', policy)).toEqual(['ko']);
  });

  test('auto routing: three selected targets', () => {
    const policy: InterviewLanguagePolicy = { targets: ['ko', 'en', 'vi'] };
    expect(getTargetsForSource('ko', policy)).toEqual(['en', 'vi']);
    expect(getTargetsForSource('en', policy)).toEqual(['ko', 'vi']);
    expect(getTargetsForSource('vi', policy)).toEqual(['ko', 'en']);
  });

  test('explicit pair rules override auto routing; no rule falls back to auto', () => {
    const policy: InterviewLanguagePolicy = {
      targets: ['ko', 'en', 'vi'],
      pairRules: [{ source: 'ko', target: 'vi' }, { source: 'vi', target: 'ko' }],
    };
    expect(getTargetsForSource('ko', policy)).toEqual(['vi']);
    // No rule for 'en' → auto fallback: source excluded → ['ko', 'vi']
    expect(getTargetsForSource('en', policy)).toEqual(['ko', 'vi']);
    expect(getTargetsForSource('vi', policy)).toEqual(['ko']);
  });

  test('pair rule target filtered to selected set', () => {
    const policy: InterviewLanguagePolicy = {
      targets: ['ko'],
      pairRules: [{ source: 'ko', target: 'en' }],
    };
    // 'en' is not in selected targets → no valid rule applies → auto fallback excludes source → []
    expect(getTargetsForSource('ko', policy)).toEqual([]);
  });

  test('pair rules combine with selected targets', () => {
    const policy: InterviewLanguagePolicy = {
      targets: ['ko', 'en', 'vi'],
      pairRules: [{ source: 'ko', target: 'en' }, { source: 'ko', target: 'vi' }],
    };
    expect(getTargetsForSource('ko', policy)).toEqual(['en', 'vi']);
  });

  test('heuristic detects Korean', () => {
    expect(detectSourceLanguageHeuristic('안녕하세요')).toBe('ko');
  });

  test('heuristic detects English', () => {
    expect(detectSourceLanguageHeuristic('Hello world')).toBe('en');
  });

  test('heuristic falls back to English for unknown', () => {
    expect(detectSourceLanguageHeuristic('こんにちは')).toBe('en');
  });

  test('sanitizeTargets drops blanks, auto and duplicates while preserving order', () => {
    expect(sanitizeTargets(['ko', 'en', 'ko', 'auto', '', 'en', 'vi'])).toEqual(['ko', 'en', 'vi']);
    expect(sanitizeTargets([])).toEqual([]);
  });

  test('pickActiveTarget keeps the preferred target when still available', () => {
    expect(pickActiveTarget(['en', 'vi'], 'vi')).toBe('vi');
    expect(pickActiveTarget(['en', 'vi'], 'ko')).toBe('en');
    expect(pickActiveTarget(['en', 'vi'])).toBe('en');
    expect(pickActiveTarget([], 'en')).toBe('');
  });

  test('formatTargetBadge renders the pair and the three-plus list', () => {
    expect(formatTargetBadge(['ko', 'en'])).toBe('KO ↔ EN');
    expect(formatTargetBadge(['ko', 'en', 'vi'])).toBe('KO · EN · VI');
    expect(formatTargetBadge(['en'])).toBe('EN');
    expect(formatTargetBadge([])).toBe('');
  });

  test('parsePairRules reads the advanced settings textarea', () => {
    expect(parsePairRules('KO -> EN\nVI → KO\nja=>en')).toEqual([
      { source: 'ko', target: 'en' },
      { source: 'vi', target: 'ko' },
      { source: 'ja', target: 'en' },
    ]);
    // Self pairs and auto sources are meaningless and dropped.
    expect(parsePairRules('KO -> KO\nauto -> EN\nnot a rule')).toEqual([]);
  });

  test('formatPairRules renders rules back into the textarea format', () => {
    expect(formatPairRules([{ source: 'ko', target: 'en' }, { source: 'vi', target: 'ko' }]))
      .toBe('KO → EN\nVI → KO');
  });
});
