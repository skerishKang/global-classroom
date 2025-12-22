import React, { memo } from 'react';
import Visualizer from './Visualizer';
import { MicIcon, CopyIcon } from './Icons';
import { ConversationItem, TranslationMap, ConnectionStatus } from '../types';

interface ConversationListProps {
    analyser: any;
    isMicOn: boolean;
    history: ConversationItem[];
    currentTurnText: string;
    isOutputOnly: boolean;
    historyRef: React.RefObject<HTMLDivElement>;
    t: TranslationMap;
    status: ConnectionStatus;
    errorMessage: string;
    connectToGemini: () => void;
    toggleMic: () => void;
    editingItemId: string | null;
    setEditingItemId: (v: string | null) => void;
    editOriginalText: string;
    setEditOriginalText: (v: string) => void;
    editTranslatedText: string;
    setEditTranslatedText: (v: string) => void;
    handleSaveEdit: (id: string) => void;
    handleMergeWithAbove: (id: string) => void;
    handleMergeWithBelow: (id: string) => void;
    handleSplitItem: (id: string, index: number) => void;
    copyToClipboard: (text: string) => void;
    playTTS: (text: string, id: string) => void;
    stopTTS: () => void;
    startEditing: (item: ConversationItem) => void;
    uiLangCode: string;
}

