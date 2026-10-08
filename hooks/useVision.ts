import { useState, useRef, useCallback } from 'react';
import { VisionNotification, VisionResult, Language } from '../types';

interface UseVisionProps {
    postApi: <T>(endpoint: string, body: any) => Promise<T>;
    langInput: Language;
    langOutput: Language;
    MODEL_VISION: string;
    interviewMode?: boolean;
    sessionId?: string;
    onExtractedText?: (text: string) => void;
}

export function useVision({ postApi, langInput, langOutput, MODEL_VISION, interviewMode = false, sessionId, onExtractedText }: UseVisionProps) {
    const latestSessionRef = useRef(sessionId);
    latestSessionRef.current = sessionId;
    const [visionNotifications, setVisionNotifications] = useState<VisionNotification[]>([]);
    const [activeVisionNotificationId, setActiveVisionNotificationId] = useState<string | null>(null);
    const [visionToastIds, setVisionToastIds] = useState<string[]>([]);
    const toastTimeoutsRef = useRef<Record<string, number>>({});

    const enqueueVisionToast = useCallback((id: string) => {
        setVisionToastIds(prev => [id, ...prev].slice(0, 3));
        if (toastTimeoutsRef.current[id]) window.clearTimeout(toastTimeoutsRef.current[id]);
        toastTimeoutsRef.current[id] = window.setTimeout(() => {
            setVisionToastIds(prev => prev.filter(x => x !== id));
            delete toastTimeoutsRef.current[id];
        }, 7000);
    }, []);

    const dismissVisionToast = useCallback((id: string) => {
        setVisionToastIds(prev => prev.filter(x => x !== id));
        if (toastTimeoutsRef.current[id]) {
            window.clearTimeout(toastTimeoutsRef.current[id]);
            delete toastTimeoutsRef.current[id];
        }
    }, []);

    const openVisionNotification = useCallback((id: string) => {
        setActiveVisionNotificationId(id);
        setVisionNotifications(prev => prev.map(n => n.id === id ? { ...n, isRead: true } : n));
        dismissVisionToast(id);
    }, [dismissVisionToast]);

    const handleVisionCaptured = async (payload: { blob: Blob }) => {
        const sessionAtCapture = latestSessionRef.current;
        const id = `vision_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const langA = langInput.code;
        const langB = langOutput.code;
        const item: VisionNotification = { id, timestamp: Date.now(), status: 'capturing', isRead: false };
        setVisionNotifications(prev => [item, ...prev]);
        const updateStatus = (s: VisionNotification['status']) => {
            setVisionNotifications(prev => prev.map(n => n.id === id ? { ...n, status: s } : n));
        };
        try {
            const base64Image = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve((reader.result as string).split(',')[1] || '');
                reader.onerror = reject;
                reader.readAsDataURL(payload.blob);
            });
            updateStatus('analyzing');
            const result = await postApi<VisionResult>('vision', { base64Image, langA, langB, model: MODEL_VISION, extractOnly: interviewMode });
            if (interviewMode) {
                if (sessionAtCapture !== latestSessionRef.current) throw new Error('대화가 변경되어 이전 이미지 결과를 추가하지 않았습니다.');
                if (!result.originalText?.trim()) throw new Error('이미지에서 읽을 수 있는 질문이나 내용이 없습니다.');
                onExtractedText?.(result.originalText);
            }
            updateStatus('translating');
            // We simulate a short delay for 'translating' if vision API does both, 
            // but usually it's one call. Let's just go to done after success since the API is 'vision' (transcribe + translate)
            setVisionNotifications(prev => prev.map(n => n.id === id ? { ...n, status: 'done', result, interviewImported: interviewMode } : n));
            enqueueVisionToast(id);
        } catch (e) {
            updateStatus('error');
            setVisionNotifications(prev => prev.map(n => n.id === id ? { ...n, error: String(e) } : n));
            enqueueVisionToast(id);
        }
    };

    return {
        visionNotifications,
        setVisionNotifications,
        activeVisionNotificationId,
        setActiveVisionNotificationId,
        visionToastIds,
        handleVisionCaptured,
        openVisionNotification,
        dismissVisionToast
    };
}
