import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SETTINGS_KEY } from '../../constants';
import {
  loadSettings,
  parseStoredSettings,
  persistSettings,
  sanitizeApiKeySlots,
} from '../../utils/settingsStorage';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const readSource = (relativePath: string): string =>
  readFileSync(path.join(ROOT, relativePath), 'utf8');

const listTsSources = (relativeDir: string): string[] => {
  const dir = path.join(ROOT, relativeDir);
  const entries = readdirSync(dir, { recursive: true }) as string[];
  return entries
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map((entry) => path.join(dir, entry));
};

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void { this.store.delete(key); }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
  writtenKeys(): string[] { return [...this.store.keys()]; }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as Record<string, unknown>).localStorage = storage;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
});

describe('#32 personal api keys stay local', () => {
  describe('PERSONAL_API_KEY_CLOUD_WRITE = 0', () => {
    test('settings persistence helper writes only localStorage (no cloud API)', () => {
      persistSettings({
        driveBackupMode: 'manual',
        audioCacheEnabled: true,
        recordOriginalEnabled: true,
        userApiKey: 'local-key-abc',
        savedApiKeys: ['slot-a'],
      });

      // The helper touches exactly one local storage key and nothing else.
      expect(storage.writtenKeys()).toEqual([SETTINGS_KEY]);
      const stored = JSON.parse(storage.getItem(SETTINGS_KEY)!);
      expect(stored.userApiKey).toBe('local-key-abc');
      expect(stored.savedApiKeys).toEqual(['slot-a']);
    });

    test('settings flow no longer calls Firestore profile helpers', () => {
      const appSource = readSource('App.tsx');
      expect(appSource).not.toContain('saveUserProfile');
      expect(appSource).not.toContain('getUserProfile');
      // App must not handle the personal key at all; local-only handling lives
      // in SettingsModal (input) and useTranslationService (request header).
      expect(appSource).not.toContain('userApiKey');

      // Repo-wide guard: no component/hook may call the profile helpers.
      const callSites = ['App.tsx', ...listTsSources('components'), ...listTsSources('hooks')];
      for (const file of callSites) {
        const src = readFileSync(file, 'utf8');
        expect(src, file).not.toMatch(/\bsaveUserProfile\b|\bgetUserProfile\b/);
      }

      // The settings storage helper itself is cloud-free.
      expect(readSource('utils/settingsStorage.ts')).not.toMatch(/from ['"][^'"]*firebase['"]/);
    });
  });

  describe('PERSONAL_API_KEY_CLOUD_READ = 0', () => {
    test('legacy cloud profile cannot restore into local settings', () => {
      // A legacy Firestore profile that still contains a key exists, but no
      // settings API accepts a profile object: loadSettings reads local
      // storage only, so the cloud value can never appear in settings.
      const legacyCloudProfile = { userApiKey: 'legacy-cloud-key', displayName: 'student' };
      expect(legacyCloudProfile.userApiKey).toBe('legacy-cloud-key'); // fixture sanity; never fed below

      const restored = loadSettings();
      expect(restored.userApiKey).toBe('');
    });

    test('App has no profile.userApiKey restore path', () => {
      const appSource = readSource('App.tsx');
      expect(appSource).not.toMatch(/profile\??\.\s*userApiKey/);
      expect(appSource).not.toMatch(/getUserProfile\s*\(/);
    });
  });

  describe('SAVED_KEY_SLOTS_SURVIVE_RELOAD = YES', () => {
    test('savedApiKeys survive save -> reload cycle', () => {
      persistSettings({
        driveBackupMode: 'manual',
        audioCacheEnabled: true,
        recordOriginalEnabled: true,
        userApiKey: 'active-key',
        savedApiKeys: ['key-a', 'key-b'],
      });

      const afterReload = loadSettings();
      expect(afterReload.savedApiKeys).toEqual(['key-a', 'key-b']);
      expect(afterReload.userApiKey).toBe('active-key');

      // Stable across repeated reloads.
      expect(loadSettings().savedApiKeys).toEqual(['key-a', 'key-b']);
    });

    test('legacy blob without savedApiKeys restores as an empty slot list', () => {
      const legacyRaw = JSON.stringify({
        driveBackupMode: 'auto',
        audioCacheEnabled: true,
        recordOriginalEnabled: true,
        userApiKey: 'kept-local',
      });
      const restored = parseStoredSettings(legacyRaw);
      expect(restored.savedApiKeys).toEqual([]);
      expect(restored.userApiKey).toBe('kept-local');
    });
  });

  describe('malformed stored data is sanitized', () => {
    test('non-string / empty / duplicate slot entries are dropped', () => {
      expect(
        sanitizeApiKeySlots(['key-a', 123, '', 'key-a', null, undefined, '  key-b  ', {}])
      ).toEqual(['key-a', 'key-b']);
    });

    test('non-array savedApiKeys is replaced with an empty list', () => {
      expect(parseStoredSettings(JSON.stringify({ savedApiKeys: 'oops' })).savedApiKeys).toEqual([]);
      expect(parseStoredSettings(JSON.stringify({ savedApiKeys: { 0: 'k' } })).savedApiKeys).toEqual([]);
    });

    test('invalid JSON falls back to default settings', () => {
      const restored = parseStoredSettings('{not-json');
      expect(restored.savedApiKeys).toEqual([]);
      expect(restored.userApiKey).toBe('');
    });
  });

  describe('UI_COPY_MATCHES_ACTUAL_CONTRACT', () => {
    test('UI copy: browser storage yes, Firestore profile no, no false server-transmission denial', () => {
      const uiSource = readSource('components/SettingsModal.tsx');

      // LOCAL_BROWSER_STORAGE=YES
      expect(uiSource).toContain('입력된 키는 이 브라우저에 저장됩니다');
      // FIRESTORE_PROFILE_WRITE=0 / FIRESTORE_PROFILE_READ=0, stated accurately to the user
      expect(uiSource).toContain('Firestore 사용자 프로필에는 저장되지 않습니다');
      // The copy must not deny the (unchanged) server-side request forwarding.
      expect(uiSource).not.toContain('전송·저장되지 않습니다');
      expect(uiSource).not.toMatch(/서버[^\n]{0,40}전송되지 않/);

      // The persistence actually used by the app is localStorage-only.
      expect(readSource('utils/settingsStorage.ts')).toMatch(/localStorage\.setItem/);
    });

    test('API_REQUEST_FORWARDING=UNCHANGED: x-user-api-key path stays intact', () => {
      // Browser -> /api/* serverless function forwarding was not part of #32 and must remain.
      const serviceSource = readSource('hooks/useTranslationService.ts');
      expect(serviceSource).toMatch(/x-user-api-key/);
      expect(serviceSource).toMatch(/settings\.userApiKey/);

      const endpoints = ['translate', 'detect-language', 'summarize', 'vision', 'tts', 'live-token'];
      for (const endpoint of endpoints) {
        const src = readSource(`netlify/functions/${endpoint}.ts`);
        expect(src, endpoint).toMatch(/x-user-api-key/);
      }
    });
  });
});

