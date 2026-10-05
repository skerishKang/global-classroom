import React, { useCallback, useRef } from 'react';
import { Language, ConversationItem, AppSettings, GlossaryEntry, TranslationVariant } from '../types';
import { SUPPORTED_LANGUAGES } from '../constants';
import {
    getTargetsForSource,
    normalizeLanguageCode,
    pickInitialActiveTarget,
    type InterviewLanguagePolicy,
} from '../utils/interviewLanguageRouting';
import {
    buildAnswerRequest,
    planAnswerTranslation,
    resolveAnswerTranslationTarget,
} from '../utils/interviewAnswer';

interface UseTranslationServiceProps {
    settings: AppSettings;
    history: ConversationItem[];
    setHistory: React.Dispatch<React.SetStateAction<ConversationItem[]>>;
    isAutoPlay: boolean;
    playTTS: (text: string, id: string) => void;
    MODEL_TRANSLATE: string;
    onQuotaExhausted?: (detail?: string) => void;
}

export function useTranslationService({
    settings,
    history,
    setHistory,
    isAutoPlay,
    playTTS,
    MODEL_TRANSLATE,
    onQuotaExhausted
}: UseTranslationServiceProps) {
    const pendingIdsRef = useRef<Set<string>>(new Set());

    // Latest conversation state, readable from callbacks that only receive an
    // utterance id (the on-demand answer translation resolves its target
    // language and cached text from the row it was pressed on).
    const historyRef = useRef<ConversationItem[]>(history);
    historyRef.current = history;

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

    /**
     * The one /translate client path (#62). Question translations and the
     * on-demand answer translation go through the same request shaping, so the
     * answer side can never drift onto a different route or model contract.
     */
    const requestTranslation = useCallback(async (
        text: string,
        from: Language,
        to: Language,
        glossary: GlossaryEntry[] = [],
    ): Promise<string> => {
        const data = await postApi<{ translated: string }>('translate', {
            text,
            from: from.name,
            to: to.name,
            model: MODEL_TRANSLATE,
            glossary,
        });
        return data.translated?.trim() || '';
    }, [postApi, MODEL_TRANSLATE]);

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

            const translated = await requestTranslation(text, { ...fromLang, name: actualFrom }, { ...toLang, name: actualTo }, glossary);
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
                    const translated = await requestTranslation(text, sourceLang, targetLang, glossary);
                    return { targetCode, translated, error: null as any };
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
     * `answerLanguage` is the utterance's resolved OUTPUT/translation
     * language, so an English question with Korean output gets a Korean answer.
     * The request is built from the finalized source transcript alone and is
     * fired without waiting for (or depending on) the translation response.
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
        answerLanguage: string,
        options?: { answerLanguageName?: string; sourceLanguage?: string },
    ) => {
        const request = buildAnswerRequest(text, recentUtterances, answerLanguage, options);
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
                // A fresh answer invalidates any cached answer translation:
                // that translation described different text (#62).
                answerLanguage: typeof data?.language === 'string' && data.language.trim()
                    ? data.language.trim()
                    : request.answerLanguage,
                answerTranslationStatus: 'idle',
                answerTranslation: '',
                answerTranslationLanguage: '',
                answerTranslationSource: '',
                answerTranslationVisible: false,
            } : item));
        } catch (error) {
            console.error('Interview answer assist failed:', error);
            if (!isCurrentRun()) return;
            setHistory(prev => prev.map(item => item.id === id ? { ...item, answerStatus: 'error' } : item));
        }
    }, [postApi, setHistory]);

    /**
     * #62 on-demand answer translation: the only place the answer block talks
     * to /translate, and only after the user asks for it.
     *
     * planAnswerTranslation decides between three cheap outcomes and one
     * request: hiding or showing an already cached translation never calls the
     * API, so repeated toggles are free. The request itself is bound to the
     * utterance id by a per-id run counter, and its result is discarded when
     * the answer changed while it was in flight.
     */
    const answerTranslationRunRef = useRef<Map<string, number>>(new Map());

    const languageForCode = useCallback((code: string | undefined): Language => {
        const found = SUPPORTED_LANGUAGES.find((language) => language.code === code);
        return found || { code: code || 'en', name: code || 'en', flag: '' };
    }, []);

    const toggleAnswerTranslation = useCallback(async (id: string) => {
        const item = historyRef.current.find((entry) => entry.id === id);
        if (!item) return;

        const action = planAnswerTranslation(item);
        if (action.kind === 'ignore') return;
        if (action.kind === 'hide' || action.kind === 'show') {
            // Cached already: a pure visibility change, no API call at all.
            setHistory(prev => prev.map(entry => entry.id === id
                ? { ...entry, answerTranslationVisible: action.kind === 'show' }
                : entry
            ));
            return;
        }

        const requestedAnswer = String(item.suggestedAnswer || '').trim();
        const from = languageForCode(item.answerLanguage);
        const to = languageForCode(action.targetLanguage);
        const run = (answerTranslationRunRef.current.get(id) || 0) + 1;
        answerTranslationRunRef.current.set(id, run);
        const isCurrentRun = () => answerTranslationRunRef.current.get(id) === run;

        setHistory(prev => prev.map(entry => entry.id === id
            ? { ...entry, answerTranslationStatus: 'loading', answerTranslationVisible: false }
            : entry
        ));

        try {
            const translated = await requestTranslation(requestedAnswer, from, to);
            if (!isCurrentRun()) return;
            setHistory(prev => prev.map(entry => {
                if (entry.id !== id) return entry;
                if (String(entry.suggestedAnswer || '').trim() !== requestedAnswer) {
                    // The answer was regenerated while this ran: the cached
                    // translation no longer describes what is on screen.
                    return { ...entry, answerTranslationStatus: 'idle' };
                }
                if (!translated) {
                    return { ...entry, answerTranslationStatus: 'error' };
                }
                return {
                    ...entry,
                    answerTranslationStatus: 'ready',
                    answerTranslation: translated,
                    answerTranslationLanguage: action.targetLanguage,
                    answerTranslationSource: requestedAnswer,
                    answerTranslationVisible: true,
                };
            }));
        } catch (error) {
            console.error('Answer translation failed:', error);
            if (!isCurrentRun()) return;
            setHistory(prev => prev.map(entry => entry.id === id
                ? { ...entry, answerTranslationStatus: 'error' }
                : entry
            ));
        }
    }, [requestTranslation, languageForCode, setHistory]);

    return {
        postApi,
        translateText,
        translateToTargets,
        generateInterviewAnswer,
        toggleAnswerTranslation,
        canTranslateAnswer: (item: Pick<ConversationItem, 'answerLanguage' | 'sourceLanguage'>) =>
            resolveAnswerTranslationTarget(item.answerLanguage, item.sourceLanguage) !== '',
    };
}
