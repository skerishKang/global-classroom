import React from 'react';
import { BrandLogo } from './BrandLogo';
import { ExportIcon, SparklesIcon, SpeakerIcon } from './Icons';
import { VoiceOption, TranslationMap } from '../types';
import { VOICE_OPTIONS, SUPPORTED_LANGUAGES } from '../constants';

interface AppHeaderProps {
    user: any;
    accessToken: string | null;
    isAdmin: boolean;
    handleLogout: () => void;
    isProfileMenuOpen: boolean;
    setIsProfileMenuOpen: (v: boolean) => void;
    setIsHistoryModalOpen: (v: boolean) => void;
    setIsSettingsModalOpen: (v: boolean) => void;
    setIsAdminPanelOpen: (v: boolean) => void;
    setIsLoginModalOpen: (v: boolean) => void;
    selectedVoice: VoiceOption;
    setSelectedVoice: (v: VoiceOption) => void;
    isOutputOnly: boolean;
    setIsOutputOnly: (v: boolean) => void;
    uiLangCode: string;
    setUiLangCode: (v: string) => void;
    setIsExportMenuOpen: (v: boolean) => void;
    handleSummarize: () => void;
    setIsLiveModalOpen: (v: boolean) => void;
    roomStatus: 'idle' | 'hosting' | 'joined';
    t: TranslationMap;
    onNewConversation?: () => void;
}