const ConversationList: React.FC<ConversationListProps> = ({
    analyser,
    isMicOn,
    history,
    currentTurnText,
    isOutputOnly,
    historyRef,
    t,
    status,
    errorMessage,
    connectToGemini,
    toggleMic,
    editingItemId,
    setEditingItemId,
    editOriginalText,
    setEditOriginalText,
    editTranslatedText,
    setEditTranslatedText,
    handleSaveEdit,
    handleMergeWithAbove,
    handleMergeWithBelow,
    handleSplitItem,
    copyToClipboard,
    playTTS,
    stopTTS,
    startEditing,
    uiLangCode,
}) => {
    return (
        <div className="flex-1 overflow-hidden relative bg-slate-50 flex flex-col">
            {/* Visualizer Background */}
            <div className="absolute top-0 left-0 right-0 h-32 opacity-30 pointer-events-none z-0">
                <Visualizer analyser={analyser} isActive={isMicOn} color="#6366f1" />
            </div>

            {/* Scrollable Content */}
            <div
                ref={historyRef}
                className="flex-1 overflow-y-auto p-4 z-10 relative scroll-smooth"
            >
                {history.length === 0 && !currentTurnText && (
                    <div className="h-full flex flex-col items-center justify-start text-gray-400 text-center px-4 opacity-70 overflow-y-auto py-0">
                        <div className="mt-32 mb-3 flex flex-col items-center gap-1.5" title={t.statusStandby}>
                            <span className="bg-indigo-600 text-white px-4 py-1.5 rounded-full text-[11px] font-black shadow-lg animate-bounce duration-1000">
                                {(isMicOn || status === ConnectionStatus.CONNECTED) ? (uiLangCode === 'ko' ? '듣고 있습니다...' : 'Listening...') : t.statusStandby}
                            </span>
                            <button
                                onClick={toggleMic}
                                className={`w-16 h-16 rounded-full flex items-center justify-center shadow-2xl transition-all transform hover:scale-110 active:scale-95 ring-4 ring-indigo-50/50 ${status === ConnectionStatus.CONNECTED ? 'bg-red-500' : 'bg-gradient-to-br from-indigo-500 to-indigo-700'} text-white`}
                                title={status === ConnectionStatus.CONNECTED ? (uiLangCode === 'ko' ? '마이크 끄기' : 'Turn off mic') : (uiLangCode === 'ko' ? '마이크 켜기' : 'Turn on mic')}
                            >
                                <div className="scale-75">
                                    <MicIcon />
                                </div>
                            </button>
                        </div>

                        {!(isMicOn || status === ConnectionStatus.CONNECTED) ? (
                            <>
                                <p className="mb-2 whitespace-pre-wrap text-[10px] font-semibold leading-relaxed max-w-[280px] text-gray-400">{t.emptyHint}</p>
                                <div className="mt-4 w-full max-w-xl text-left space-y-2 text-[12px] text-gray-500 bg-white/80 border border-gray-200 rounded-2xl p-4 shadow-sm">
                                    <div className="font-bold text-gray-700 text-sm">{t.guideTitle}</div>
                                    <ul className="list-disc list-inside space-y-0.5 mt-1 leading-snug">
                                        <li>{t.guideMic}</li>
                                        <li>{t.guideDrive}</li>
                                        <li>{t.guideVision}</li>
                                        <li>{t.guideAuto}</li>
                                    </ul>
                                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                                        <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2" title={uiLangCode === 'ko' ? '키보드 단축키' : 'Keyboard Shortcuts'}>
                                            <div className="font-bold text-gray-700">{t.shortcutTitle}</div>
                                            <div className="mt-1 text-gray-500">{t.shortcutSpace}<br />Enter: {uiLangCode === 'ko' ? '최근 번역 듣기' : 'Play recent'}</div>
                                        </div>
                                        <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2" title={uiLangCode === 'ko' ? '모바일 사용 팁' : 'Mobile Usage Tips'}>
                                            <div className="font-bold text-gray-700">{t.mobileTipTitle}</div>
                                            <div className="mt-1 text-gray-500">{t.mobileTipDesc}</div>
                                        </div>
                                    </div>
                                </div>
                            </>
                        ) : (
                            <div className="mt-8 animate-pulse flex flex-col items-center">
                                <p className="text-sm font-bold text-indigo-500">{uiLangCode === 'ko' ? '실시간으로 통역을 준비하고 있습니다.' : 'Ready to translate in real-time.'}</p>
                                <p className="text-[11px] text-gray-400 mt-2">{uiLangCode === 'ko' ? '지금 바로 말씀해 주세요!' : 'Please start speaking now!'}</p>
                            </div>
                        )}
                    </div>
                )}

                <div className="flex flex-col gap-4">
                    {(status === ConnectionStatus.CONNECTING || status === ConnectionStatus.ERROR) && (
                        <div
                            className={`px-4 py-3 rounded-xl border shadow-sm flex items-start justify-between gap-3 ${status === ConnectionStatus.ERROR
                                ? 'bg-red-50 border-red-200'
                                : 'bg-indigo-50 border-indigo-100'
                                }`}
                        >
                            <div className="min-w-0 flex-1">
                                <div
                                    className={`text-xs font-bold flex items-center gap-2 ${status === ConnectionStatus.ERROR ? 'text-red-700' : 'text-indigo-700'
                                        }`}
                                >
                                    {status === ConnectionStatus.CONNECTING && (
                                        <div className="w-4 h-4 border-2 border-indigo-300 border-t-indigo-700 rounded-full animate-spin" />
                                    )}
                                    <span>
                                        {status === ConnectionStatus.CONNECTING ? t.connecting : t.connectionError}
                                    </span>
                                </div>
                                {status === ConnectionStatus.ERROR && !!errorMessage && (
                                    <div className="mt-1 text-xs text-red-700/80 break-words">{errorMessage}</div>
                                )}
                            </div>
                            {status === ConnectionStatus.ERROR && (
                                <button
                                    onClick={() => {
                                        connectToGemini();
                                    }}
                                    className="shrink-0 px-3 py-1.5 rounded-full bg-red-600 text-white text-xs font-bold hover:bg-red-700 transition-colors"
                                >
                                    {t.retry || '재시도'}
                                </button>
                            )}
                        </div>
                    )}

                    {history.map((item) => {
                        const isEditing = editingItemId === item.id;
                        return (
                            <div key={item.id} className="group relative">
                                {isEditing ? (
                                    <div className="bg-white border-2 border-indigo-500 p-4 rounded-xl shadow-xl animate-in fade-in zoom-in duration-200 z-30 relative">
                                        <div className="space-y-4">
                                            <div className="space-y-1.5">
                                                <label className="text-[10px] uppercase font-black text-indigo-500 tracking-wider">원본 텍스트</label>
                                                <textarea
                                                    value={editOriginalText}
                                                    onChange={(e) => {
                                                        const val = e.target.value;
                                                        setEditOriginalText(val);
                                                        const words = val.trim().split(/\s+/);
                                                        const splitIdx = Math.floor(words.length / 2);
                                                        // handleSplitItem logic is outside if needed but we show a helper button
                                                    }}
                                                    className="w-full bg-gray-50 border-none rounded-lg p-3 text-sm focus:ring-2 focus:ring-indigo-500 min-h-[80px] resize-none"
                                                />
                                            </div>
                                            <div className="space-y-1.5">
                                                <label className="text-[10px] uppercase font-black text-indigo-500 tracking-wider">번역 결과</label>
                                                <textarea
                                                    value={editTranslatedText}
                                                    onChange={(e) => setEditTranslatedText(e.target.value)}
                                                    className="w-full bg-gray-50 border-none rounded-lg p-3 text-sm focus:ring-2 focus:ring-indigo-500 min-h-[80px] resize-none font-medium text-indigo-900"
                                                />
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-100">
                                            <div className="flex gap-1">
                                                <button
                                                    onClick={() => {
                                                        const words = editOriginalText.trim().split(/\s+/);
                                                        if (words.length > 1) {
                                                            handleSplitItem(item.id, Math.floor(words.length / 2));
                                                        }
                                                    }}
                                                    className="px-3 py-2 rounded-full bg-orange-50 text-orange-600 text-[10px] font-black hover:bg-orange-100 transition-all border border-orange-100"
                                                >
                                                    여기서 나누기
                                                </button>
                                            </div>
                                            <div className="flex gap-2">
                                                <button
                                                    onClick={() => setEditingItemId(null)}
                                                    className="px-4 py-2 rounded-full bg-gray-100 text-gray-600 text-xs font-bold hover:bg-gray-200 transition-all active:scale-95"
                                                >
                                                    취소
                                                </button>
                                                <button
                                                    onClick={() => handleSaveEdit(item.id)}
                                                    className="px-4 py-2 rounded-full bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700 hover:shadow-md transition-all active:scale-95"
                                                >
                                                    저장
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        {!item.isTranslating && (
                                            <div className="absolute top-0 right-0 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleMergeWithAbove(item.id);
                                                    }}
                                                    className="p-1.5 bg-white border border-gray-100 rounded-lg shadow-sm hover:bg-indigo-600 hover:text-white transition-all text-gray-400"
                                                    title={uiLangCode === 'ko' ? '위 항목과 병합' : 'Merge with above'}
                                                >
                                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
                                                </button>
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleMergeWithBelow(item.id);
                                                    }}
                                                    className="p-1.5 bg-white border border-gray-100 rounded-lg shadow-sm hover:bg-indigo-600 hover:text-white transition-all text-gray-400"
                                                    title={uiLangCode === 'ko' ? '아래 항목과 병합' : 'Merge with below'}
                                                >
                                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                                                </button>
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        startEditing(item);
                                                    }}
                                                    className="p-1.5 bg-white border border-gray-100 rounded-lg shadow-sm hover:bg-indigo-600 hover:text-white transition-all text-gray-400"
                                                    title={uiLangCode === 'ko' ? '수정' : 'Edit'}
                                                >
                                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                                </button>
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        copyToClipboard(`${item.original}\n${item.translated}`);
                                                    }}
                                                    className="p-1.5 bg-white border border-gray-100 rounded-lg shadow-sm hover:bg-indigo-600 hover:text-white transition-all text-gray-400"
                                                    title={uiLangCode === 'ko' ? '복사' : 'Copy'}
                                                >
                                                    <CopyIcon />
                                                </button>
                                            </div>
                                        )}
                                        <div className="bg-white border border-gray-200 p-4 rounded-xl shadow-sm text-gray-800 leading-relaxed text-sm md:text-base">
                                            {item.original}
                                        </div>

                                        <div
                                            className={`mt-2 p-4 rounded-xl border transition-all text-sm md:text-base relative ${item.isTranslating
                                                ? 'bg-gray-50 border-gray-100'
                                                : 'bg-indigo-50/50 border-indigo-100 shadow-sm'
                                                } ${!item.isTranslating && item.translated ? 'cursor-pointer hover:bg-indigo-100 active:scale-[0.99]' : ''
                                                }`}
                                            onClick={() => {
                                                if (!item.isTranslating && item.translated) {
                                                    if (item.ttsStatus === 'playing') {
                                                        stopTTS();
                                                    } else {
                                                        playTTS(item.translated, item.id);
                                                    }
                                                }
                                            }}
                                        >
                                            {item.isTranslating ? (
                                                <div className="flex gap-1 h-6 items-center">
                                                    <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"></div>
                                                    <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-75"></div>
                                                    <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-150"></div>
                                                </div>
                                            ) : (
                                                <>
                                                    <span className="text-indigo-900 font-medium leading-relaxed text-sm md:text-base pr-8 block">{item.translated}</span>
                                                    {item.translated && (
                                                        <div className="absolute right-3 bottom-3 flex items-center justify-center">
                                                            {item.ttsStatus === 'loading' ? (
                                                                <div className="w-5 h-5 border-2 border-indigo-300 border-t-indigo-600 rounded-full animate-spin" />
                                                            ) : item.ttsStatus === 'playing' ? (
                                                                <div className="p-1 rounded-full bg-indigo-600 text-white animate-pulse">
                                                                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
                                                                </div>
                                                            ) : item.ttsStatus === 'error' ? (
                                                                <div className="text-red-500">
                                                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                                                </div>
                                                            ) : (
                                                                <div className="p-1 rounded-full bg-indigo-100 text-indigo-600 group-hover:bg-indigo-200 transition-colors">
                                                                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                </>
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>
                        );
                    })}

                    {/* Live Transcription Placeholder (Left Side) */}
                    {currentTurnText && (
                        isOutputOnly ? (
                            <div className="opacity-70">
                                <div className="flex items-center justify-center text-gray-300 text-sm italic border border-gray-200 border-dashed p-4 rounded-xl bg-white">
                                    ...
                                </div>
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 gap-4 opacity-70">
                                <div className="bg-gray-50 border border-gray-300 border-dashed p-4 rounded-xl text-gray-600 italic animate-pulse">
                                    {currentTurnText}
                                </div>
                                <div className="flex items-center justify-center text-gray-300 text-sm italic">
                                    ...
                                </div>
                            </div>
                        )
                    )}
                </div>

                <div className="h-32"></div> {/* Spacer for bottom bar */}
            </div>
        </div>
    );
};

export default memo(ConversationList);
