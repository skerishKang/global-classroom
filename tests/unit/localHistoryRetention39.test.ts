import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  MAX_LOCAL_SESSIONS,
  SAVE_FAILURE_NOTIFY_MIN_INTERVAL_MS,
  classifyStorageWriteError,
  createSaveFailureGate,
  loadSessions,
  pruneSessionsForRetention,
  saveSessions,
} from '../../utils/localStorage';
import { ConversationSession } from '../../types';

/**
 * Issue #39 — local session retention, save-failure contract and legacy
 * migration behavior. Runs against an in-memory localStorage double with
 * controllable failure modes.
 */
type FailMode = 'none' | 'generic' | 'quota' | 'quota-firefox' | 'quota-code' | 'security';

const store = new Map<string, string>();
let failMode: FailMode = 'none';

const SESSIONS_KEY = 'global_classroom_sessions';
const HISTORY_KEY = 'global_classroom_history';

const installLocalStorage = () => {
  const storage = {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      if (failMode !== 'none') {
        if (failMode === 'generic') throw new Error('write failed');
        if (failMode === 'quota') {
          throw Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError', code: 22 });
        }
        if (failMode === 'quota-firefox') {
          throw Object.assign(new Error('quota exceeded'), { name: 'NS_ERROR_DOM_QUOTA_REACHED', code: 1014 });
        }
        if (failMode === 'quota-code') {
          // Legacy WebKit: numeric code only, generic name.
          throw Object.assign(new Error('quota exceeded'), { name: 'Error', code: 22 });
        }
        if (failMode === 'security') {
          throw Object.assign(new Error('storage blocked'), { name: 'SecurityError' });
        }
      }
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
};

const makeSession = (id: string, createdAt: number, items: any[] = []): ConversationSession => ({
  id,
  createdAt,
  updatedAt: createdAt,
  items,
  title: `title-${id}`,
});

// newest-first: index 0 has the largest createdAt, the tail is the oldest.
const buildSessions = (count: number): ConversationSession[] =>
  Array.from({ length: count }, (_, i) => makeSession(`s${i}`, 100_000 - i));

beforeEach(() => {
  store.clear();
  failMode = 'none';
  installLocalStorage();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#39 pruneSessionsForRetention', () => {
  test('1. at or under MAX is returned unchanged', () => {
    const atMax = buildSessions(MAX_LOCAL_SESSIONS);
    expect(pruneSessionsForRetention(atMax, 's0')).toBe(atMax);

    const under = buildSessions(MAX_LOCAL_SESSIONS - 10);
    expect(pruneSessionsForRetention(under, 's0')).toBe(under);
  });

  test('2. over MAX prunes the oldest inactive sessions, order preserved', () => {
    const sessions = buildSessions(MAX_LOCAL_SESSIONS + 5);
    const result = pruneSessionsForRetention(sessions, 's0'); // active = newest

    expect(result).toHaveLength(MAX_LOCAL_SESSIONS);
    expect(result.map(s => s.id)).toEqual(
      Array.from({ length: MAX_LOCAL_SESSIONS }, (_, i) => `s${i}`)
    );
    // the five oldest tail entries are gone
    for (const dropped of ['s34', 's33', 's32', 's31', 's30']) {
      expect(result.some(s => s.id === dropped)).toBe(false);
    }
    expect(result.some(s => s.id === 's0')).toBe(true);
  });

  test('3. active session is the oldest → still preserved', () => {
    const count = MAX_LOCAL_SESSIONS + 5;
    const sessions = buildSessions(count);
    const activeId = `s${count - 1}`; // tail = oldest
    const result = pruneSessionsForRetention(sessions, activeId);

    expect(result).toHaveLength(MAX_LOCAL_SESSIONS);
    expect(result.some(s => s.id === activeId)).toBe(true);
    // excess comes from the remaining oldest sessions instead
    expect(result.some(s => s.id === `s${count - 2}`)).toBe(false);
    expect(result.some(s => s.id === 's0')).toBe(true);
  });

  test('4. active session in the middle (and inside the oldest zone) → preserved', () => {
    const count = MAX_LOCAL_SESSIONS + 5;
    const sessions = buildSessions(count);

    const middleId = `s${Math.floor(count / 2)}`;
    const middleResult = pruneSessionsForRetention(sessions, middleId);
    expect(middleResult).toHaveLength(MAX_LOCAL_SESSIONS);
    expect(middleResult.some(s => s.id === middleId)).toBe(true);

    // Active sitting where pruning would normally strike (2nd oldest).
    const zoneId = `s${count - 2}`;
    const zoneResult = pruneSessionsForRetention(sessions, zoneId);
    expect(zoneResult).toHaveLength(MAX_LOCAL_SESSIONS);
    expect(zoneResult.some(s => s.id === zoneId)).toBe(true);
    expect(zoneResult.some(s => s.id === `s${count - 1}`)).toBe(false); // true oldest dropped
    expect(zoneResult.some(s => s.id === 's29')).toBe(false); // excess taken from next-oldest after skipping active
    expect(zoneResult.some(s => s.id === 's0')).toBe(true);
  });

  test('ties on createdAt prune deterministically from the tail', () => {
    const count = MAX_LOCAL_SESSIONS + 3;
    const sessions = Array.from({ length: count }, (_, i) => makeSession(`s${i}`, 5_000));
    const result = pruneSessionsForRetention(sessions, 's0');

    expect(result).toHaveLength(MAX_LOCAL_SESSIONS);
    expect(result.map(s => s.id)).toEqual(
      Array.from({ length: MAX_LOCAL_SESSIONS }, (_, i) => `s${i}`)
    );
  });
});

describe('#39 saveSessions result contract', () => {
  test('5. normal save → ok=true and audio stripped', () => {
    const sessions: ConversationSession[] = [
      makeSession('s1', 1_000, [
        { id: 'i1', original: 'hello', translated: '안녕', audioBase64: 'AAAA', translationKind: 'auto' },
      ]),
    ];

    const result = saveSessions(sessions);
    expect(result).toEqual({ ok: true });

    const raw = store.get(SESSIONS_KEY);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw as string);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].items[0].original).toBe('hello');
    expect(parsed[0].items[0].audioBase64).toBeUndefined();
  });

  test('6. setItem throws → ok=false (generic failure classified)', () => {
    failMode = 'generic';
    const result = saveSessions([makeSession('s1', 1_000)]);
    expect(result).toEqual({ ok: false, reason: 'unknown' });
    expect(store.has(SESSIONS_KEY)).toBe(false);
  });

  test('7. quota/security errors are classified across browser variants', () => {
    failMode = 'quota';
    expect(saveSessions([makeSession('s1', 1_000)])).toEqual({ ok: false, reason: 'quota' });

    failMode = 'quota-firefox';
    expect(saveSessions([makeSession('s1', 1_000)])).toEqual({ ok: false, reason: 'quota' });

    failMode = 'quota-code';
    expect(saveSessions([makeSession('s1', 1_000)])).toEqual({ ok: false, reason: 'quota' });

    failMode = 'security';
    expect(saveSessions([makeSession('s1', 1_000)])).toEqual({ ok: false, reason: 'unavailable' });
  });

  test('classifyStorageWriteError handles known names/codes and falls back to unknown', () => {
    expect(classifyStorageWriteError(Object.assign(new Error('x'), { name: 'QuotaExceededError' }))).toBe('quota');
    expect(classifyStorageWriteError(Object.assign(new Error('x'), { name: 'NS_ERROR_DOM_QUOTA_REACHED' }))).toBe('quota');
    expect(classifyStorageWriteError(Object.assign(new Error('x'), { code: 22 }))).toBe('quota');
    expect(classifyStorageWriteError(Object.assign(new Error('x'), { code: 1014 }))).toBe('quota');
    expect(classifyStorageWriteError(Object.assign(new Error('x'), { name: 'SecurityError' }))).toBe('unavailable');
    expect(classifyStorageWriteError(new Error('boom'))).toBe('unknown');
    expect(classifyStorageWriteError(undefined)).toBe('unknown');
  });

  test('storage unavailable (no localStorage) → ok=false reason unavailable', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(saveSessions([makeSession('s1', 1_000)])).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('#39 save failure notification gate', () => {
  test('9. repeated same failure is rate-bounded (first notify, then silence, then re-remind)', () => {
    let now = 0;
    const gate = createSaveFailureGate({ minIntervalMs: SAVE_FAILURE_NOTIFY_MIN_INTERVAL_MS, now: () => now });

    expect(gate.shouldNotify('quota')).toBe(true); // first failure always surfaces
    expect(gate.shouldNotify('quota')).toBe(false); // repeated updates → no flood
    expect(gate.shouldNotify('quota')).toBe(false);
    expect(gate.shouldNotify('unknown')).toBe(false); // still inside the window

    now += SAVE_FAILURE_NOTIFY_MIN_INTERVAL_MS - 1;
    expect(gate.shouldNotify('quota')).toBe(false);

    now += 1; // window elapsed → bounded re-remind
    expect(gate.shouldNotify('quota')).toBe(true);
    expect(gate.shouldNotify('quota')).toBe(false);
  });

  test('first-ever notification works from an untouched clock', () => {
    const gate = createSaveFailureGate({ now: () => 1_000_000 });
    expect(gate.shouldNotify('unknown')).toBe(true);
    expect(gate.shouldNotify('unknown')).toBe(false);
  });
});

describe('#39 legacy migration', () => {
  test('10. legacy history migrates to a session, persists, and the legacy key is removed', () => {
    store.set(HISTORY_KEY, JSON.stringify([{ id: 'l1', original: 'hello', translated: '안녕' }]));

    const loaded = loadSessions();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toMatch(/^legacy_/);
    expect(loaded[0].items).toHaveLength(1);
    expect(loaded[0].items[0].original).toBe('hello');

    const persisted = JSON.parse(store.get(SESSIONS_KEY) as string);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(loaded[0].id);
    expect(store.has(HISTORY_KEY)).toBe(false);
  });

  test('migration write failure keeps the legacy history intact', () => {
    store.set(HISTORY_KEY, JSON.stringify([{ id: 'l1', original: 'hello', translated: '안녕' }]));
    failMode = 'quota';

    const loaded = loadSessions();

    expect(loaded).toHaveLength(1);
    // The original legacy data must survive a failed migrated write.
    expect(store.has(HISTORY_KEY)).toBe(true);
    expect(store.has(SESSIONS_KEY)).toBe(false);
  });

  test('malformed JSON still degrades to an empty list (not worsened)', () => {
    store.set(SESSIONS_KEY, '{not-json');
    expect(loadSessions()).toEqual([]);

    store.clear();
    store.set(HISTORY_KEY, 'also-not-json');
    expect(loadSessions()).toEqual([]);
  });
});

