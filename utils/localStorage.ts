import { ConversationItem, ConversationSession } from '../types';

const HISTORY_KEY = 'global_classroom_history';
const SESSIONS_KEY = 'global_classroom_sessions';

/**
 * Upper bound for locally stored conversation sessions (#39).
 *
 * Grounding:
 * - saveSessions() strips audioBase64, so a session is text/metadata only
 *   (~1-2KB per item with multi-target translations; a typical session is
 *   well under ~150KB).
 * - localStorage (~5MB) is shared with settings, auth tokens, interview
 *   glossary, etc., so history should stay comfortably below ~3-4MB.
 * - HistoryModal only surfaces the latest 20 sessions.
 *
 * 30 keeps the visible list plus margin while bounding worst-case payload
 * to roughly 3MB. Oldest inactive sessions are pruned deterministically;
 * the current session is never removed by retention.
 */
export const MAX_LOCAL_SESSIONS = 30;

export type SaveSessionsFailureReason = 'quota' | 'unavailable' | 'unknown';

export type SaveSessionsResult =
  | { ok: true }
  | { ok: false; reason: SaveSessionsFailureReason };


const isLegacyHistoryArray = (value: any): value is ConversationItem[] => {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  const x = value[0];
  return !!x && typeof x === 'object' && typeof x.original === 'string' && !Array.isArray((x as any).items);
};

const isSessionArray = (value: any): value is ConversationSession[] => {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  const x = value[0];
  return !!x && typeof x === 'object' && Array.isArray((x as any).items);
};

export const loadSessions = (): ConversationSession[] => {
  try {
    const rawSessions = localStorage.getItem(SESSIONS_KEY);
    if (rawSessions) {
      const parsed = JSON.parse(rawSessions);
      if (isSessionArray(parsed)) return parsed;
    }

    const legacy = localStorage.getItem(HISTORY_KEY);
    if (!legacy) return [];

    const parsedLegacy = JSON.parse(legacy);
    if (!isLegacyHistoryArray(parsedLegacy)) return [];

    const now = Date.now();
    const migrated: ConversationSession[] = [
      {
        id: `legacy_${now}`,
        createdAt: now,
        updatedAt: now,
        items: parsedLegacy,
        title: parsedLegacy[0]?.original ? String(parsedLegacy[0].original).slice(0, 24) : undefined,
      },
    ];

    const saveResult = saveSessions(migrated);
    if (saveResult.ok === false) {
      console.warn('Legacy history retained because the migrated copy could not be saved', saveResult.reason);
    } else {
      // Only drop the legacy key once the migrated copy is safely written,
      // so a failed write can never destroy the original history (#39).
      localStorage.removeItem(HISTORY_KEY);
    }
    return migrated;
  } catch (e) {
    console.error('Failed to load sessions from local storage', e);
    return [];
  }
};

export const classifyStorageWriteError = (error: unknown): SaveSessionsFailureReason => {
  if (error && typeof error === 'object') {
    const err = error as { name?: unknown; code?: unknown };
    const name = typeof err.name === 'string' ? err.name : '';
    // Quota errors differ per browser; keep this bounded to the known cases.
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return 'quota';
    if (err.code === 22 || err.code === 1014) return 'quota'; // legacy WebKit/Firefox codes
    // Storage access blocked (e.g. sandboxed/disabled storage).
    if (name === 'SecurityError') return 'unavailable';
  }
  return 'unknown';
};

export const saveSessions = (sessions: ConversationSession[]): SaveSessionsResult => {
  try {
    if (typeof localStorage === 'undefined') {
      return { ok: false, reason: 'unavailable' };
    }

    // Create a version of history without the heavy audioBase64 data
    // We only store the metadata and text to avoid hitting localStorage quotas (usually 5MB)
    const sessionsToSave = sessions.map((s) => ({
      ...s,
      items: (s.items || []).map((item) => {
        // Destructure to separate audio data
        const { audioBase64, ...metaData } = item;
        return metaData;
      }),
    }));

    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessionsToSave));
    return { ok: true };
  } catch (e) {
    console.error('Failed to save sessions to local storage', e);
    return { ok: false, reason: classifyStorageWriteError(e) };
  }
};

/**
 * Bounded retention for local sessions (#39).
 *
 * The sessions list is newest-first (new sessions are prepended), so the
 * oldest inactive sessions are dropped first — deterministically by
 * createdAt, with array position (tail = older) breaking ties. The current
 * session is ALWAYS kept, even when it is the oldest entry.
 */
export const pruneSessionsForRetention = (
  sessions: ConversationSession[],
  currentSessionId: string
): ConversationSession[] => {
  if (sessions.length <= MAX_LOCAL_SESSIONS) return sessions;

  const excess = sessions.length - MAX_LOCAL_SESSIONS;
  const removable = sessions
    .map((session, index) => ({ session, index }))
    .filter(({ session }) => session.id !== currentSessionId)
    .sort((a, b) => (a.session.createdAt - b.session.createdAt) || (b.index - a.index));

  const removeIndexes = new Set(removable.slice(0, excess).map(({ index }) => index));
  return sessions.filter((_, index) => !removeIndexes.has(index));
};

/**
 * Bounded notification gate so a persisting save failure does not spam the
 * user with a toast on every state update (#39).
 */
export const SAVE_FAILURE_NOTIFY_MIN_INTERVAL_MS = 30_000;

export interface SaveFailureGate {
  shouldNotify: (reason: SaveSessionsFailureReason) => boolean;
}

export const createSaveFailureGate = (
  options: { minIntervalMs?: number; now?: () => number } = {}
): SaveFailureGate => {
  const minIntervalMs = options.minIntervalMs ?? SAVE_FAILURE_NOTIFY_MIN_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let lastNotifiedAt = Number.NEGATIVE_INFINITY;

  return {
    shouldNotify: (reason: SaveSessionsFailureReason): boolean => {
      const timestamp = now();
      if (timestamp - lastNotifiedAt < minIntervalMs) return false;
      lastNotifiedAt = timestamp;
      void reason;
      return true;
    },
  };
};

export const clearSessions = () => {
  try {
    localStorage.removeItem(SESSIONS_KEY);
    localStorage.removeItem(HISTORY_KEY);
  } catch (e) {
    console.error('Failed to clear local sessions', e);
  }
};
