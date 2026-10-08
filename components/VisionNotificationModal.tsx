import React from 'react';
import { VisionNotification } from '../types';

interface VisionNotificationModalProps {
    notificationId: string | null;
    notifications: VisionNotification[];
    onClose: () => void;
    t: any;
}

const VisionNotificationModal: React.FC<VisionNotificationModalProps> = ({
    notificationId,
    notifications,
    onClose,
    t,
}) => {
    if (!notificationId) return null;

    const n = notifications.find((x) => x.id === notificationId);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
                <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
                    <h2 className="text-lg font-bold text-gray-800">{t.visionTitle}</h2>
                    <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-gray-600 p-1 bg-white rounded-full shadow-sm"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>

                {(() => {
                    if (!n) {
                        return <div className="p-6 text-sm text-gray-500">알림을 찾을 수 없습니다.</div>;
                    }

                    if (n.status === 'processing') {
                        return <div className="p-6 text-sm text-gray-500">{t.visionAnalyzing}</div>;
                    }

                    if (n.status === 'error') {
                        return (
                            <div className="p-6 space-y-2">
                                <div className="text-sm font-bold text-red-600">{t.visionFail}</div>
                                <div className="text-xs text-gray-500 whitespace-pre-wrap break-words">{n.error || t.visionError}</div>
                            </div>
                        );
                    }

                    const originalText = (n.result?.originalText || '').trim();
                    const translatedText = (n.result?.translatedText || '').trim();

                    return (
                        <div className="p-6 space-y-4 overflow-y-auto">
                            <div>
                                <div className="text-xs font-bold text-gray-500 mb-1">{t.visionDetected}</div>
                                <div className="bg-gray-50 border border-gray-200 p-4 rounded-xl text-sm text-gray-800 whitespace-pre-wrap break-words">
                                    {originalText || t.visionNoText}
                                </div>
                            </div>
                            {!n.interviewImported && <div>
                                <div className="text-xs font-bold text-gray-500 mb-1">{t.visionTranslated}</div>
                                <div className="bg-indigo-50 border border-indigo-100 p-4 rounded-xl text-sm text-indigo-900 whitespace-pre-wrap break-words">
                                    {translatedText || t.visionNoText}
                                </div>
                            </div>}
                        </div>
                    );
                })()}
            </div>
        </div>
    );
};

export default VisionNotificationModal;
