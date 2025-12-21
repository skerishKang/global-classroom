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
        <div className="bg-white px-6 py-4 rounded-t-[2rem] shadow-[0_-5px_20px_rgba(0,0,0,0.05)] flex items-center justify-between z-30 shrink-0">
            <div className="flex items-center gap-1">
                <button
                    onClick={() => setIsAutoPlay(!isAutoPlay)}
                    className={`flex flex-col items-center gap-1.5 transition-all active:scale-75 w-16 group ${isAutoPlay ? 'text-indigo-600' : 'text-gray-400'
                        }`}
                >
                    <div className={`p-3.5 rounded-full shadow-sm group-hover:shadow-xl group-hover:scale-110 transition-all ${isAutoPlay ? 'bg-indigo-100 group-hover:bg-indigo-600 group-hover:text-white' : 'bg-gray-50 group-hover:bg-white border border-gray-100'
                        }`}>
                        <SpeakerIcon />
                    </div>
                    <span className="text-[10px] font-black tracking-tighter group-hover:text-indigo-600 transition-colors">{t.autoPlay}</span>
                </button>

                <button
                    onClick={() => setIsScrollLocked(!isScrollLocked)}
                    className={`flex flex-col items-center gap-1.5 transition-all active:scale-75 w-16 group ${!isScrollLocked ? 'text-indigo-600' : 'text-gray-400'
                        }`}
                >
                    <div className={`p-3.5 rounded-full shadow-sm group-hover:shadow-xl group-hover:scale-110 transition-all ${!isScrollLocked ? 'bg-indigo-100 group-hover:bg-indigo-600 group-hover:text-white' : 'bg-gray-50 group-hover:bg-white border border-gray-100'
                        }`}>
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
                    <span className="text-[10px] font-black tracking-tighter group-hover:text-indigo-600 transition-colors">자동스크롤</span>
                </button>
            </div>

            <button
                onClick={toggleMic}
                className={`w-24 h-24 -mt-12 rounded-full flex items-center justify-center shadow-2xl border-4 border-white transition-all transform hover:scale-110 hover:brightness-110 active:scale-75 ${status === ConnectionStatus.CONNECTED
                    ? 'bg-gradient-to-br from-red-500 to-red-600 text-white shadow-red-200 ring-8 ring-red-50'
                    : 'bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-indigo-200 ring-8 ring-indigo-50'
                    }`}
            >
                {status === ConnectionStatus.CONNECTING ? (
                    <div className="w-10 h-10 border-4 border-white/30 border-t-white rounded-full animate-spin"></div>
                ) : status === ConnectionStatus.CONNECTED ? (
                    <div className="scale-150 animate-pulse"><MicOffIcon /></div>
                ) : (
                    <div className="scale-150 group-hover:scale-175 transition-transform"><MicIcon /></div>
                )}
            </button>

            <div className="flex items-center gap-1">
                <button
                    onClick={playAll}
                    className="flex flex-col items-center gap-1.5 text-gray-400 transition-all active:scale-75 w-16 group"
                >
                    <div className="p-3.5 bg-gray-50 rounded-full shadow-sm border border-gray-100 group-hover:bg-indigo-600 group-hover:text-white group-hover:shadow-xl group-hover:scale-110 transition-all">
                        <PlayAllIcon />
                    </div>
                    <span className="text-[10px] font-black tracking-tighter group-hover:text-indigo-600 transition-colors">{t.playAll}</span>
                </button>

                <button
                    onClick={() => setIsCameraOpen(true)}
                    className="flex flex-col items-center gap-1.5 text-gray-400 transition-all active:scale-75 w-16 group"
                >
                    <div className="p-3.5 bg-gray-50 rounded-full shadow-sm border border-gray-100 group-hover:bg-emerald-600 group-hover:text-white group-hover:shadow-xl group-hover:scale-110 transition-all">
                        <CameraIcon />
                    </div>
                    <span className="text-[10px] font-black tracking-tighter group-hover:text-emerald-600 transition-colors">{t.visionButton}</span>
                </button>
            </div>
        </div>
    );
};

export default BottomControls;
