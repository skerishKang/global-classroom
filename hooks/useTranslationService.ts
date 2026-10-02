import React, { useCallback, useRef } from 'react';
import { Language, ConversationItem, AppSettings } from '../types';
import { SUPPORTED_LANGUAGES } from '../constants';

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

    const translateText = async (text: string, id: string, fromLang: Language, toLang: Language) => {
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
            });
            const translated = data.translated?.trim() || "";
            setHistory(prev => prev.map(item =>
                item.id === id ? { ...item, translated: translated, isTranslating: false } : item
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


    return {
        postApi,
        translateText
    };
}
