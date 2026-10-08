import React from 'react';
import { VisionNotification } from '../types';

interface VisionToastSystemProps {
    toastIds: string[];
    notifications: VisionNotification[];
    onOpen: (id: string) => void;
    onDismiss: (id: string) => void;
    t: any;
}

export default function VisionToastSystem({
    toastIds,
    notifications,
    onOpen,
    onDismiss,
    t
}: VisionToastSystemProps) {
    if (toastIds.length === 0) return null;

    return (
        <div className="fixed top-20 right-4 z-[60] flex flex-col gap-2 w-[320px] max-w-[calc(100vw-2rem)]">
            {toastIds.map((id) => {
                const n = notifications.find((x) => x.id === id);
                if (!n) return null;
                const title = t.visionTitle;
                const originalText = (n.result?.originalText || '').trim();
                const translatedText = (n.result?.translatedText || '').trim();
                const message =
                    n.status === 'done'
                        ? (n.interviewImported ? '이미지 내용을 Interview에 추가했습니다.' : (translatedText || originalText || t.visionNoText))
                        : n.status === 'capturing'
                            ? '이미지 캡처 중...'
                            : n.status === 'analyzing'
                                ? t.visionAnalyzing || '분석 중...'
                                : n.status === 'translating'
                                    ? '번역 중...'
                                    : n.status === 'error'
                                        ? (n.error || t.visionFail)
                                        : '대기 중...';

                const statusClass =
                    n.status === 'done'
                        ? 'text-emerald-700'
                        : n.status === 'error'
                            ? 'text-red-700'
                            : 'text-indigo-600';

                return (
                    <div key={id} className="bg-white border border-gray-200 shadow-lg rounded-xl p-3">
                        <div className="flex items-start justify-between gap-2">
                            <button onClick={() => onOpen(id)} className="flex-1 text-left">
                                <div className="text-xs font-bold text-gray-800">{title}</div>
                                <div className={`text-[11px] mt-1 whitespace-pre-wrap break-words line-clamp-3 ${statusClass}`}>
                                    {String(message).trim().slice(0, 160)}
                                </div>
                            </button>
                            <button
                                onClick={() => onDismiss(id)}
                                className="text-gray-400 hover:text-gray-600 p-1"
                                aria-label="닫기"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
