import React, { useState } from 'react';
import { AppSettings } from '../types';
import { TRANSLATION_MODELS, DEFAULT_TRANSLATION_MODEL } from '../constants';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    settings: AppSettings;
    setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
    t: any;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, settings, setSettings, t }) => {
    if (!isOpen) return null;

    const currentModel = settings.translationModel || DEFAULT_TRANSLATION_MODEL;
    const [confirmState, setConfirmState] = useState<{
        open: boolean;
        title: string;
        desc?: string;
        onConfirm: () => void;
    }>({ open: false, title: '', desc: '', onConfirm: () => { } });

    const openConfirm = (title: string, desc: string | undefined, onConfirm: () => void) => {
        setConfirmState({ open: true, title, desc, onConfirm });
    };

    const closeConfirm = () => setConfirmState(prev => ({ ...prev, open: false }));

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
                <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
                    <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        설정
                    </h2>

                    <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-indigo-600 p-1 bg-white rounded-full shadow-sm hover:shadow-md transition-all active:scale-95"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>

                <div className="p-6 space-y-6 overflow-y-auto">
                    {/* 번역 모델 선택 */}
                    <div className="space-y-2">
                        <div className="text-sm font-bold text-gray-800 flex items-center gap-2">
                            <svg className="w-4 h-4 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                            </svg>
                            AI 번역 모델
                        </div>
                        <select
                            id="translation-model"
                            name="translationModel"
                            value={currentModel}
                            onChange={(e) => setSettings(prev => ({ ...prev, translationModel: e.target.value }))}
                            className="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm font-medium focus:ring-2 focus:ring-indigo-500 outline-none transition-all bg-white cursor-pointer"
                        >
                            {TRANSLATION_MODELS.map((model) => (
                                <option key={model.id} value={model.id}>
                                    {model.name} {model.recommended ? '⭐' : ''} - {model.desc}
                                </option>
                            ))}
                        </select>
                        <p className="text-[10px] text-gray-400 leading-relaxed">
                            무료 사용량이 많은 모델을 기본값으로 권장합니다. 품질 우선 시 '2.5 Flash'를 선택하세요.
                        </p>
                    </div>

                    {/* Drive 백업 방식 */}
                    <div className="space-y-2">
                        <div className="text-sm font-bold text-gray-800 flex items-center gap-2">
                            <svg className="w-4 h-4 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.5l2.598 4.5H9.402L12 4.5zM4.5 19.5l2.598-4.5h7.804l2.598 4.5H4.5z" />
                            </svg>
                            Google Drive 백업 방식
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={() => setSettings(prev => ({ ...prev, driveBackupMode: 'manual' }))}
                                className={`flex-1 px-3 py-2 rounded-xl text-sm font-bold border transition-all active:scale-95 shadow-sm ${settings.driveBackupMode === 'manual'
                                    ? 'bg-indigo-600 border-indigo-700 text-white shadow-indigo-100'
                                    : 'bg-white border-gray-200 text-gray-500 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-600'
                                    }`}
                            >
                                수동
                            </button>
                            <button
                                onClick={() => setSettings(prev => ({ ...prev, driveBackupMode: 'auto' }))}
                                className={`flex-1 px-3 py-2 rounded-xl text-sm font-bold border transition-all active:scale-95 shadow-sm ${settings.driveBackupMode === 'auto'
                                    ? 'bg-indigo-600 border-indigo-700 text-white shadow-indigo-100'
                                    : 'bg-white border-gray-200 text-gray-500 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-600'
                                    }`}
                            >
                                자동
                            </button>
                        </div>
                        <p className="text-[10px] text-gray-400 leading-relaxed">
                            수동: 필요할 때만 Google Drive로 백업합니다. 자동: 배포 코드에 있는 백업 로직이 주기적으로 Drive에 저장합니다.
                        </p>
                    </div>

                    {/* 음성 캐시 */}
                    <div className="space-y-2">
                        <div className="text-sm font-bold text-gray-800 flex items-center justify-between">
                            <span>음성 캐시(IndexedDB)</span>
                        </div>
                        <button
                            onClick={() => setSettings(prev => ({ ...prev, audioCacheEnabled: !prev.audioCacheEnabled }))}
                            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all active:scale-[0.98] shadow-sm ${settings.audioCacheEnabled
                                ? 'bg-indigo-600 border-indigo-700 text-white shadow-indigo-100'
                                : 'bg-white border-gray-200 text-gray-500 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-600'
                                }`}
                        >
                            <span className="text-sm font-bold">사용</span>
                            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${settings.audioCacheEnabled ? 'bg-white/20' : 'bg-gray-100 text-gray-400'}`}>{settings.audioCacheEnabled ? 'ON' : 'OFF'}</span>
                        </button>
                        <p className="text-[10px] text-gray-400 leading-relaxed">
                            음성 캐시를 켜면 생성된 음성/PCM 데이터를 브라우저 IndexedDB에 임시 저장해 재생을 빠르게 합니다. 저장 공간이 늘면 끄고 캐시를 비워주세요.
                        </p>
                    </div>

                    {/* 개인 API 키 */}
                    <div className="space-y-3 pt-4 border-t border-gray-100">
                        <div className="flex items-center justify-between">
                            <div className="text-sm font-bold text-gray-800 flex items-center gap-2">
                                <svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                                </svg>
                                개인 Gemini API Key
                            </div>
                            <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-[10px] text-indigo-600 font-bold hover:underline">키 발급받기</a>
                        </div>
                        <div className="space-y-2">
                            <div className="flex gap-2">
                                <input
                                    id="user-api-key"
                                    name="userApiKey"
                                    type="password"
                                    placeholder="AI Studio에서 발급받은 키 입력"
                                    value={settings.userApiKey || ''}
                                    onChange={(e) => setSettings(prev => ({ ...prev, userApiKey: e.target.value }))}
                                    className="flex-1 px-4 py-3 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                                />
                                <button
                                    onClick={() => {
                                        const newKey = (settings.userApiKey || '').trim();
                                        if (!newKey) return;
                                        setSettings(prev => {
                                            const next = prev.savedApiKeys || [];
                                            if (next.includes(newKey)) return prev;
                                            return { ...prev, savedApiKeys: [...next, newKey] };
                                        });
                                    }}
                                    className="px-3 py-3 rounded-xl text-xs font-bold border border-indigo-200 text-indigo-600 hover:bg-indigo-50 active:scale-95 transition"
                                >
                                    현재 키 추가
                                </button>
                            </div>
                            <p className="text-[10px] text-gray-400 leading-relaxed">
                                준비된 무료 할당량이 소진될 경우, 본인의 API 키를 입력하여 계속 사용할 수 있습니다. 입력된 키는 본인의 브라우저에만 저장됩니다.
                            </p>
                        </div>
                        <div className="space-y-2">
                            <div className="flex items-center justify-between text-sm font-bold text-gray-800">
                                <span>저장된 키 슬롯 (로컬)</span>
                            </div>
                            <div className="space-y-2">
                                {(settings.savedApiKeys || []).length === 0 && (
                                    <div className="text-xs text-gray-400 border border-dashed border-gray-200 rounded-lg px-3 py-2">
                                        추가 버튼을 눌러 슬롯을 만들면 여기에 목록이 표시됩니다.
                                    </div>
                                )}
                                <div className="space-y-2">
                                    {(settings.savedApiKeys || []).map((k, idx) => {
                                        const label = `슬롯 ${idx + 1}`;
                                        const masked = `${k.slice(0, 4)}••••`;
                                        return (
                                            <div key={`${k}-${idx}`} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2">
                                                <div className="flex-1">
                                                    <div className="text-xs font-bold text-gray-700">{label}</div>
                                                    <div className="text-[11px] text-gray-400">{masked}</div>
                                                </div>
                                                <button
                                                    onClick={() => {
                                                        openConfirm(`${label} 키 적용`, '선택한 키를 입력란에 적용합니다.', () => {
                                                            setSettings(prev => ({ ...prev, userApiKey: k }));
                                                        });
                                                    }}
                                                    className="px-3 py-1 rounded-lg text-xs font-bold border border-indigo-200 text-indigo-600 hover:bg-indigo-50 active:scale-95 transition"
                                                >
                                                    사용
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        openConfirm(`${label} 삭제`, '이 슬롯에서 키를 삭제합니다.', () => {
                                                            setSettings(prev => ({
                                                                ...prev,
                                                                savedApiKeys: (prev.savedApiKeys || []).filter((_, i) => i !== idx)
                                                            }));
                                                        });
                                                    }}
                                                    className="px-2 py-1 rounded-lg text-[11px] font-bold border border-red-200 text-red-500 hover:bg-red-50 active:scale-95 transition"
                                                >
                                                    삭제
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>
                                {(settings.savedApiKeys || []).length > 0 && (
                                    <button
                                        onClick={() => {
                                            openConfirm('모든 슬롯 삭제', '저장된 모든 키를 삭제합니다.', () => {
                                                setSettings(prev => ({ ...prev, savedApiKeys: [] }));
                                            });
                                        }}
                                        className="w-full px-3 py-2 rounded-xl text-xs font-bold border border-gray-200 text-gray-500 hover:bg-gray-50 active:scale-95 transition"
                                    >
                                        전체 비우기
                                    </button>
                                )}
                            </div>
                            <p className="text-[10px] text-gray-400 leading-relaxed">
                                키는 로컬에만 저장됩니다. 슬롯에서 “사용”을 누르면 즉시 적용됩니다.
                            </p>
                        </div>
                    </div>
                </div>
                {confirmState.open && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
                        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
                            <div className="text-base font-bold text-gray-900">{confirmState.title}</div>
                            {confirmState.desc && <div className="text-sm text-gray-600">{confirmState.desc}</div>}
                            <div className="flex gap-2 justify-end">
                                <button
                                    onClick={closeConfirm}
                                    className="px-4 py-2 rounded-xl text-sm font-bold border border-gray-200 text-gray-600 hover:bg-gray-50 active:scale-95 transition"
                                >
                                    취소
                                </button>
                                <button
                                    onClick={() => {
                                        confirmState.onConfirm();
                                        closeConfirm();
                                    }}
                                    className="px-4 py-2 rounded-xl text-sm font-bold bg-indigo-600 text-white hover:bg-indigo-700 active:scale-95 transition"
                                >
                                    확인
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default SettingsModal;
