import React, { useState } from 'react';

interface LiveSharingModalProps {
    isOpen: boolean;
    onClose: () => void;
    roomId: string | null;
    roomStatus: 'idle' | 'hosting' | 'joined';
    onJoin: (id: string) => Promise<void>;
    onCreate: () => Promise<string | null>;
    onLeave: () => Promise<void>;
}

const LiveSharingModal: React.FC<LiveSharingModalProps> = ({
    isOpen,
    onClose,
    roomId,
    roomStatus,
    onJoin,
    onCreate,
    onLeave
}) => {
    const [joinId, setJoinId] = useState('');
    const [isBusy, setIsBusy] = useState(false);
    const [error, setError] = useState('');

    if (!isOpen) return null;

    const handleCreate = async () => {
        setIsBusy(true);
        setError('');
        try {
            await onCreate();
        } catch (e: any) {
            setError(e.message || "방 생성 실패");
        } finally {
            setIsBusy(false);
        }
    };

    const handleJoin = async () => {
        if (!joinId.trim()) return;
        setIsBusy(true);
        setError('');
        try {
            await onJoin(joinId.trim());
            onClose();
        } catch (e: any) {
            setError(e.message || "방 입장 실패");
        } finally {
            setIsBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white rounded-3xl w-full max-w-sm overflow-hidden shadow-2xl animate-in zoom-in-95 duration-200">
                <div className="p-6">
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-xl font-black text-gray-900 flex items-center gap-2">
                            <span className="text-2xl">📡</span> 실시간 강의 공유
                        </h2>
                        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>

                    {error && (
                        <div className="mb-4 p-3 bg-red-50 text-red-600 text-xs font-bold rounded-xl border border-red-100">
                            ⚠️ {error}
                        </div>
                    )}

                    {roomStatus === 'idle' ? (
                        <div className="space-y-6">
                            <div className="p-4 bg-indigo-50 rounded-2xl border border-indigo-100">
                                <p className="text-sm font-bold text-indigo-900 mb-2">교수님용 (방 만들기)</p>
                                <p className="text-[11px] text-indigo-700 leading-relaxed mb-4">
                                    강의를 실시간으로 공유할 방을 만듭니다. 생성된 번호를 학생들에게 공유하세요.
                                </p>
                                <button
                                    onClick={handleCreate}
                                    disabled={isBusy}
                                    className="w-full bg-indigo-600 text-white font-black py-3 rounded-xl shadow-lg shadow-indigo-200 hover:bg-indigo-700 active:scale-95 transition-all text-sm disabled:opacity-50"
                                >
                                    {isBusy ? '생성 중...' : '새로운 공유방 만들기'}
                                </button>
                            </div>

                            <div className="relative">
                                <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 border-t border-gray-100"></div>
                                <span className="relative block w-max mx-auto px-4 bg-white text-[10px] font-bold text-gray-400 uppercase tracking-widest">OR</span>
                            </div>

                            <div className="p-4 bg-emerald-50 rounded-2xl border border-emerald-100">
                                <p className="text-sm font-bold text-emerald-900 mb-2">학생용 (참여하기)</p>
                                <div className="flex gap-2">
                                    <input
                                        type="tel"
                                        placeholder="방 번호 6자리"
                                        value={joinId}
                                        onChange={(e) => setJoinId(e.target.value)}
                                        className="flex-1 bg-white border border-emerald-200 rounded-xl px-4 py-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-emerald-500 text-center tracking-[0.2em]"
                                        maxLength={6}
                                    />
                                    <button
                                        onClick={handleJoin}
                                        disabled={isBusy || joinId.length < 6}
                                        className="bg-emerald-600 text-white font-black px-6 rounded-xl shadow-lg shadow-emerald-200 hover:bg-emerald-700 active:scale-95 transition-all text-sm disabled:opacity-50"
                                    >
                                        입장
                                    </button>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="text-center py-6">
                            <div className="w-20 h-20 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
                                <span className="text-4xl">{roomStatus === 'hosting' ? '👑' : '👂'}</span>
                            </div>
                            <h3 className="text-lg font-black text-gray-900 mb-1">
                                {roomStatus === 'hosting' ? '강의를 공유 중입니다' : '강의를 시청 중입니다'}
                            </h3>
                            <p className="text-sm font-bold text-indigo-600 mb-6">
                                방 번호: {roomId}
                            </p>

                            <div className="bg-gray-50 rounded-2xl p-4 mb-8 text-[11px] text-gray-500 font-medium leading-relaxed">
                                {roomStatus === 'hosting'
                                    ? "마이크를 켜고 말씀하시면 학생들에게 실시간으로 전송됩니다."
                                    : "교수님이 말씀하시는 내용이 실시간으로 번역되어 나타납니다."}
                            </div>

                            <button
                                onClick={onLeave}
                                className="w-full bg-red-50 text-red-600 font-black py-4 rounded-2xl hover:bg-red-100 active:scale-95 transition-all text-sm"
                            >
                                {roomStatus === 'hosting' ? '공유 종료하기' : '방 나가기'}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default LiveSharingModal;
