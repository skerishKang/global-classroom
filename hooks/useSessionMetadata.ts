import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ConversationSession } from '../types';
import { makeSessionMetadataInput, needsSessionMetadata, normalizeSessionMetadata } from '../utils/sessionMetadata';

interface Params {
  sessions: ConversationSession[];
  setSessions: Dispatch<SetStateAction<ConversationSession[]>>;
  currentSessionId: string;
  isSessionsReady: boolean;
  postApi: <T>(endpoint: string, body: any, options?: { signal?: AbortSignal }) => Promise<T>;
  /** Suspend nonessential model calls when a real-time interview is connecting or live. */
  suspended?: boolean;
}

/**
 * Summarize all stored nonempty sessions, one request at a time. Old sessions
 * start immediately; the active session waits 18s after its latest edit so
 * live transcription/translation is never delayed by constant model calls.
 *
 * Persist only the model's title/summary; original items stay byte-for-byte
 * untouched. Successful sessions are never sent again, even after reload.
 */
export function useSessionMetadata({
  sessions, setSessions, currentSessionId, isSessionsReady, postApi, suspended = false,
}: Params) {
  const attemptedRef = useRef<Set<string>>(new Set());
  const runningRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const apiRef = useRef(postApi);
  apiRef.current = postApi;
  const [eligibleCurrentId, setEligibleCurrentId] = useState<string>('');
  const [activeId, setActiveId] = useState<string>('');
  const [errors, setErrors] = useState<Record<string, true>>({});
  const [revision, setRevision] = useState(0);
  const current = sessions.find((s) => s.id === currentSessionId);
  const currentCount = current?.items.length || 0;
  const currentLastUpdate = current?.updatedAt || 0;

  useEffect(() => {
    if (suspended) controllerRef.current?.abort();
  }, [suspended]);

  useEffect(() => {
    setEligibleCurrentId('');
    if (suspended || !isSessionsReady || !current || currentCount < 2 || !needsSessionMetadata(current)) return;
    const timer = window.setTimeout(() => setEligibleCurrentId(currentSessionId), 18_000);
    return () => window.clearTimeout(timer);
  }, [currentSessionId, isSessionsReady, currentCount, currentLastUpdate, suspended]);

  useEffect(() => {
    if (suspended || !isSessionsReady || runningRef.current) return;
    const candidate = sessions.find((session) =>
      needsSessionMetadata(session)
      && !attemptedRef.current.has(session.id)
      && (session.id !== currentSessionId || (session.id === eligibleCurrentId && session.items.length >= 2))
    );
    if (!candidate) return;
    const history = makeSessionMetadataInput(candidate.items);
    if (!history) return;

    attemptedRef.current.add(candidate.id);
    runningRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    setActiveId(candidate.id);
    void apiRef.current<{ title: string; summary: string }>('session-metadata', {
      history,
      lang: 'ko',
    }, { signal: controller.signal }).then((payload) => {
      if (controller.signal.aborted) return;
      const metadata = normalizeSessionMetadata(payload);
      if (!metadata) throw new Error('Invalid title or summary from model');
      setSessions((previous) => previous.map((session) =>
        session.id === candidate.id && !session.summary
          ? { ...session, title: metadata.title, summary: metadata.summary }
          : session
      ));
    }).catch((error) => {
      if (controller.signal.aborted) return;
      console.error('Session metadata generation failed:', candidate.id, error);
      setErrors((previous) => ({ ...previous, [candidate.id]: true }));
    }).finally(() => {
      if (controller.signal.aborted) attemptedRef.current.delete(candidate.id);
      if (controllerRef.current === controller) controllerRef.current = null;
      runningRef.current = false;
      setActiveId('');
      setRevision((value) => value + 1);
    });
  }, [sessions, currentSessionId, eligibleCurrentId, isSessionsReady, revision, setSessions, suspended]);

  return {
    metadataActiveId: activeId,
    metadataErrors: errors,
    metadataDone: sessions.filter((session) => Boolean(session.summary?.trim())).length,
    metadataTotal: sessions.filter(needsSessionMetadata).length + sessions.filter((session) => Boolean(session.summary?.trim())).length,
  };
}
