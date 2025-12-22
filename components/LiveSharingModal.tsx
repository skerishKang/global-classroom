import React, { useState } from 'react';

type LiveSharingModalProps = {
    isOpen: boolean;
    onClose: () => void;
    roomId: string;
    roomStatus: 'idle' | 'hosting' | 'joined';
    onJoin: (roomId: string) => Promise<void>;
    onCreate: () => Promise<void>;
    onLeave: () => Promise<void>;
    micRestricted: boolean;
    handRaiseStatus: 'idle' | 'pending' | 'approved' | 'denied';
    pendingHandRaises: any[];
    onToggleMicRestriction: (restricted: boolean) => Promise<void>;
    onRaiseHand: () => Promise<void>;
    onLowerHand: () => Promise<void>;
    onApproveHandRaise: (uid: string) => Promise<void>;
    onDenyHandRaise: (uid: string) => Promise<void>;
    localStream: MediaStream | null;
    remoteStreams: Record<string, MediaStream>;
    isVideoOn: boolean;
    onStartVideo: () => Promise<void>;
    onStopVideo: () => void;
};

const LiveSharingModal = ({
    isOpen,
    onClose,
    roomId,
    roomStatus,
    onJoin,
    onCreate,
    onLeave,
    micRestricted,
    handRaiseStatus,
    pendingHandRaises,
    onToggleMicRestriction,
    onRaiseHand,
    onLowerHand,
    onApproveHandRaise,
    onDenyHandRaise,
    localStream,
    remoteStreams,
    isVideoOn,
    onStartVideo,
    onStopVideo
}: LiveSharingModalProps) => {
    const [joinId, setJoinId] = useState('');
    const [isBusy, setIsBusy] = useState(false);
    const [error, setError] = useState('');
    const [isCameraFront, setIsCameraFront] = useState(true);

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
                        <div className="text-center py-4">
                            <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-3 animate-pulse">
                                <span className="text-3xl">{roomStatus === 'hosting' ? '👑' : '👂'}</span>
                            </div>
                            <h3 className="text-base font-black text-gray-900 mb-0.5">
                                {roomStatus === 'hosting' ? '강의 공유 중' : '강의 시청 중'}
                            </h3>
                            <p className="text-sm font-bold text-indigo-600 mb-4">
                                방 번호: {roomId}
                            </p>

                            {/* Host Controls */}
                            {roomStatus === 'hosting' && (
                                <div className="space-y-4 mb-6 text-left">
                                    <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl border border-gray-100">
                                        <div>
                                            <p className="text-xs font-black text-gray-800">학생 마이크 제한</p>
                                            <p className="text-[10px] text-gray-500">학생들이 자유롭게 말을 할 수 없게 합니다.</p>
                                        </div>
                                        <button
                                            onClick={() => onToggleMicRestriction(!micRestricted)}
                                            className={`w-12 h-6 rounded-full transition-colors relative ${micRestricted ? 'bg-red-500' : 'bg-gray-300'}`}
                                        >
                                            <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${micRestricted ? 'left-7' : 'left-1'}`} />
                                        </button>
                                    </div>

                                    {pendingHandRaises.length > 0 && (
                                        <div className="border-t pt-4">
                                            <p className="text-xs font-black text-gray-800 mb-2 flex items-center gap-1.5">
                                                <span>✋</span> 발언 요청 ({pendingHandRaises.length})
                                            </p>
                                            <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
                                                {pendingHandRaises.map(req => (
                                                    <div key={req.studentUid} className="flex items-center justify-between p-2 bg-indigo-50 rounded-lg border border-indigo-100">
                                                        <span className="text-[11px] font-bold text-indigo-900">{req.displayName}</span>
                                                        <div className="flex gap-1.5">
                                                            <button
                                                                onClick={() => onApproveHandRaise(req.studentUid)}
                                                                className="px-2 py-1 bg-indigo-600 text-white text-[10px] font-black rounded-md hover:bg-indigo-700"
                                                            >
                                                                승인
                                                            </button>
                                                            <button
                                                                onClick={() => onDenyHandRaise(req.studentUid)}
                                                                className="px-2 py-1 bg-white text-gray-500 text-[10px] font-bold rounded-md border border-gray-200"
                                                            >
                                                                거절
                                                            </button>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Student Status/Actions */}
                            {roomStatus === 'joined' && (
                                <div className="space-y-4 mb-6">
                                    {micRestricted ? (
                                        <div className="p-4 bg-orange-50 rounded-2xl border border-orange-100 text-left">
                                            <p className="text-xs font-black text-orange-900 mb-1 flex items-center gap-1.5">
                                                <span>🔒</span> 마이크 사용이 제한되었습니다
                                            </p>
                                            <p className="text-[10px] text-orange-700 leading-relaxed mb-3">
                                                관리자가 학생의 마이크 사용을 제한했습니다. 질문이 있다면 손을 들어 승인을 요청하세요.
                                            </p>

                                            {handRaiseStatus === 'idle' || handRaiseStatus === 'denied' ? (
                                                <button
                                                    onClick={onRaiseHand}
                                                    className="w-full bg-orange-500 text-white font-black py-2.5 rounded-xl shadow-lg shadow-orange-100 hover:bg-orange-600 active:scale-95 transition-all text-xs"
                                                >
                                                    ✋ 손들기 (발언권 요청)
                                                </button>
                                            ) : handRaiseStatus === 'pending' ? (
                                                <div className="flex gap-2">
                                                    <div className="flex-1 bg-gray-200 text-gray-500 font-bold py-2.5 rounded-xl text-xs flex items-center justify-center gap-2">
                                                        <div className="w-2 h-2 bg-gray-400 rounded-full animate-pulse" />
                                                        승인 대기 중...
                                                    </div>
                                                    <button
                                                        onClick={onLowerHand}
                                                        className="px-4 bg-white text-gray-400 font-bold rounded-xl border border-gray-200 text-[10px]"
                                                    >
                                                        취소
                                                    </button>
                                                </div>
                                            ) : (
                                                <div className="bg-emerald-500 text-white font-black py-2.5 rounded-xl text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-100 animate-bounce duration-1000">
                                                    <span>✅</span> 발언이 승인되었습니다!
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="bg-emerald-50 rounded-2xl p-4 text-[11px] text-emerald-700 font-bold leading-relaxed border border-emerald-100">
                                            🔓 현재 마이크 사용이 허용된 상태입니다. 자유롭게 질문하실 수 있습니다.
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* --- Video Grid (WebRTC) --- */}
                            {isVideoOn && (
                                <div className="grid grid-cols-1 gap-3 mb-6">
                                    {/* Local Video */}
                                    {localStream && (
                                        <div className="relative bg-black rounded-2xl overflow-hidden aspect-video border-2 border-indigo-500 shadow-xl">
                                            <video
                                                autoPlay
                                                muted
                                                playsInline
                                                ref={(v) => { if (v) v.srcObject = localStream; }}
                                                className={`w-full h-full object-cover ${isCameraFront ? 'scale-x-[-1]' : ''}`}
                                            />
                                            <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] font-bold px-2 py-1 rounded-lg backdrop-blur-md border border-white/20">
                                                나 (Me)
                                            </div>
                                        </div>
                                    )}
                                    {/* Remote Videos */}
                                    {Object.entries(remoteStreams).map(([uid, stream]) => (
                                        <div key={uid} className="relative bg-black rounded-2xl overflow-hidden aspect-video border border-gray-100 shadow-xl">
                                            <video
                                                autoPlay
                                                playsInline
                                                ref={(v) => { if (v) v.srcObject = stream; }}
                                                className="w-full h-full object-cover"
                                            />
                                            <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] font-bold px-2 py-1 rounded-lg backdrop-blur-md border border-white/20">
                                                {roomStatus === 'hosting' ? '전체 강의 화면' : '교수님'}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            <div className="grid grid-cols-2 gap-2 mb-4">
                                {!isVideoOn ? (
                                    <button
                                        onClick={onStartVideo}
                                        className="col-span-2 bg-indigo-600 text-white font-black py-3.5 rounded-2xl shadow-lg shadow-indigo-100 hover:bg-indigo-700 active:scale-95 transition-all text-sm flex items-center justify-center gap-2"
                                    >
                                        <span className="text-xl">📹</span> 비디오 켜기
                                    </button>
                                ) : (
                                    <>
                                        <button
                                            onClick={onStopVideo}
                                            className="bg-red-500 text-white font-black py-3 rounded-2xl shadow-lg shadow-red-100 hover:bg-red-600 active:scale-95 transition-all text-sm"
                                        >
                                            비디오 끄기
                                        </button>
                                        <button
                                            onClick={() => setIsCameraFront(!isCameraFront)}
                                            className="bg-gray-100 text-gray-600 font-black py-3 rounded-2xl hover:bg-gray-200 active:scale-95 transition-all text-sm"
                                        >
                                            카메라 반전
                                        </button>
                                    </>
                                )}
                            </div>

                            <button
                                onClick={onLeave}
                                className="w-full bg-gray-50 text-gray-500 font-bold py-3 rounded-2xl hover:bg-gray-100 active:scale-95 transition-all text-xs"
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
