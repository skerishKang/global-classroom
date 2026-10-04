import { DEFAULT_TRANSLATION_MODEL, SETTINGS_KEY } from '../constants';
import { AppSettings } from '../types';
import { getDefaultTargets, sanitizeTargets } from './interviewLanguageRouting';

/**
 * Settings storage helpers (#32).
 *
 * Personal API keys (userApiKey / savedApiKeys) are credentials and must stay
 * on this device only. These helpers read from and write to this browser's
 * localStorage exclusively — they never touch Firestore/cloud profiles.
 */

export function createDefaultSettings(): AppSettings {
  return {
    driveBackupMode: 'manual',
    audioCacheEnabled: true,
    recordOriginalEnabled: true,
    userApiKey: '',
    translationModel: DEFAULT_TRANSLATION_MODEL,
    interviewTargets: [...getDefaultTargets()],
    savedApiKeys: [],
  };
}

/**
 * Sanitize favorite key slots read from local storage (#32): only non-empty
 * strings survive, duplicates are removed, insertion order is preserved.
 * e.g. ['key-a', 123, '', 'key-a'] -> ['key-a']
 */
export function sanitizeApiKeySlots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const slots: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const key = item.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    slots.push(key);
  }
  return slots;
}

/** Pure parser for the local settings blob (contents of SETTINGS_KEY). */
export function parseStoredSettings(raw: string | null): AppSettings {
  if (!raw) return createDefaultSettings();
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>;

    // 마이그레이션: gemini-2.5-flash 사용자는 flash-lite로 강제 이동 (무료 쿼터 소진 방지)
    let migratedModel = parsed.translationModel;
    if (migratedModel === 'gemini-2.5-flash') {
      migratedModel = DEFAULT_TRANSLATION_MODEL; // gemini-2.5-flash-lite
      console.log('[Settings Migration] Upgraded translationModel from gemini-2.5-flash to flash-lite');
    }

    const storedTargets = sanitizeTargets(
      Array.isArray(parsed.interviewTargets)
        ? parsed.interviewTargets.filter((code): code is string => typeof code === 'string')
        : []
    );

    return {
      driveBackupMode: parsed.driveBackupMode === 'auto' ? 'auto' : 'manual',
      audioCacheEnabled: typeof parsed.audioCacheEnabled === 'boolean' ? parsed.audioCacheEnabled : true,
      recordOriginalEnabled: typeof parsed.recordOriginalEnabled === 'boolean' ? parsed.recordOriginalEnabled : true,
      // 로컬에 입력된 개인 키만 사용한다. cloud profile 값은 여기로 유입될 수 없다 (#32).
      userApiKey: typeof parsed.userApiKey === 'string' ? parsed.userApiKey : '',
      translationModel: migratedModel || DEFAULT_TRANSLATION_MODEL,
      interviewTargets: storedTargets.length > 0 ? storedTargets : [...getDefaultTargets()],
      // 즐겨찾기 키 슬롯도 저장소에서 복원하되 신뢰하지 않고 sanitize 한다 (#32).
      savedApiKeys: sanitizeApiKeySlots(parsed.savedApiKeys),
    };
  } catch {
    return createDefaultSettings();
  }
}

/** Read settings from this browser's localStorage only. */
export function loadSettings(): AppSettings {
  try {
    return parseStoredSettings(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return createDefaultSettings();
  }
}

/**
 * Persist settings to this browser's localStorage only.
 * Personal API keys must never be written to the cloud (#32).
 */
export function persistSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
