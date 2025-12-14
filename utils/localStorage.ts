import { ConversationItem, ConversationSession } from '../types';

const HISTORY_KEY = 'global_classroom_history';
const SESSIONS_KEY = 'global_classroom_sessions';

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

    saveSessions(migrated);
    localStorage.removeItem(HISTORY_KEY);
    return migrated;
  } catch (e) {
    console.error('Failed to load sessions from local storage', e);
    return [];
  }
};

export const saveSessions = (sessions: ConversationSession[]) => {
  try {
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
  } catch (e) {
    console.error('Failed to save sessions to local storage', e);
  }
};

export const clearSessions = () => {
  try {
    localStorage.removeItem(SESSIONS_KEY);
    localStorage.removeItem(HISTORY_KEY);
  } catch (e) {
    console.error('Failed to clear local sessions', e);
  }
};
