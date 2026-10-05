import React, { memo, useState } from 'react';
import Visualizer from './Visualizer';
import { MicIcon, CopyIcon } from './Icons';
import { ConversationItem, TranslationMap, ConnectionStatus } from '../types';

interface ConversationListProps {
    analyser: any;
    isMicOn: boolean;
    history: ConversationItem[];
    currentTurnText: string;
    currentTurnTranslation?: string;
    interviewMode?: boolean;
    isOutputOnly: boolean;
    historyRef: React.RefObject<HTMLDivElement>;
    t: TranslationMap;
    status: ConnectionStatus;
    errorMessage: string;
    connectToGemini: () => void;
    toggleMic: () => void;
    editingItemId: string | null;
    editingField: 'original' | 'translated' | 'both';
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
    startEditing: (item: ConversationItem, field?: 'original' | 'translated' | 'both') => void;
    uiLangCode: string;
    onRetranslate?: (item: ConversationItem) => void;
    onSubmitText?: (text: string) => void;
    onSelectTranslationTarget?: (itemId: string, target: string) => void;
}

const ConversationList: React.FC<ConversationListProps> = ({
    analyser,
    isMicOn,
    history,
    currentTurnText,
    currentTurnTranslation = '',
    interviewMode = false,
    isOutputOnly,
    historyRef,
    t,
    status,
    errorMessage,
    connectToGemini,
    toggleMic,
    editingItemId,
    editingField,
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
    onRetranslate,
    onSubmitText,
    onSelectTranslationTarget,
}) => {
    const [interviewDraft, setInterviewDraft] = useState('');

    const submitInterviewDraft = () => {
        if (!onSubmitText || !interviewDraft.trim()) return;
        onSubmitText(interviewDraft);
        setInterviewDraft('');
    };

    return (
        <div className="flex-1 overflow-hidden relative bg-slate-50 flex flex-col">
            {/* Visualizer Background: 마이크 켜졌을 때만 표시 */}
            {analyser && isMicOn && (
                <div className="absolute top-0 left-0 right-0 h-32 opacity-30 pointer-events-none z-0">
                    <Visualizer analyser={analyser} isActive={isMicOn} color="#6366f1" />
                </div>
            )}

            {/* Scrollable Content */}
            <div
                ref={historyRef}
                className="flex-1 overflow-y-auto p-4 pb-40 md:pb-24 z-10 relative scroll-smooth"
            >
                {history.length === 0 && !currentTurnText && !currentTurnTranslation && (
                    <div className="h-full flex flex-col items-center justify-start text-gray-400 text-center px-4 opacity-70 overflow-y-auto py-0">
                        {!interviewMode && (
                        <div className="mt-32 mb-3 flex flex-col items-center gap-1.5" title={t.statusStandby}>
                            <span className="bg-indigo-600 text-white px-4 py-1.5 rounded-full text-[11px] font-black shadow-lg animate-bounce duration-1000">
                                {interviewMode
                                    ? ((isMicOn || status === ConnectionStatus.CONNECTED)
                                        ? (uiLangCode === 'ko' ? '인터뷰 · 듣는 중' : 'Interview · Listening')
                                        : (uiLangCode === 'ko' ? '인터뷰 모드 · 자동 언어 감지' : 'Interview mode · Auto language'))
                                    : ((isMicOn || status === ConnectionStatus.CONNECTED)
                                        ? (uiLangCode === 'ko' ? '듣고 있습니다...' : 'Listening...')
                                        : t.statusStandby)}
                            </span>
                            <button
                                onClick={toggleMic}
                                className={`w-18 h-18 md:w-20 md:h-20 rounded-full flex items-center justify-center shadow-2xl border-[6px] border-white transition-all transform hover:scale-110 active:scale-90 cursor-pointer ${status === ConnectionStatus.CONNECTED
                                    ? 'bg-gradient-to-br from-red-500 to-rose-600 text-white shadow-red-200'
                                    : 'bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-indigo-200'}`}
                                title={status === ConnectionStatus.CONNECTED ? (uiLangCode === 'ko' ? '마이크 끄기' : 'Turn off mic') : (uiLangCode === 'ko' ? '마이크 켜기' : 'Turn on mic')}
                            >
                                <div className="scale-125">
                                    <MicIcon />
                                </div>
                            </button>
                        </div>

                        )}

                        {!(isMicOn || status === ConnectionStatus.CONNECTED) ? (
                            interviewMode ? (
                                <>
                                    <div
                                        data-testid="interview-empty-visual"
                                        aria-hidden="true"
                                        className="pointer-events-none select-none mt-10 md:mt-14 mb-5 flex flex-col items-center"
                                    >
                                        <div className="relative flex items-center gap-5 md:gap-7 rounded-[28px] border border-indigo-100 bg-gradient-to-br from-indigo-50 via-white to-violet-50 px-7 py-5 shadow-sm">
                                            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-indigo-500 shadow-sm ring-1 ring-indigo-100">
                                                <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.8">
                                                    <circle cx="12" cy="8" r="3.2" />
                                                    <path d="M5.5 19c.8-4 3-6 6.5-6s5.7 2 6.5 6" strokeLinecap="round" />
                                                </svg>
                                            </div>
                                            <div className="flex items-end gap-1 text-indigo-500">
                                                {[10, 18, 28, 20, 34, 24, 14].map((height, index) => (
                                                    <span
                                                        key={index}
                                                        className="w-1.5 rounded-full bg-current opacity-80"
                                                        style={{ height }}
                                                    />
                                                ))}
                                            </div>
                                            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-violet-500 shadow-sm ring-1 ring-violet-100">
                                                <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.8">
                                                    <circle cx="12" cy="8" r="3.2" />
                                                    <path d="M5.5 19c.8-4 3-6 6.5-6s5.7 2 6.5 6" strokeLinecap="round" />
                                                </svg>
                                            </div>
                                        </div>
                                        <p className="mt-3 text-xs font-bold tracking-wide text-indigo-600">
                                            {uiLangCode === 'ko' ? '면접자와 지원자의 말을 실시간으로 통역합니다' : 'Live interpretation between interviewer and candidate'}
                                        </p>
                                    </div>
                                    <div className="w-full max-w-xl text-left space-y-2 text-[12px] text-gray-500 bg-white/90 border border-indigo-100 rounded-2xl p-4 shadow-sm">
                                        <div className="font-bold text-indigo-700 text-sm">
                                            {uiLangCode === 'ko' ? '인터뷰 모드' : 'Interview mode'}
                                        </div>
                                        <ul className="list-disc list-inside space-y-1 leading-snug">
                                            <li>{uiLangCode === 'ko' ? '입력 언어는 자동 감지합니다.' : 'Input language is detected automatically.'}</li>
                                            <li>{uiLangCode === 'ko' ? '한국어와 영어가 섞여도 원문 자막은 그대로 표시합니다.' : 'Mixed Korean and English remain visible in the source transcript.'}</li>
                                            <li>{uiLangCode === 'ko' ? '말하는 동안 실시간 자막과 번역을 나란히 표시합니다.' : 'Live transcript and translation appear side-by-side while you speak.'}</li>
                                            <li>{uiLangCode === 'ko' ? '발화가 끝나면 실시간 번역을 그대로 보존하고, 필요할 때만 다시 번역합니다.' : 'When an utterance ends, the live translation is preserved and retranslation runs only on request.'}</li>
                                        </ul>
                                    </div>
                                </>
                            ) : (
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
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
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
                            )
                        ) : (
                            <div className={`${interviewMode ? 'mt-16 md:mt-20' : 'mt-8'} animate-pulse flex flex-col items-center`}>
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
                        const isEditingOriginal = isEditing && editingField === 'original';
                        const isEditingTranslated = isEditing && editingField === 'translated';
                        const translationTargets = Object.keys(item.translations || {});

                        if (interviewMode && !isOutputOnly) {
                            const sourceEditLabel = item.sourceKind === 'voice'
                                ? (uiLangCode === 'ko' ? '전사 수정' : 'Edit transcript')
                                : (uiLangCode === 'ko' ? '원문 수정' : 'Edit source');
                            const translationEditLabel = uiLangCode === 'ko' ? '번역 수정' : 'Edit translation';
                            const cancelLabel = uiLangCode === 'ko' ? '취소' : 'Cancel';
                            const saveLabel = uiLangCode === 'ko' ? '저장' : 'Save';

                            return (
                                <div key={item.id} className="grid grid-cols-2 gap-4 items-stretch">
                                    <div className="relative bg-white border border-gray-200 p-4 rounded-xl shadow-sm text-gray-800 leading-relaxed text-sm md:text-base min-w-0">
                                        {isEditingOriginal ? (
                                            <div className="flex h-full flex-col gap-3">
                                                <label className="text-[11px] font-black text-indigo-600 tracking-wide">{sourceEditLabel}</label>
                                                <textarea
                                                    autoFocus
                                                    value={editOriginalText}
                                                    onChange={(event) => setEditOriginalText(event.target.value)}
                                                    className="min-h-[140px] w-full flex-1 resize-y rounded-lg border border-indigo-200 bg-white p-3 text-sm leading-relaxed text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                                    aria-label={sourceEditLabel}
                                                />
                                                <div className="flex justify-end gap-2">
                                                    <button type="button" onClick={() => setEditingItemId(null)} className="rounded-full bg-gray-100 px-4 py-2 text-xs font-bold text-gray-600 hover:bg-gray-200">{cancelLabel}</button>
                                                    <button type="button" onClick={() => handleSaveEdit(item.id)} className="rounded-full bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-700">{saveLabel}</button>
                                                </div>
                                            </div>
                                        ) : (
                                            <>
                                                <div className="pr-9 whitespace-pre-wrap">{item.original}</div>
                                                {!item.isTranslating && (
                                                    <button
                                                        type="button"
                                                        onClick={(event) => { event.stopPropagation(); startEditing(item, 'original'); }}
                                                        className="absolute right-2 top-2 rounded-lg border border-gray-200 bg-white/90 p-1.5 text-gray-500 shadow-sm transition hover:border-indigo-600 hover:bg-indigo-600 hover:text-white"
                                                        title={sourceEditLabel}
                                                        aria-label={sourceEditLabel}
                                                    >
                                                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                                    </button>
                                                )}
                                            </>
                                        )}
                                    </div>

                                    <div className={`relative min-w-0 rounded-xl border p-4 text-sm transition-all md:text-base ${item.isTranslating ? 'border-gray-100 bg-gray-50' : 'border-indigo-100 bg-indigo-50/50 shadow-sm'}`}>
                                        {item.isTranslating ? (
                                            <div className="flex h-6 items-center gap-1">
                                                <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
                                                <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 delay-75" />
                                                <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 delay-150" />
                                            </div>
                                        ) : isEditingTranslated ? (
                                            <div className="flex h-full flex-col gap-3">
                                                <label className="text-[11px] font-black text-indigo-600 tracking-wide">{translationEditLabel}</label>
                                                <textarea
                                                    autoFocus
                                                    value={editTranslatedText}
                                                    onChange={(event) => setEditTranslatedText(event.target.value)}
                                                    className="min-h-[140px] w-full flex-1 resize-y rounded-lg border border-indigo-200 bg-white p-3 text-sm font-medium leading-relaxed text-indigo-950 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                                    aria-label={translationEditLabel}
                                                />
                                                <div className="flex justify-end gap-2">
                                                    <button type="button" onClick={() => setEditingItemId(null)} className="rounded-full bg-gray-100 px-4 py-2 text-xs font-bold text-gray-600 hover:bg-gray-200">{cancelLabel}</button>
                                                    <button type="button" onClick={() => handleSaveEdit(item.id)} className="rounded-full bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-700">{saveLabel}</button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="flex h-full flex-col gap-3 pt-11 sm:pt-0 sm:pr-28">
                                                {translationTargets.length > 1 && (
                                                    <div className="flex flex-wrap items-center gap-1.5">
                                                        {translationTargets.map((target) => (
                                                            <button
                                                                key={target}
                                                                type="button"
                                                                onClick={(event) => {
                                                                    event.stopPropagation();
                                                                    onSelectTranslationTarget?.(item.id, target);
                                                                }}
                                                                aria-pressed={item.activeTarget === target}
                                                                title={uiLangCode === 'ko' ? '번역 언어 전환' : 'Switch translation language'}
                                                                className={`rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide transition-all ${item.activeTarget === target
                                                                    ? 'border-indigo-600 bg-indigo-600 text-white shadow-sm'
                                                                    : 'border-indigo-200 bg-white text-indigo-600 hover:bg-indigo-50'}`}
                                                            >
                                                                {target}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                                {item.translationStale && (
                                                    <span className="w-fit rounded-full bg-amber-100 px-2 py-1 text-[10px] font-bold text-amber-700">
                                                        {uiLangCode === 'ko' ? '원문이 수정됨 · 다시 번역 권장' : 'Source edited · retranslation recommended'}
                                                    </span>
                                                )}
                                                <span className="block whitespace-pre-wrap text-sm font-medium leading-relaxed text-indigo-900 md:text-base">
                                                    {item.translated || (uiLangCode === 'ko' ? '번역 없음' : 'No translation yet')}
                                                </span>
                                                <div
                                                    className="absolute right-2 top-2 z-10 flex items-center gap-1"
                                                    data-testid="translation-row-actions"
                                                >
                                                    <button
                                                        type="button"
                                                        onClick={(event) => { event.stopPropagation(); startEditing(item, 'translated'); }}
                                                        className="flex h-10 w-10 items-center justify-center rounded-lg border border-gray-200 bg-white/95 text-gray-500 shadow-sm transition hover:border-indigo-600 hover:bg-indigo-600 hover:text-white active:scale-95 sm:h-9 sm:w-9"
                                                        title={translationEditLabel}
                                                        aria-label={translationEditLabel}
                                                    >
                                                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                                    </button>
                                                    {item.translated && (
                                                        <button
                                                            type="button"
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                if (item.ttsStatus === 'playing') stopTTS();
                                                                else playTTS(item.translated, item.id);
                                                            }}
                                                            className="flex h-10 w-10 items-center justify-center rounded-lg border border-indigo-100 bg-white/95 text-indigo-600 shadow-sm transition hover:bg-indigo-50 active:scale-95 sm:h-9 sm:w-9"
                                                            title={item.ttsStatus === 'playing'
                                                                ? (uiLangCode === 'ko' ? '정지' : 'Stop')
                                                                : (uiLangCode === 'ko' ? '재생' : 'Play')}
                                                            aria-label={item.ttsStatus === 'playing'
                                                                ? (uiLangCode === 'ko' ? '정지' : 'Stop')
                                                                : (uiLangCode === 'ko' ? '재생' : 'Play')}
                                                        >
                                                            {item.ttsStatus === 'loading' ? (
                                                                <span className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-300 border-t-indigo-600" aria-hidden="true" />
                                                            ) : item.ttsStatus === 'playing' ? (
                                                                <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12v12H6z" /></svg>
                                                            ) : item.ttsStatus === 'error' ? (
                                                                <svg className="h-4 w-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                                            ) : (
                                                                <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
                                                            )}
                                                        </button>
                                                    )}
                                                    {onRetranslate && (
                                                        <button
                                                            type="button"
                                                            onClick={(event) => { event.stopPropagation(); onRetranslate(item); }}
                                                            className="flex h-10 w-10 items-center justify-center rounded-lg border border-indigo-200 bg-white/95 text-indigo-700 shadow-sm transition hover:bg-indigo-50 active:scale-95 sm:h-9 sm:w-9"
                                                            title={uiLangCode === 'ko' ? '다시 번역' : 'Retranslate'}
                                                            aria-label={uiLangCode === 'ko' ? '다시 번역' : 'Retranslate'}
                                                        >
                                                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v6h6M20 20v-6h-6M5.5 15a7 7 0 0011.8 2.6L20 14M4 10l2.7-3.6A7 7 0 0118.5 9" />
                                                            </svg>
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        }

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
                                        {/* Always visible 3-dot menu for mobile + hover buttons for desktop */}
                                        {!item.isTranslating && (
                                            <div className="absolute top-2 right-2 z-20 flex items-center gap-1">
                                                {/* 3-dot menu button (always visible) */}
                                                <div className="relative">
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            startEditing(item);
                                                        }}
                                                        className="p-1.5 bg-white/80 backdrop-blur-sm border border-gray-200 rounded-lg shadow-sm text-gray-500 hover:bg-indigo-600 hover:text-white hover:border-indigo-600 transition-all active:scale-95 md:opacity-0 md:group-hover:opacity-100"
                                                        title={uiLangCode === 'ko' ? '수정' : 'Edit'}
                                                    >
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                                        </svg>
                                                    </button>
                                                </div>

                                                {/* Desktop-only hover buttons */}
                                                <div className="hidden md:flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
                                                            copyToClipboard(`${item.original}\n${item.translated}`);
                                                        }}
                                                        className="p-1.5 bg-white border border-gray-100 rounded-lg shadow-sm hover:bg-indigo-600 hover:text-white transition-all text-gray-400"
                                                        title={uiLangCode === 'ko' ? '복사' : 'Copy'}
                                                    >
                                                        <CopyIcon />
                                                    </button>
                                                </div>
                                            </div>
                                        )}


                                        <div className={interviewMode && !isOutputOnly ? 'grid grid-cols-2 gap-4 items-stretch' : ''}>
                                        {!isOutputOnly && (
                                            <div className="bg-white border border-gray-200 p-4 rounded-xl shadow-sm text-gray-800 leading-relaxed text-sm md:text-base">
                                                {item.original}
                                            </div>
                                        )}

                                        <div
                                            className={`${!isOutputOnly && !interviewMode ? 'mt-2' : ''} p-4 rounded-xl border transition-all text-sm md:text-base relative ${item.isTranslating
                                                ? 'bg-gray-50 border-gray-100'
                                                : 'bg-indigo-50/50 border-indigo-100 shadow-sm'
                                                }`}
                                        >
                                            {item.isTranslating ? (
                                                <div className="flex gap-1 h-6 items-center">
                                                    <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"></div>
                                                    <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-75"></div>
                                                    <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-150"></div>
                                                </div>
                                            ) : (
                                                <div className="flex flex-col gap-3">
                                                    {item.translationStale && (
                                                        <span className="w-fit rounded-full bg-amber-100 px-2 py-1 text-[10px] font-bold text-amber-700">
                                                            {uiLangCode === 'ko' ? '원문이 수정됨 · 다시 번역 권장' : 'Source edited · retranslation recommended'}
                                                        </span>
                                                    )}
                                                    <span className="text-indigo-900 font-medium leading-relaxed text-sm md:text-base block">
                                                        {item.translated || (interviewMode ? (uiLangCode === 'ko' ? '번역 없음' : 'No translation yet') : '')}
                                                    </span>
                                                    {item.translated && (
                                                        <div className="flex items-center gap-2">
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    if (item.ttsStatus === 'playing') {
                                                                        stopTTS();
                                                                    } else {
                                                                        playTTS(item.translated, item.id);
                                                                    }
                                                                }}
                                                                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-indigo-100 shadow-sm text-indigo-600 hover:bg-indigo-50 active:scale-95 transition text-xs font-bold"
                                                                aria-label={item.ttsStatus === 'playing' ? '정지' : '재생'}
                                                            >
                                                                {item.ttsStatus === 'loading' ? (
                                                                    <div className="w-4 h-4 border-2 border-indigo-300 border-t-indigo-600 rounded-full animate-spin" />
                                                                ) : item.ttsStatus === 'playing' ? (
                                                                    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
                                                                ) : item.ttsStatus === 'error' ? (
                                                                    <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                                                ) : (
                                                                    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                                                                )}
                                                                <span className="hidden sm:inline">{item.ttsStatus === 'playing' ? '정지' : '재생'}</span>
                                                            </button>
                                                        </div>
                                                    )}
                                                    {interviewMode && onRetranslate && (
                                                        <button
                                                            type="button"
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                onRetranslate(item);
                                                            }}
                                                            className="w-fit rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-bold text-indigo-700 hover:bg-indigo-50"
                                                        >
                                                            {uiLangCode === 'ko' ? '다시 번역' : 'Retranslate'}
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        </div>
                                    </>
                                )}
                            </div>
                        );
                    })}

                    {/* Live transcription keeps the original two-column Global Classroom layout. */}
                    {(currentTurnText || currentTurnTranslation) && (
                        isOutputOnly ? (
                            <div className="opacity-80">
                                <div className="border border-indigo-100 bg-indigo-50/60 p-4 rounded-xl text-indigo-900 font-medium">
                                    {currentTurnTranslation || '...'}
                                </div>
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 gap-4 opacity-80">
                                <div className="bg-gray-50 border border-gray-300 border-dashed p-4 rounded-xl text-gray-700 italic animate-pulse">
                                    {currentTurnText || (uiLangCode === 'ko' ? '듣는 중...' : 'Listening...')}
                                </div>
                                <div className="border border-indigo-200 border-dashed bg-indigo-50/60 p-4 rounded-xl text-indigo-900">
                                    {!interviewMode && (
                                        <div className="mb-1 flex items-center justify-between gap-2 text-[9px] font-black uppercase tracking-wide text-indigo-400">
                                            <span>{uiLangCode === 'ko' ? '번역 대기' : 'Translation'}</span>
                                        </div>
                                    )}
                                    <div className={currentTurnTranslation ? 'font-medium' : 'text-gray-300 italic'}>
                                        {currentTurnTranslation || '...'}
                                    </div>
                                </div>
                            </div>
                        )
                    )}
                </div>
                <div className={interviewMode ? "h-48" : "h-40"}></div> {/* Spacer for fixed interview composer + bottom bar */}
            </div>

            {interviewMode && !isOutputOnly && onSubmitText && (
                <div className="fixed bottom-[92px] left-3 right-3 z-40 sm:left-4 sm:right-[calc(50%+8px)]">
                    <div className="flex items-end gap-2 rounded-2xl border border-gray-200 bg-white/95 p-2 shadow-lg backdrop-blur-md focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-100">
                            <textarea
                                value={interviewDraft}
                                onChange={(event) => setInterviewDraft(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                                        event.preventDefault();
                                        submitInterviewDraft();
                                    }
                                }}
                                rows={1}
                                aria-label={uiLangCode === 'ko' ? '인터뷰 텍스트 입력' : 'Interview text input'}
                                placeholder={uiLangCode === 'ko' ? '직접 입력하거나 붙여넣기…' : 'Type or paste here…'}
                                className="max-h-28 min-h-10 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-2 text-sm leading-relaxed text-gray-900 outline-none placeholder:text-gray-400"
                            />
                            <button
                                type="button"
                                onClick={submitInterviewDraft}
                                disabled={!interviewDraft.trim()}
                                className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white shadow-sm transition hover:bg-indigo-700 disabled:bg-gray-300"
                                title={uiLangCode === 'ko' ? '번역하기 (Enter)' : 'Translate (Enter)'}
                                aria-label={uiLangCode === 'ko' ? '입력한 텍스트 번역' : 'Translate typed text'}
                            >
                                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 12h14m-6-6 6 6-6 6" />
                                </svg>
                            </button>
                    </div>
                    <div className="mt-1 pl-2 text-[10px] font-medium text-gray-400">
                        {uiLangCode === 'ko' ? 'Enter 번역 · Shift+Enter 줄바꿈' : 'Enter to translate · Shift+Enter for newline'}
                    </div>
                </div>
            )}
        </div>
    );
};

export default memo(ConversationList);
