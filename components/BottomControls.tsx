import React, { useState, useRef } from 'react';
import { SpeakerIcon, PlayAllIcon, CameraIcon, MicOffIcon, MicIcon } from './Icons';
import { TranslationMap, ConnectionStatus } from '../types';

// Keyboard Icon Component
const KeyboardIcon = () => (
    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <rect x="2" y="6" width="20" height="12" rx="2" strokeWidth={2} />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    </svg>
);

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
    micRestricted: boolean;
    handRaiseStatus: 'idle' | 'pending' | 'approved' | 'denied';
    isHost: boolean;
    uiLangCode: string;
    onTextSubmit?: (text: string) => void;
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
    micRestricted,
    handRaiseStatus,
    isHost,
    uiLangCode,
    onTextSubmit,
}) => {
    const [isTextMode, setIsTextMode] = useState(false);
    const [isAnimating, setIsAnimating] = useState(false);
    const [inputText, setInputText] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const longPressTimerRef = useRef<number | null>(null);

    const isMicDisabled = !isHost && micRestricted && handRaiseStatus !== 'approved';

    const handleMainButtonClick = () => {
        if (isTextMode) {
            // In text mode, submit the text
            if (inputText.trim() && onTextSubmit) {
                onTextSubmit(inputText.trim());
                setInputText('');
            }
        } else {
            // In mic mode, toggle mic
            toggleMic();
        }
    };

    const handleLongPressStart = () => {
        longPressTimerRef.current = window.setTimeout(() => {
            // Start rotation animation
            setIsAnimating(true);

            // After animation starts, switch mode
            setTimeout(() => {
                setIsTextMode(prev => !prev);
                setIsAnimating(false);
                // Focus input after render if switching to text mode
                setTimeout(() => {
                    if (inputRef.current) inputRef.current.focus();
                }, 50);
            }, 150); // Half rotation time
        }, 500);
    };

    const handleLongPressEnd = () => {
        if (longPressTimerRef.current) {
            window.clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && inputText.trim() && onTextSubmit) {
            onTextSubmit(inputText.trim());
            setInputText('');
        }
    };

    return (
        <div className="fixed bottom-0 left-0 right-0 z-50">
            {/* Text Input Field - Always mounted, controlled by max-height transition */}
            <div
                className={`overflow-hidden transition-all duration-300 ease-out ${isTextMode
                    ? 'max-h-24 opacity-100 mb-10'
                    : 'max-h-0 opacity-0 mb-0'
                    }`}
            >
                <div className="bg-white/95 backdrop-blur-xl border-t border-gray-200 px-4 py-3 shadow-lg">
                    <div className="flex items-center gap-2 max-w-2xl mx-auto">
                        <input
                            id="translation-input"
                            name="translationInput"
                            ref={inputRef}
                            type="text"
                            value={inputText}
                            onChange={(e) => setInputText(e.target.value)}
                            onKeyPress={handleKeyPress}
                            placeholder={uiLangCode === 'ko' ? '번역할 텍스트를 입력하세요...' : 'Enter text to translate...'}
                            className="flex-1 bg-gray-100 border border-gray-200 rounded-full px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                        />
                        <button
                            onClick={() => {
                                if (inputText.trim() && onTextSubmit) {
                                    onTextSubmit(inputText.trim());
                                    setInputText('');
                                }
                            }}
                            disabled={!inputText.trim()}
                            className="p-2.5 bg-indigo-600 text-white rounded-full disabled:bg-gray-300 disabled:cursor-not-allowed hover:bg-indigo-700 transition-colors active:scale-95"
                        >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                            </svg>
                        </button>
                    </div>
                </div>
            </div>

            {/* Bottom Control Bar */}
            <div className="bg-white/80 backdrop-blur-xl border-t border-gray-100 px-2 pt-2 pb-[calc(env(safe-area-inset-bottom,16px)+12px)] flex items-center justify-around shadow-[0_-10px_30px_rgba(0,0,0,0.05)]">
                {/* Left Tabs */}
                <div className="flex flex-1 justify-around items-center">
                    <button
                        onClick={() => setIsAutoPlay(!isAutoPlay)}
                        className={`flex flex-col items-center gap-1 transition-all active:scale-90 hover:scale-105 w-16 group cursor-pointer hover:text-indigo-600 ${isAutoPlay ? 'text-indigo-600' : 'text-gray-400'
                            }`}
                        title={isAutoPlay ? (uiLangCode === 'ko' ? '자동 읽기 끄기' : 'Turn off auto-play') : (uiLangCode === 'ko' ? '자동 읽기 켜기' : 'Turn on auto-play')}
                    >
                        <div className={`p-2 rounded-xl transition-all group-hover:bg-indigo-50 ${isAutoPlay ? 'bg-indigo-50 shadow-sm' : 'bg-transparent'}`}>
                            <SpeakerIcon />
                        </div>
                        <span className="text-[9px] font-bold tracking-tighter whitespace-nowrap">{t.autoPlay}</span>
                    </button>

                    <button
                        onClick={() => setIsScrollLocked(!isScrollLocked)}
                        className={`flex flex-col items-center gap-1 transition-all active:scale-90 hover:scale-105 w-16 group cursor-pointer hover:text-indigo-600 ${!isScrollLocked ? 'text-indigo-600' : 'text-gray-400'
                            }`}
                        title={isScrollLocked ? (uiLangCode === 'ko' ? '자동 스크롤 켜기' : 'Enable auto-scroll') : (uiLangCode === 'ko' ? '자동 스크롤 끄기' : 'Disable auto-scroll')}
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
                        <span className="text-[9px] font-bold tracking-tighter whitespace-nowrap">{t.autoScroll || '자동스크롤'}</span>
                    </button>
                </div>

                {/* Central Main Button - Toggle between Mic and Keyboard */}
                <div className="relative -mt-10 px-4 flex flex-col items-center">
                    <div
                        className="flex flex-col items-center gap-1.5 transition-all duration-300"
                        style={{
                            transform: isAnimating ? 'perspective(600px) rotateY(15deg) scale(0.95)' : 'perspective(600px) rotateY(0deg) scale(1)',
                            opacity: isAnimating ? 0.7 : 1,
                        }}
                    >
                        <button
                            onClick={handleMainButtonClick}
                            onMouseDown={handleLongPressStart}
                            onMouseUp={handleLongPressEnd}
                            onMouseLeave={handleLongPressEnd}
                            onTouchStart={handleLongPressStart}
                            onTouchEnd={handleLongPressEnd}
                            className={`flex items-center justify-center shadow-2xl border-[6px] border-white transition-all transform hover:scale-110 active:scale-90 cursor-pointer w-18 h-18 md:w-20 md:h-20 ${isTextMode
                                ? 'rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-emerald-200'
                                : status === ConnectionStatus.CONNECTED
                                    ? 'rounded-full bg-gradient-to-br from-red-500 to-rose-600 text-white shadow-red-200'
                                    : isMicDisabled
                                        ? 'rounded-full bg-gray-400 text-white/50 shadow-none cursor-not-allowed opacity-60'
                                        : 'rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-indigo-200'
                                }`}
                            disabled={!isTextMode && isMicDisabled}
                            title={isTextMode
                                ? (uiLangCode === 'ko' ? '텍스트 전송 (길게 눌러 마이크 모드)' : 'Send text (hold for mic mode)')
                                : isMicDisabled
                                    ? '발언권이 제한되었습니다.'
                                    : (status === ConnectionStatus.CONNECTED ? '마이크 끄기 (길게 눌러 키보드 모드)' : '마이크 켜기 (길게 눌러 키보드 모드)')}
                        >
                            {/* Icon container with 3D flip animation (Y-axis like a door) */}
                            <div
                                className="scale-125 transition-all duration-300"
                                style={{
                                    transform: isAnimating ? 'perspective(200px) rotateY(90deg)' : 'perspective(200px) rotateY(0deg)',
                                    transformStyle: 'preserve-3d',
                                }}
                            >
                                {isTextMode ? (
                                    <KeyboardIcon />
                                ) : status === ConnectionStatus.CONNECTING ? (
                                    <div className="w-8 h-8 border-3 border-white/30 border-t-white rounded-full animate-spin"></div>
                                ) : isMicDisabled ? (
                                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                    </svg>
                                ) : status === ConnectionStatus.CONNECTED ? (
                                    <MicOffIcon />
                                ) : (
                                    <MicIcon />
                                )}
                            </div>
                            {/* Hand Raise Status Badge for Mic */}
                            {!isHost && micRestricted && handRaiseStatus === 'approved' && !isTextMode && (
                                <div className="absolute -top-1 -right-1 bg-emerald-500 text-white w-6 h-6 rounded-full flex items-center justify-center text-[10px] shadow-lg border-2 border-white animate-bounce">
                                    ✋
                                </div>
                            )}
                        </button>
                        {/* Mode indicator text */}
                        <span className={`text-[8px] text-gray-400 font-bold whitespace-pre-wrap text-center leading-tight transition-all duration-300 ${isAnimating ? 'opacity-0 scale-50' : 'opacity-100 scale-100'}`}>
                            {uiLangCode === 'ko'
                                ? (isTextMode ? '길게 누르면\n마이크' : '길게 누르면\n키보드')
                                : (isTextMode ? 'Hold for\nMic' : 'Hold for\nKeyboard')}
                        </span>
                    </div>

                </div>

                {/* Right Tabs */}
                <div className="flex flex-1 justify-around items-center">
                    <button
                        onClick={playAll}
                        className="flex flex-col items-center gap-1 text-gray-400 transition-all active:scale-90 hover:scale-105 w-14 hover:text-indigo-600 group cursor-pointer"
                        title={uiLangCode === 'ko' ? '전체 음성 재생' : 'Play all history'}
                    >
                        <div className="p-2 rounded-xl group-hover:bg-indigo-50 transition-all">
                            <PlayAllIcon />
                        </div>
                        <span className="text-[9px] font-bold tracking-tighter">{t.playAll}</span>
                    </button>

                    <button
                        onClick={() => setIsCameraOpen(true)}
                        className="flex flex-col items-center gap-1 text-gray-400 transition-all active:scale-90 hover:scale-105 w-14 hover:text-emerald-600 group cursor-pointer"
                        title={uiLangCode === 'ko' ? '칠판/노트 촬영 및 번역' : 'Capture & Translate notes'}
                    >
                        <div className="p-2 rounded-xl group-hover:bg-emerald-50 transition-all">
                            <CameraIcon />
                        </div>
                        <span className="text-[9px] font-bold tracking-tighter whitespace-nowrap">
                            {uiLangCode === 'jp' ? '撮影' : t.visionButton}
                        </span>
                    </button>
                </div>
            </div>
        </div>
    );
};

export default BottomControls;
