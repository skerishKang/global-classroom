import React from 'react';
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
    startEditing: (item: ConversationItem) => void;
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
    startEditing,
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
                    <div className="h-full flex flex-col items-center justify-center text-gray-400 text-center px-6 opacity-60">
                        <MicIcon />
                        <p className="mt-4 whitespace-pre-wrap text-sm">{t.emptyHint}</p>
                        <div className="mt-4 w-full max-w-xl text-left space-y-2 text-[12px] text-gray-500 bg-white/80 border border-gray-200 rounded-2xl p-4 shadow-sm">
                            <div className="font-bold text-gray-700 text-sm">빠른 안내</div>
                            <ul className="list-disc list-inside space-y-1">
                                <li>마이크 버튼을 눌러 실시간 번역을 시작하세요.</li>
                                <li>Google 로그인 시 Drive 백업·Classroom 제출·Docs 저장 기능 사용 가능.</li>
                                <li>칠판 촬영(비전)으로 사진 속 텍스트를 감지해 번역합니다.</li>
                                <li>자동 읽기/자동 스크롤 토글로 듣기/보기 방식을 선택하세요.</li>
                            </ul>
                            <div className="grid grid-cols-2 gap-2 text-[11px]">
                                <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
                                    <div className="font-bold text-gray-700">단축키</div>
                                    <div className="mt-1 text-gray-500">스페이스: 마이크 on/off<br />Enter: 최근 번역 듣기</div>
                                </div>
                                <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
                                    <div className="font-bold text-gray-700">모바일 팁</div>
                                    <div className="mt-1 text-gray-500">하단 고정 버튼으로 한 손 조작, 세로 모드 최적화</div>
                                </div>
                            </div>
                        </div>
                        <button
                            onClick={toggleMic}
                            className="mt-8 px-10 py-4 rounded-full bg-gradient-to-r from-indigo-500 to-indigo-700 text-white text-base font-black shadow-xl hover:shadow-indigo-200 hover:scale-110 hover:-translate-y-1 transition-all active:scale-90 active:translate-y-0 ring-4 ring-indigo-50 animate-bounce"
                        >
                            {status === ConnectionStatus.CONNECTING
                                ? t.connecting
                                : status === ConnectionStatus.ERROR
                                    ? t.retry
                                    : '시작하려면 터치'}
                        </button>
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
                                                    title="위 항목과 병합"
                                                >
                                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
                                                </button>
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleMergeWithBelow(item.id);
                                                    }}
                                                    className="p-1.5 bg-white border border-gray-100 rounded-lg shadow-sm hover:bg-indigo-600 hover:text-white transition-all text-gray-400"
                                                    title="아래 항목과 병합"
                                                >
                                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                                                </button>
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        startEditing(item);
                                                    }}
                                                    className="p-1.5 bg-white border border-gray-100 rounded-lg shadow-sm hover:bg-indigo-600 hover:text-white transition-all text-gray-400"
                                                    title="수정"
                                                >
                                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                                </button>
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        copyToClipboard(`${item.original}\n${item.translated}`);
                                                    }}
                                                    className="p-1.5 bg-white border border-gray-100 rounded-lg shadow-sm hover:bg-indigo-600 hover:text-white transition-all text-gray-400"
                                                    title="복사"
                                                >
                                                    <CopyIcon />
                                                </button>
                                            </div>
                                        )}
                                        <div className="bg-white border border-gray-200 p-4 rounded-xl shadow-sm text-gray-800 leading-relaxed text-sm md:text-base">
                                            {item.original}
                                        </div>

                                        <div
                                            className={`mt-2 p-4 rounded-xl border transition-all text-sm md:text-base ${item.isTranslating
                                                ? 'bg-gray-50 border-gray-100'
                                                : 'bg-indigo-50/50 border-indigo-100 shadow-sm'
                                                } ${!item.isTranslating && item.translated ? 'cursor-pointer hover:bg-indigo-100 active:scale-[0.99]' : ''
                                                }`}
                                            onClick={() => {
                                                if (!item.isTranslating && item.translated) {
                                                    playTTS(item.translated, item.id);
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
                                                <span className="text-indigo-900 font-medium leading-relaxed text-sm md:text-base">{item.translated}</span>
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

                <div className="h-20"></div> {/* Spacer for bottom bar */}
            </div>
        </div>
    );
};

export default ConversationList;
