import { useState, useEffect, useRef, useCallback } from 'react';
import { ConversationItem, ConversationSession } from '../types';
import {
    loadSessions,
    saveSessions,
    pruneSessionsForRetention,
    createSaveFailureGate,
    SaveFailureGate,
    SaveSessionsFailureReason,
} from '../utils/localStorage';
import { HISTORY_RENDER_STEP } from '../constants';
import { sessionPreviewTitle } from '../utils/sessionMetadata';

interface UseConversationHistoryProps {
    // Called when persisting sessions fails so the app can surface it (#39).
    onSaveFailure?: (reason: SaveSessionsFailureReason) => void;
}

export function useConversationHistory({ onSaveFailure }: UseConversationHistoryProps = {}) {
    const [history, setHistory] = useState<ConversationItem[]>([]);
    const [historyRenderLimit, setHistoryRenderLimit] = useState<number>(HISTORY_RENDER_STEP);
    const [sessions, setSessions] = useState<ConversationSession[]>([]);
    const [currentSessionId, setCurrentSessionId] = useState<string>('');
    const [isSessionsReady, setIsSessionsReady] = useState(false);
    const [isOutputOnly, setIsOutputOnly] = useState(false);
    const isHydratingHistoryRef = useRef(false);
    // Keep rapid transcription/translation/answer updates off the synchronous
    // localStorage write path; flush on page hide or hook teardown (#87).
    const pendingSessionsSaveRef = useRef<ConversationSession[] | null>(null);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const historyUpdatedForSaveRef = useRef(false);
    const lastPersistedSessionIdRef = useRef('');
    // Latest-callback ref: the app may pass an inline arrow, and the save
    // effect must not re-run (and re-save) just because its identity changed.
    const onSaveFailureRef = useRef(onSaveFailure);
    const saveFailureGateRef = useRef<SaveFailureGate | null>(null);
    if (!saveFailureGateRef.current) {
        saveFailureGateRef.current = createSaveFailureGate();
    }

    // 1. Load sessions on mount
    useEffect(() => {
        try {
            const loaded = loadSessions();
            if (loaded.length === 0) {
                const now = Date.now();
                const initial: ConversationSession = {
                    id: `local_${now}`,
                    createdAt: now,
                    updatedAt: now,
                    items: [],
                    title: '새 대화',
                };
                setSessions([initial]);
                setCurrentSessionId(initial.id);
                isHydratingHistoryRef.current = true;
                setHistory([]);
            } else {
                const latest = loaded.reduce((acc, cur) => {
                    const a = typeof acc.updatedAt === 'number' ? acc.updatedAt : acc.createdAt;
                    const b = typeof cur.updatedAt === 'number' ? cur.updatedAt : cur.createdAt;
                    return b > a ? cur : acc;
                }, loaded[0]);

                setSessions(loaded);
                setCurrentSessionId(latest.id);
                isHydratingHistoryRef.current = true;
                setHistory([...(latest.items || [])]);
            }
        } catch (e) {
            console.error('Failed to load local sessions', e);
            const now = Date.now();
            const initial: ConversationSession = {
                id: `local_${now}`,
                createdAt: now,
                updatedAt: now,
                items: [],
                title: '새 대화',
            };
            setSessions([initial]);
            setCurrentSessionId(initial.id);
            isHydratingHistoryRef.current = true;
            setHistory([]);
        } finally {
            setIsSessionsReady(true);
        }
    }, []);

    // 2. Auto-sync history to sessions and save to localStorage
    useEffect(() => {
        if (!isSessionsReady || !currentSessionId) return;
        if (isHydratingHistoryRef.current) {
            isHydratingHistoryRef.current = false;
            return;
        }

        const now = Date.now();
        const titleCandidate = history.length > 0
            ? sessionPreviewTitle({ title: '새 대화', items: history })
            : undefined;

        // Identify high-frequency transcript/translation updates so only these
        // are debounced. Session creation/deletion remains immediate.
        historyUpdatedForSaveRef.current = true;
        setSessions((prev) => {
            const idx = prev.findIndex((s) => s.id === currentSessionId);
            if (idx >= 0) {
                const prevSession = prev[idx];
                const nextTitle = !prevSession.title || prevSession.title === '새 대화'
                    ? (titleCandidate || '새 대화')
                    : prevSession.title;
                const nextSession: ConversationSession = {
                    ...prevSession,
                    updatedAt: now,
                    items: history,
                    title: nextTitle,
                };
                const next = prev.slice();
                next[idx] = nextSession;
                return next;
            }

            const nextTitle = titleCandidate || '새 대화';
            const newSession: ConversationSession = {
                id: currentSessionId,
                createdAt: now,
                updatedAt: now,
                items: history,
                title: nextTitle,
            };
            return [newSession, ...prev];
        });
    }, [history, currentSessionId, isSessionsReady]);

    // Track the latest failure callback without re-triggering saves.
    useEffect(() => {
        onSaveFailureRef.current = onSaveFailure;
    }, [onSaveFailure]);

    const flushSessionsSave = useCallback(() => {
        if (saveTimerRef.current !== null) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        const snapshot = pendingSessionsSaveRef.current;
        pendingSessionsSaveRef.current = null;
        if (!snapshot) return;
        const result = saveSessions(snapshot);
        if (result.ok === false) {
            console.error('Failed to persist conversation sessions', result.reason);
            if (saveFailureGateRef.current?.shouldNotify(result.reason)) {
                onSaveFailureRef.current?.(result.reason);
            }
        }
    }, []);

    // Always flush pending transcripts when the tab is backgrounded/closed.
    // Register once, not once per history change.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') flushSessionsSave();
        };
        window.addEventListener('pagehide', flushSessionsSave);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            window.removeEventListener('pagehide', flushSessionsSave);
            document.removeEventListener('visibilitychange', onVisibility);
            flushSessionsSave();
        };
    }, [flushSessionsSave]);

    useEffect(() => {
        if (!isSessionsReady) return;

        const pruned = pruneSessionsForRetention(sessions, currentSessionId);
        if (pruned !== sessions) {
            setSessions(prev => pruneSessionsForRetention(prev, currentSessionId));
            return;
        }

        // Synchronous JSON.stringify + localStorage writes can delay main-thread
        // UI and Live audio delivery as a session grows. Coalesce fast updates.
        // Explicit session switching/creating still saves immediately (#39).
        pendingSessionsSaveRef.current = sessions;
        const shouldDebounce = historyUpdatedForSaveRef.current &&
            lastPersistedSessionIdRef.current === currentSessionId;
        historyUpdatedForSaveRef.current = false;
        lastPersistedSessionIdRef.current = currentSessionId;

        if (saveTimerRef.current !== null) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        if (shouldDebounce) {
            saveTimerRef.current = setTimeout(flushSessionsSave, 750);
        } else {
            flushSessionsSave();
        }
    }, [sessions, isSessionsReady, currentSessionId, flushSessionsSave]);

    // 3. Methods
    const handleNewConversation = useCallback(() => {
        const now = Date.now();
        const newSession: ConversationSession = {
            id: `local_${now}`,
            createdAt: now,
            updatedAt: now,
            items: [],
            title: '새 대화',
        };
        setSessions(prev => [newSession, ...prev]);
        setCurrentSessionId(newSession.id);
        isHydratingHistoryRef.current = true;
        setHistory([]);
        setHistoryRenderLimit(HISTORY_RENDER_STEP);
    }, []);

    const handleMergeWithAbove = useCallback((id: string) => {
        setHistory(prev => {
            const idx = prev.findIndex(item => item.id === id);
            if (idx <= 0) return prev;
            const current = prev[idx];
            const above = prev[idx - 1];
            const merged: ConversationItem = {
                ...above,
                original: (above.original + ' ' + current.original).trim(),
                translated: ((above.translated || '') + ' ' + (current.translated || '')).trim(),
                updatedAt: Date.now(),
            };
            const next = [...prev];
            next.splice(idx - 1, 2, merged);
            return next;
        });
    }, []);

    const handleMergeWithBelow = useCallback((id: string) => {
        setHistory(prev => {
            const idx = prev.findIndex(item => item.id === id);
            if (idx === -1 || idx === prev.length - 1) return prev;
            const current = prev[idx];
            const below = prev[idx + 1];
            const merged: ConversationItem = {
                ...current,
                original: (current.original + ' ' + below.original).trim(),
                translated: ((current.translated || '') + ' ' + (below.translated || '')).trim(),
                updatedAt: Date.now(),
            };
            const next = [...prev];
            next.splice(idx, 2, merged);
            return next;
        });
    }, []);

    const handleSplitItem = useCallback((id: string, originalSplitIdx: number, translatedSplitIdx: number) => {
        setHistory(prev => {
            const idx = prev.findIndex(item => item.id === id);
            if (idx === -1) return prev;
            const current = prev[idx];

            const item1: ConversationItem = {
                ...current,
                id: crypto.randomUUID(),
                original: current.original.substring(0, originalSplitIdx).trim(),
                translated: current.translated.substring(0, translatedSplitIdx).trim(),
                updatedAt: Date.now(),
            };
            const item2: ConversationItem = {
                ...current,
                id: crypto.randomUUID(),
                original: current.original.substring(originalSplitIdx).trim(),
                translated: current.translated.substring(translatedSplitIdx).trim(),
                updatedAt: Date.now(),
            };

            const next = [...prev];
            next.splice(idx, 1, item1, item2);
            return next;
        });
    }, []);

    const loadSession = useCallback((session: ConversationSession) => {
        setCurrentSessionId(session.id);
        isHydratingHistoryRef.current = true;
        setHistory([...(session.items || [])]);
        setHistoryRenderLimit(HISTORY_RENDER_STEP);
    }, []);

    const handleSaveEdit = useCallback((id: string, original: string, translated: string) => {
        setHistory(prev => prev.map(item => {
            if (item.id !== id) return item;
            const sourceChanged = original !== item.original;
            const translationChanged = translated !== item.translated;
            // Keep the displayed variant of a multi-target row in sync with the
            // active translation the user just edited.
            const variantTarget = item.activeTarget;
            const activeVariant = item.translations && variantTarget
                ? item.translations[variantTarget]
                : undefined;
            const translations = activeVariant
                ? {
                    ...item.translations,
                    [variantTarget as string]: {
                        ...activeVariant,
                        text: translated,
                        kind: translationChanged ? 'manual' : activeVariant.kind,
                        stale: translationChanged ? false : (sourceChanged ? true : activeVariant.stale),
                        updatedAt: Date.now(),
                    },
                }
                : item.translations;
            return {
                ...item,
                original,
                translated,
                translations,
                translationStale: translationChanged ? false : (sourceChanged ? true : item.translationStale),
                translationKind: translationChanged ? 'manual' : item.translationKind,
                updatedAt: Date.now(),
            };
        }));
    }, []);

    const handleClearSessions = useCallback(() => {
        const now = Date.now();
        const initial: ConversationSession = {
            id: `local_${now}`,
            createdAt: now,
            updatedAt: now,
            items: [],
            title: '새 대화',
        };
        setSessions([initial]);
        setCurrentSessionId(initial.id);
        isHydratingHistoryRef.current = true;
        setHistory([]);
    }, []);

    const deleteSession = useCallback((id: string) => {
        setSessions(prev => {
            const next = prev.filter(s => s.id !== id);
            if (next.length === 0) {
                const now = Date.now();
                const initial: ConversationSession = {
                    id: `local_${now}`,
                    createdAt: now,
                    updatedAt: now,
                    items: [],
                    title: '새 대화',
                };
                return [initial];
            }
            return next;
        });
        if (currentSessionId === id) {
            setSessions(prev => {
                const latest = prev[0];
                setCurrentSessionId(latest.id);
                isHydratingHistoryRef.current = true;
                setHistory([...(latest.items || [])]);
                return prev;
            });
        }
    }, [currentSessionId]);

    return {
        history,
        setHistory,
        historyRenderLimit,
        setHistoryRenderLimit,
        sessions,
        setSessions,
        currentSessionId,
        setCurrentSessionId,
        isSessionsReady,
        isOutputOnly,
        setIsOutputOnly,
        handleNewConversation,
        handleMergeWithAbove,
        handleMergeWithBelow,
        handleSplitItem,
        handleSaveEdit,
        handleClearSessions,
        loadSession,
        deleteSession
    };
}
