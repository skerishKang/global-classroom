import { describe, expect, test } from 'vitest';

import { parseStoredSettings } from '../../utils/settingsStorage';
import {
  MIN_INTERVIEW_TARGETS,
  getTargetsForSource,
  normalizeInterviewTargets,
} from '../../utils/interviewLanguageRouting';

describe('#50 interview bidirectional target invariant', () => {
  test('fewer than two targets recover to the default KO/EN pair', () => {
    expect(MIN_INTERVIEW_TARGETS).toBe(2);
    expect(normalizeInterviewTargets([])).toEqual(['ko', 'en']);
    expect(normalizeInterviewTargets(['en'])).toEqual(['ko', 'en']);
    expect(normalizeInterviewTargets(['ko'])).toEqual(['ko', 'en']);
  });

  test('two and three-plus valid target sets are preserved', () => {
    expect(normalizeInterviewTargets(['en', 'vi'])).toEqual(['en', 'vi']);
    expect(normalizeInterviewTargets(['ko', 'en', 'vi'])).toEqual(['ko', 'en', 'vi']);
  });

  test('persisted one-target settings migrate to bidirectional defaults', () => {
    const migrated = parseStoredSettings(JSON.stringify({
      interviewTargets: ['en'],
      translationModel: 'gemini-2.5-flash-lite',
    }));
    expect(migrated.interviewTargets).toEqual(['ko', 'en']);
  });

  test('valid persisted multilingual settings stay intact', () => {
    const restored = parseStoredSettings(JSON.stringify({
      interviewTargets: ['en-US', 'vi-VN', 'ko-KR'],
    }));
    expect(restored.interviewTargets).toEqual(['en', 'vi', 'ko']);
  });

  test('normalized default pair routes both directions', () => {
    const policy = { targets: normalizeInterviewTargets(['en']) };
    expect(getTargetsForSource('ko', policy)).toEqual(['en']);
    expect(getTargetsForSource('en', policy)).toEqual(['ko']);
  });
});
