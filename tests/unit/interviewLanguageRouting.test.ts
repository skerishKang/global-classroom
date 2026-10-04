import { test, expect, describe } from 'vitest';
import {
  InterviewLanguagePolicy,
  detectSourceLanguageHeuristic,
  formatPairRules,
  formatTargetBadge,
  getDefaultTargets,
  getTargetsForSource,
  normalizeLanguageCode,
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

  test('BCP-47 tags normalize to the canonical base language', () => {
    expect(normalizeLanguageCode('ko-KR')).toBe('ko');
    expect(normalizeLanguageCode('en-US')).toBe('en');
    expect(normalizeLanguageCode('vi-VN')).toBe('vi');
    expect(normalizeLanguageCode('ja-JP')).toBe('ja');
    // case, whitespace and underscores are normalized too
    expect(normalizeLanguageCode(' EN_us ')).toBe('en');
    // script/region subtags are ignored per the base-language contract
    expect(normalizeLanguageCode('zh-Hant-TW')).toBe('zh');
    expect(normalizeLanguageCode('')).toBe('');
  });

  test('region-tagged sources are excluded exactly like their base language', () => {
    const pair: InterviewLanguagePolicy = { targets: ['ko', 'en'] };
    expect(getTargetsForSource('ko-KR', pair)).toEqual(['en']);
    expect(getTargetsForSource('en-US', pair)).toEqual(['ko']);

    const withVi: InterviewLanguagePolicy = { targets: ['ko', 'en', 'vi'] };
    expect(getTargetsForSource('vi-VN', withVi)).toEqual(['ko', 'en']);

    const withJa: InterviewLanguagePolicy = { targets: ['ko', 'en', 'ja'] };
    expect(getTargetsForSource('ja-JP', withJa)).toEqual(['ko', 'en']);
  });

  test('pair rules apply to the canonicalized source', () => {
    const policy: InterviewLanguagePolicy = {
      targets: ['ko', 'en', 'ja'],
      pairRules: [{ source: 'ja', target: 'en' }],
    };
    expect(getTargetsForSource('ja-JP', policy)).toEqual(['en']);
    // Rule text itself is parsed into canonical form.
    expect(parsePairRules('JA-JP -> EN-US')).toEqual([{ source: 'ja', target: 'en' }]);
  });

  test('sanitizeTargets canonicalizes stored codes', () => {
    expect(sanitizeTargets(['KO ', 'en-US', 'ko', 'auto'])).toEqual(['ko', 'en']);
  });
});
