import { useState, useEffect, useRef, useCallback } from 'react';
import { ConversationItem, ConversationSession } from '../types';
import { loadSessions, saveSessions } from '../utils/localStorage';
import { HISTORY_RENDER_STEP } from '../constants';

export function useConversationHistory() {
    const [history, setHistory] = useState<ConversationItem[]>([]);
    const [historyRenderLimit, setHistoryRenderLimit] = useState<number>(HISTORY_RENDER_STEP);
    const [sessions, setSessions] = useState<ConversationSession[]>([]);
    const [currentSessionId, setCurrentSessionId] = useState<string>('');
    const [isSessionsReady, setIsSessionsReady] = useState(false);
    const [isOutputOnly, setIsOutputOnly] = useState(false);
    const isHydratingHistoryRef = useRef(false);

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
            ? String(history[0].original || '').trim().slice(0, 24)
            : undefined;

        setSessions((prev) => {
            const idx = prev.findIndex((s) => s.id === currentSessionId);
            if (idx >= 0) {
                const prevSession = prev[idx];
                const nextTitle = prevSession.title || titleCandidate || '새 대화';
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

    useEffect(() => {
        if (!isSessionsReady) return;
        saveSessions(sessions);
    }, [sessions, isSessionsReady]);

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
        loadSession,
        deleteSession
    };
}