const AppHeader: React.FC<AppHeaderProps> = ({
    user,
    accessToken,
    isAdmin,
    handleLogout,
    isProfileMenuOpen,
    setIsProfileMenuOpen,
    setIsHistoryModalOpen,
    setIsSettingsModalOpen,
    setIsAdminPanelOpen,
    setIsLoginModalOpen,
    selectedVoice,
    setSelectedVoice,
    isOutputOnly,
    setIsOutputOnly,
    uiLangCode,
    setUiLangCode,
    setIsExportMenuOpen,
    handleSummarize,
    setIsLiveModalOpen,
    roomStatus,
    t,
    onNewConversation,
}) => {
    return (
        <header className="bg-white/80 backdrop-blur-md px-3 py-1.5 shadow-sm z-40 border-b border-gray-100 shrink-0">
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                    <BrandLogo />
                    <div className="min-w-0 cursor-pointer group transition-all" title="실시간 AI 통역 서비스">
                        <h1 className="text-xl font-black text-gray-900 tracking-tight leading-none uppercase group-hover:text-indigo-600 transition-colors">{t.appTitle}</h1>
                        <p className="text-[10px] text-gray-400 font-bold tracking-widest mt-1 uppercase group-hover:text-indigo-400 transition-colors">{t.subtitle}</p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <div className="flex items-center px-2 py-1 bg-white/50 rounded-full border border-gray-100 hover:border-indigo-200 transition-all shrink-0 h-9">
                        <select
                            value={uiLangCode}
                            onChange={(e) => setUiLangCode(e.target.value)}
                            className="bg-transparent text-[11px] font-black text-gray-600 outline-none cursor-pointer uppercase"
                            title={uiLangCode === 'ko' ? 'UI 표시 언어 변경' : 'Change UI language'}
                        >
                            {SUPPORTED_LANGUAGES.filter(l => l.code !== 'auto').map(l => (
                                <option key={l.code} value={l.code}>{l.code}</option>
                            ))}
                        </select>
                    </div>

                    {/* New Conversation Button (Top Right) */}
                    <button
                        onClick={onNewConversation}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white rounded-full shadow-md hover:bg-black transition-all active:scale-95 shrink-0 cursor-pointer h-9 ml-1"
                        title={uiLangCode === 'ko' ? '새 대화 시작' : 'New Conversation'}
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                        </svg>
                        <span className="text-[11px] font-black uppercase tracking-tight hidden sm:inline">
                            {uiLangCode === 'ko' ? '새 대화' : 'New'}
                        </span>
                    </button>

                    {user && !user.isAnonymous && user.providerId !== 'anonymous' ? (
                        <div className="relative">
                            <button
                                onClick={() => setIsProfileMenuOpen(!isProfileMenuOpen)}
                                className="w-10 h-10 rounded-full border-2 border-white shadow-md hover:shadow-lg hover:scale-105 transition-all overflow-hidden bg-gray-100"
                            >
                                {user.photoURL ? (
                                    <img src={user.photoURL} alt="Profile" className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full bg-indigo-500 flex items-center justify-center text-white font-bold uppercase">
                                        {(user.displayName || user.email || '?')[0]}
                                    </div>
                                )}
                            </button>

                            {isProfileMenuOpen && (
                                <div className="absolute right-0 mt-2 w-56 bg-white rounded-2xl shadow-2xl border border-gray-100 py-2 overflow-hidden animate-in fade-in zoom-in duration-200 z-[100]">
                                    <div className="px-4 py-3 border-b border-gray-50 mb-1">
                                        <p className="text-xs font-bold text-gray-900 truncate">{user.displayName || 'Guest'}</p>
                                        <p className="text-[10px] text-gray-400 truncate mt-0.5">{user.email}</p>
                                    </div>

                                    {/* New Conversation Button */}
                                    <button
                                        onClick={() => {
                                            setIsProfileMenuOpen(false);
                                            onNewConversation?.();
                                        }}
                                        className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center gap-3 text-sm text-gray-700 font-medium border-b border-gray-50"
                                    >
                                        <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                                        </svg>
                                        {uiLangCode === 'ko' ? '새 대화' : 'New Conversation'}
                                    </button>

                                    <button
                                        onClick={() => {
                                            setIsProfileMenuOpen(false);
                                            setIsHistoryModalOpen(true);
                                        }}
                                        className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center gap-3 text-sm text-gray-700 font-medium border-b border-gray-50"
                                    >
                                        <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                        </svg>
                                        {uiLangCode === 'ko' ? '학습 기록' : 'Learning History'}
                                    </button>

                                    <button
                                        onClick={() => {
                                            setIsProfileMenuOpen(false);
                                            setIsSettingsModalOpen(true);
                                        }}
                                        className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center gap-3 text-sm text-gray-700 font-medium border-b border-gray-50"
                                    >
                                        <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                        </svg>
                                        {uiLangCode === 'ko' ? '설정' : 'Settings'}
                                    </button>

                                    {isAdmin && (
                                        <button
                                            onClick={() => {
                                                setIsProfileMenuOpen(false);
                                                setIsAdminPanelOpen(true);
                                            }}
                                            className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center gap-3 text-sm text-gray-700 font-medium border-b border-gray-50"
                                        >
                                            <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622C17.176 19.29 21 14.59 21 9c0-1.042-.133-2.052-.382-3.016z" />
                                            </svg>
                                            {uiLangCode === 'ko' ? '관리자 모드' : 'Admin Panel'}
                                        </button>
                                    )}

                                    <button
                                        onClick={() => {
                                            setIsProfileMenuOpen(false);
                                            handleLogout();
                                        }}
                                        className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center gap-3 text-sm text-gray-700 font-medium"
                                    >
                                        <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                                        </svg>
                                        {uiLangCode === 'ko' ? '로그아웃' : 'Logout'}
                                    </button>
                                </div>
                            )}
                        </div>
                    ) : (
                        <button
                            onClick={() => setIsLoginModalOpen(true)}
                            className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-800 border border-indigo-700 rounded-full shadow-lg hover:shadow-indigo-200 hover:scale-105 hover:-translate-y-0.5 transition-all active:scale-90 text-xs font-black text-white whitespace-nowrap uppercase tracking-wider cursor-pointer"
                            title="로그인 또는 회원가입"
                        >
                            {uiLangCode === 'ko' ? '로그인' : 'Login'}
                        </button>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                <div
                    className="flex items-center bg-gray-50 rounded-full px-2 py-1 border border-gray-100 hover:border-indigo-200 hover:bg-indigo-50 transition-all group shrink-0 cursor-pointer hover:shadow-sm"
                    title={uiLangCode === 'ko' ? '음성 목소리 선택' : 'Select TTS voice'}
                >
                    <span className="text-[9px] text-gray-400 font-bold mr-1 uppercase tracking-tighter">{uiLangCode === 'ko' ? '목소리' : 'Voice'}</span>
                    <select
                        value={selectedVoice.name}
                        onChange={(e) => {
                            const v = VOICE_OPTIONS.find(v => v.name === e.target.value);
                            if (v) setSelectedVoice(v);
                        }}
                        className="bg-transparent text-[11px] font-black text-indigo-600 outline-none cursor-pointer w-[60px] hover:text-indigo-700"
                    >
                        {VOICE_OPTIONS.map(v => (
                            <option key={v.name} value={v.name}>{v.label}</option>
                        ))}
                    </select>
                </div>

                <div className="flex items-center gap-1.5">
                    <button
                        onClick={handleSummarize}
                        className="p-1.5 bg-indigo-50 rounded-full border border-indigo-100 text-indigo-600 hover:bg-indigo-600 hover:text-white transition-all active:scale-90 shrink-0 shadow-sm cursor-pointer hover:shadow-md"
                        title={uiLangCode === 'ko' ? 'AI 요약 및 키워드 추출' : 'AI Summary & Keywords'}
                    >
                        <SparklesIcon />
                    </button>

                    <button
                        onClick={() => setIsExportMenuOpen(true)}
                        className="p-1.5 bg-gray-50 rounded-full border border-gray-100 text-gray-400 hover:bg-indigo-600 hover:text-white transition-all active:scale-90 shrink-0 cursor-pointer hover:shadow-md"
                        title={uiLangCode === 'ko' ? '내보내기 (Docs, Drive, Classroom)' : 'Export Options'}
                    >
                        <ExportIcon />
                    </button>
                    <button
                        onClick={() => setIsOutputOnly(!isOutputOnly)}
                        className={`p-1.5 rounded-full border transition-all active:scale-90 shadow-sm shrink-0 flex items-center justify-center cursor-pointer hover:shadow-md ${isOutputOnly
                            ? 'bg-indigo-600 border-indigo-700 text-white hover:bg-indigo-700'
                            : 'bg-white border-gray-100 text-gray-400 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-100'
                            }`}
                        title={uiLangCode === 'ko' ? '출력 모드 (번역만 듣기)' : 'Output Only Mode'}
                    >
                        <SpeakerIcon />
                    </button>

                    <button
                        onClick={() => setIsLiveModalOpen(true)}
                        className={`p-1.5 rounded-full border transition-all active:scale-90 shrink-0 shadow-sm flex items-center justify-center h-8 w-8 cursor-pointer hover:shadow-md ${roomStatus === 'idle'
                            ? 'bg-white border-gray-100 text-gray-400 hover:bg-emerald-50 hover:text-emerald-600 hover:border-emerald-100'
                            : 'bg-emerald-600 border-emerald-700 text-white animate-pulse hover:animate-none'
                            }`}
                        title={uiLangCode === 'ko' ? '실시간 강의 공유 (방 만들기/입장)' : 'Live Sharing Room'}
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.313 7.636c5.857-5.857 15.355-5.857 21.213 0" />
                        </svg>
                    </button>
                </div>
            </div>
        </header>
    );
};

export default AppHeader;
