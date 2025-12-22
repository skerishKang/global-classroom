import React from 'react';
import { SpeakerIcon, PlayAllIcon, CameraIcon, MicOffIcon, MicIcon } from './Icons';
import { TranslationMap, ConnectionStatus } from '../types';

interface BottomControlsProps {
    isAutoPlay: boolean;
    setIsAutoPlay: (v: boolean) => void;
    isScrollLocked: boolean;
    setIsScrollLocked: (v: boolean) => void;
    status: ConnectionStatus;
    toggleMic: () => void;
    playAll: () => void;
    setIsCameraOpen: (v: boolean) => void;
    t: TranslationMap;
}

const BottomControls: React.FC<BottomControlsProps> = ({
    isAutoPlay,
    setIsAutoPlay,
    isScrollLocked,
    setIsScrollLocked,
    status,
    toggleMic,
    playAll,
    setIsCameraOpen,
    t,
}) => {
    return (
        <div className="fixed bottom-0 left-0 right-0 bg-white/80 backdrop-blur-xl border-t border-gray-100 px-2 pt-2 pb-[calc(env(safe-area-inset-bottom,16px)+12px)] flex items-center justify-around z-50 shadow-[0_-10px_30px_rgba(0,0,0,0.05)]">
            {/* Left Tabs */}
            <div className="flex flex-1 justify-around items-center">
                <button
                    onClick={() => setIsAutoPlay(!isAutoPlay)}
                    className={`flex flex-col items-center gap-1 transition-all active:scale-90 w-14 group ${isAutoPlay ? 'text-indigo-600' : 'text-gray-400'
                        }`}
                    title={isAutoPlay ? '자동 읽기 끄기' : '자동 읽기 켜기'}
                >
                    <div className={`p-2 rounded-xl transition-all group-hover:bg-indigo-50 ${isAutoPlay ? 'bg-indigo-50 shadow-sm' : 'bg-transparent'}`}>
                        <SpeakerIcon />
                    </div>
                    <span className="text-[9px] font-bold tracking-tighter">{t.autoPlay}</span>
                </button>

                <button
                    onClick={() => setIsScrollLocked(!isScrollLocked)}
                    className={`flex flex-col items-center gap-1 transition-all active:scale-90 w-14 group ${!isScrollLocked ? 'text-indigo-600' : 'text-gray-400'
                        }`}
                    title={isScrollLocked ? '자동 스크롤 켜기' : '자동 스크롤 끄기'}
                >
                    <div className={`p-2 rounded-xl transition-all group-hover:bg-indigo-50 ${!isScrollLocked ? 'bg-indigo-50 shadow-sm' : 'bg-transparent'}`}>
                        {isScrollLocked ? (
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 002-2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                            </svg>
                        ) : (
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                            </svg>
                        )}
                    </div>
                    <span className="text-[9px] font-bold tracking-tighter">{t.autoScroll || '자동스크롤'}</span>
                </button>
            </div>

            {/* Central Main Button */}
            <div className="relative -mt-10 px-4">
                <button
                    onClick={toggleMic}
                    className={`w-18 h-18 md:w-20 md:h-20 rounded-full flex items-center justify-center shadow-2xl border-[6px] border-white transition-all transform hover:scale-105 active:scale-90 ${status === ConnectionStatus.CONNECTED
                        ? 'bg-gradient-to-br from-red-500 to-rose-600 text-white shadow-red-200'
                        : 'bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-indigo-200'
                        }`}
                    title={status === ConnectionStatus.CONNECTED ? '마이크 끄기' : '마이크 켜기'}
                >
                    <div className="scale-125">
                        {status === ConnectionStatus.CONNECTING ? (
                            <div className="w-8 h-8 border-3 border-white/30 border-t-white rounded-full animate-spin"></div>
                        ) : status === ConnectionStatus.CONNECTED ? (
                            <MicOffIcon />
                        ) : (
                            <MicIcon />
                        )}
                    </div>
                </button>
            </div>

            {/* Right Tabs */}
            <div className="flex flex-1 justify-around items-center">
                <button
                    onClick={playAll}
                    className="flex flex-col items-center gap-1 text-gray-400 transition-all active:scale-90 w-14 hover:text-indigo-600 group"
                    title="전체 음성 재생"
                >
                    <div className="p-2 rounded-xl group-hover:bg-indigo-50 transition-all">
                        <PlayAllIcon />
                    </div>
                    <span className="text-[9px] font-bold tracking-tighter">{t.playAll}</span>
                </button>

                <button
                    onClick={() => setIsCameraOpen(true)}
                    className="flex flex-col items-center gap-1 text-gray-400 transition-all active:scale-90 w-14 hover:text-emerald-600 group"
                    title="칠판/노트 촬영 및 번역"
                >
                    <div className="p-2 rounded-xl group-hover:bg-emerald-50 transition-all">
                        <CameraIcon />
                    </div>
                    <span className="text-[9px] font-bold tracking-tighter">{t.visionButton}</span>
                </button>
            </div>
        </div>
    );
};

export default BottomControls;
