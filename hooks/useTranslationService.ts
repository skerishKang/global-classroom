import React, { useCallback, useRef } from 'react';
import { Language, ConversationItem, AppSettings, GlossaryEntry, TranslationVariant } from '../types';
import { SUPPORTED_LANGUAGES } from '../constants';
import {
    getTargetsForSource,
    normalizeLanguageCode,
    pickInitialActiveTarget,
    type InterviewLanguagePolicy,
} from '../utils/interviewLanguageRouting';
import { buildAnswerRequest } from '../utils/interviewAnswer';

interface UseTranslationServiceProps {
    settings: AppSettings;
    setHistory: React.Dispatch<React.SetStateAction<ConversationItem[]>>;
    isAutoPlay: boolean;
    playTTS: (text: string, id: string) => void;
    MODEL_TRANSLATE: string;
    onQuotaExhausted?: (detail?: string) => void;
}

export function useTranslationService({
    settings,
    setHistory,
    isAutoPlay,
    playTTS,
    MODEL_TRANSLATE,
    onQuotaExhausted
}: UseTranslationServiceProps) {
    const pendingIdsRef = useRef<Set<string>>(new Set());

    const postApi = useCallback(async <T,>(endpoint: string, body: any): Promise<T> => {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (settings.userApiKey) {
            headers["x-user-api-key"] = settings.userApiKey;
        }
        const resp = await fetch(`/api/${endpoint}`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        });
        const text = await resp.text();
        if (!resp.ok) {
            // 서버가 반환한 에러 메시지와 status를 포함해 디버그
            let detail = '';
            try {
                const json = JSON.parse(text || '{}');
                detail = json?.detail || json?.error || '';
            } catch {
                detail = text;
            }
            throw new Error(`API Error ${resp.status} ${resp.statusText}${detail ? `: ${detail}` : ''}`);
        }
        return text ? JSON.parse(text) : ({} as T);
    }, [settings.userApiKey]);

    const translateText = async (
        text: string,
        id: string,
        fromLang: Language,
        toLang: Language,
        glossary: GlossaryEntry[] = [],
    ) => {
        if (pendingIdsRef.current.has(id)) return;
        pendingIdsRef.current.add(id);
        try {
            let actualFrom = fromLang.name;
            let actualTo = toLang.name;
            let detectedCode = fromLang.code;

            // Handle Auto Detection
            if (fromLang.code === 'auto') {
                try {
                    const detectRes = await postApi<{ code: string }>('detect-language', { text });
                    detectedCode = detectRes.code;
                    const detectedLang = SUPPORTED_LANGUAGES.find(l => l.code === detectedCode);
                    if (detectedLang) {
                        actualFrom = detectedLang.name;

                        // If detected language is same as toLang, we need to swap target.
                        // For example: Mode is Auto -> Vietnamese.
                        // User speaks Korean -> actualFrom=Korean, actualTo=Vietnamese.
                        // User speaks Vietnamese -> actualFrom=Vietnamese, actualTo=Korean (fallback/swap).
                        if (detectedCode === toLang.code) {
                            // Try to find a sensible 'other' language. 
                            // Default to Korean if toLang is not Korean, else English.
                            const otherCode = toLang.code === 'ko' ? 'en' : 'ko';
                            const otherLang = SUPPORTED_LANGUAGES.find(l => l.code === otherCode);
                            if (otherLang) {
                                actualTo = otherLang.name;
                            }
                        }
                    }
                } catch (de) {
                    console.error("Auto detection failed, falling back to English/target", de);
                }
            }

            const data = await postApi<{ translated: string }>('translate', {
                text,
                from: actualFrom,
                to: actualTo,
                model: MODEL_TRANSLATE,
                glossary,
            });
            const translated = data.translated?.trim() || "";
            setHistory(prev => prev.map(item =>
                item.id === id ? {
                    ...item,
                    translated,
                    isTranslating: false,
                    translationKind: 'manual',
                    translationStale: false,
                } : item
            ));
            if (isAutoPlay && translated) {
                playTTS(translated, id);
            }
        } catch (err: any) {
            console.error("Translation failed:", err);
            const msg = typeof err?.message === 'string' ? err.message : '';
            const detail = typeof err?.detail === 'string' ? err.detail : '';
            const combined = `${msg} ${detail}`.trim();
            const isQuota =
                msg.includes('429') ||
                msg.includes('RESOURCE_EXHAUSTED') ||
                detail.includes('429') ||
                detail.includes('RESOURCE_EXHAUSTED');
            if (isQuota && onQuotaExhausted) {
                onQuotaExhausted(combined);
            }
            setHistory(prev => prev.map(item =>
                item.id === id ? { ...item, translated: "번역 오류", isTranslating: false } : item
            ));
        } finally {
            pendingIdsRef.current.delete(id);
        }
    };


    //
    // Interview mode: one utterance, several target languages. The detected
    // source language is removed from the requested target set before any
    // request is made, and every result is stored as its own variant so the
    // row can switch the displayed language without re-translating.
    //
    const translateToTargets = async (
        text: string,
        id: string,
        fromLang: Language,
        policy: InterviewLanguagePolicy,
        glossary: GlossaryEntry[] = [],
        detectedCodeOverride?: string,
        preferredActiveTarget?: string
    ) => {
        const uniqueTargets = Array.from(new Set(policy.targets.filter((code) => code && code !== 'auto')));
        if (uniqueTargets.length === 0) {
            setHistory(prev => prev.map(item => item.id === id ? { ...item, isTranslating: false } : item));
            return;
        }
        if (pendingIdsRef.current.has(id)) return;
        pendingIdsRef.current.add(id);
        try {
            // Authoritative source identity for text input; a caller that already
            // knows the language (e.g. retranslation) passes it via override.
            let detectedCode = normalizeLanguageCode(detectedCodeOverride || fromLang.code);
            if (fromLang.code === 'auto' && !detectedCodeOverride) {
                try {
                    const detectRes = await postApi<{ code: string }>('detect-language', { text });
                    detectedCode = normalizeLanguageCode(detectRes.code) || detectedCode;
                } catch (de) {
                    console.error('Auto detection failed, falling back to the input language', de);
                }
            }
            const sourceLang = SUPPORTED_LANGUAGES.find(l => l.code === detectedCode) || fromLang;

            // Routing policy: explicit pair rules win when they name the source;
            // otherwise the detected source is excluded from the selected set.
            const effectiveTargets = getTargetsForSource(detectedCode, {
                targets: uniqueTargets,
                pairRules: policy.pairRules,
            });
            if (effectiveTargets.length === 0) {
                setHistory(prev => prev.map(item => item.id === id
                    ? { ...item, isTranslating: false, sourceLanguage: sourceLang.code }
                    : item
                ));
                return;
            }

            const results = await Promise.all(effectiveTargets.map(async (targetCode) => {
                const targetLang = SUPPORTED_LANGUAGES.find(l => l.code === targetCode);
                if (!targetLang) return null;
                try {
                    const data = await postApi<{ translated: string }>('translate', {
                        text,
                        from: sourceLang.name,
                        to: targetLang.name,
                        model: MODEL_TRANSLATE,
                        glossary,
                    });
                    return { targetCode, translated: data.translated?.trim() || '', error: null as any };
                } catch (err: any) {
                    return { targetCode, translated: '', error: err as any };
                }
            }));

            let quotaDetail = '';
            setHistory(prev => prev.map(item => {
                if (item.id !== id) return item;
                const translations: Record<string, TranslationVariant> = { ...(item.translations || {}) };
                for (const result of results) {
                    if (!result) continue;
                    if (result.error) {
                        const msg = typeof result.error?.message === 'string' ? result.error.message : '';
                        const detail = typeof result.error?.detail === 'string' ? result.error.detail : '';
                        if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || detail.includes('429') || detail.includes('RESOURCE_EXHAUSTED')) {
                            quotaDetail = `${msg} ${detail}`.trim();
                        }
                        translations[result.targetCode] = { text: '번역 오류', kind: 'manual', stale: false, updatedAt: Date.now() };
                        continue;
                    }
                    translations[result.targetCode] = { text: result.translated, kind: 'manual', stale: false, updatedAt: Date.now() };
                }
                // #63: a target the user manually selected on this row always
                // wins over the async default; otherwise the opposite-of-source
                // default applies (preferred target first, then the first
                // selected non-source target, deterministically).
                const activeTarget =
                    (item.activeTarget && (effectiveTargets.includes(item.activeTarget) || translations[item.activeTarget]?.text)
                        ? item.activeTarget
                        : pickInitialActiveTarget(sourceLang.code, effectiveTargets, preferredActiveTarget))
                    || '';
                return {
                    ...item,
                    translations,
                    sourceLanguage: sourceLang.code,
                    activeTarget,
                    translated: (activeTarget && translations[activeTarget]?.text) || item.translated,
                    isTranslating: false,
                    translationKind: 'manual',
                    translationStale: false,
                };
            }));

            if (quotaDetail && onQuotaExhausted) {
                onQuotaExhausted(quotaDetail);
            }
            if (isAutoPlay) {
                const primary = results.find(result => result && !result.error);
                if (primary?.translated) {
                    playTTS(primary.translated, id);
                }
            }
        } finally {
            pendingIdsRef.current.delete(id);
        }
    };

    /**
     * #62 answer assist: one bounded call per finalized interviewer utterance.
     *
     * The result is bound to the utterance id through a per-id run counter, so
     * a slow response can never overwrite a newer answer on the same row, and
     * a response for a deleted row is dropped with the setHistory map.
     */
    const answerRunRef = useRef<Map<string, number>>(new Map());

    const generateInterviewAnswer = useCallback(async (
        text: string,
        id: string,
        recentUtterances: readonly string[],
        sourceLanguage: string
    ) => {
        const request = buildAnswerRequest(text, recentUtterances, sourceLanguage);
        if (!request.text) return;

        const run = (answerRunRef.current.get(id) || 0) + 1;
        answerRunRef.current.set(id, run);
        const isCurrentRun = () => answerRunRef.current.get(id) === run;

        setHistory(prev => prev.map(item => item.id === id ? { ...item, answerStatus: 'loading' } : item));

        try {
            const data = await postApi<{ shouldAnswer?: boolean; answer?: string; language?: string }>(
                'interview-answer',
                request
            );
            if (!isCurrentRun()) return;
            const suggestedAnswer = typeof data?.answer === 'string' ? data.answer.trim() : '';
            const shouldAnswer = data?.shouldAnswer === true && suggestedAnswer.length > 0;
            setHistory(prev => prev.map(item => item.id === id ? {
                ...item,
                answerStatus: shouldAnswer ? 'ready' : 'none',
                suggestedAnswer: shouldAnswer ? suggestedAnswer : '',
                answerLanguage: typeof data?.language === 'string' && data.language.trim()
                    ? data.language.trim()
                    : request.language,
            } : item));
        } catch (error) {
            console.error('Interview answer assist failed:', error);
            if (!isCurrentRun()) return;
            setHistory(prev => prev.map(item => item.id === id ? { ...item, answerStatus: 'error' } : item));
        }
    }, [postApi, setHistory]);

    return {
        postApi,
        translateText,
        translateToTargets,
        generateInterviewAnswer
    };
}
