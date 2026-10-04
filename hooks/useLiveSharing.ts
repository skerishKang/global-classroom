import { useState, useEffect, useCallback, useRef } from 'react';
import {
    getAppFirestore
} from '../utils/firebase';
import {
    collection,
    doc,
    setDoc,
    onSnapshot,
    query,
    orderBy,
    addDoc,
    Timestamp,
    limit,
    getDoc,
    where,
    updateDoc,
    deleteDoc,
    collectionGroup,
    serverTimestamp
} from 'firebase/firestore';
import { ConversationItem, Language } from '../types';
import { createRoomWithUniqueCode, ListenerTracker } from '../utils/liveSharingRoom';

interface RoomData {
    id: string;
    hostUid: string;
    createdAt: any;
    status: 'active' | 'closed';
    micRestricted?: boolean;
}

export type HandRaiseStatus = 'idle' | 'pending' | 'approved' | 'denied';

interface HandRaiseData {
    studentUid: string;
    displayName: string;
    timestamp: any;
    status: HandRaiseStatus;
}

const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
    ],
};

interface UseLiveSharingProps {
    user: any;
    onMessageReceived: (text: string, langCode: string) => void;
}

export function useLiveSharing({ user, onMessageReceived }: UseLiveSharingProps) {
    const [roomId, setRoomId] = useState<string | null>(null);
    const [isHost, setIsHost] = useState(false);
    const [roomStatus, setRoomStatus] = useState<'idle' | 'hosting' | 'joined'>('idle');
    const [micRestricted, setMicRestricted] = useState(false);
    const [handRaiseStatus, setHandRaiseStatus] = useState<HandRaiseStatus>('idle');
    const [pendingHandRaises, setPendingHandRaises] = useState<HandRaiseData[]>([]);
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
    const [isVideoOn, setIsVideoOn] = useState(false);

    const listenerTrackerRef = useRef<ListenerTracker | null>(null);
    if (!listenerTrackerRef.current) {
        listenerTrackerRef.current = new ListenerTracker();
    }
    const localStreamRef = useRef<MediaStream | null>(null);
    const peerConnectionsRef = useRef<Record<string, RTCPeerConnection>>({});
    const lastMessageTimeRef = useRef<number>(0);

    const stopLocalMedia = useCallback(() => {
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => track.stop());
            localStreamRef.current = null;
        }
        setLocalStream(null);
        setIsVideoOn(false);
    }, []);

    // Dispose runtime resources only: listeners, media tracks, peer connections.
    const disposeResources = useCallback(() => {
        listenerTrackerRef.current?.disposeAll();

        // Close peer connections
        Object.values(peerConnectionsRef.current as Record<string, RTCPeerConnection>).forEach(pc => pc.close());
        peerConnectionsRef.current = {};

        // Stop local stream
        stopLocalMedia();
        setRemoteStreams({});
    }, [stopLocalMedia]);

    // Reset React state for the room session (identity/UI state only).
    const resetRoomState = useCallback(() => {
        setRoomId(null);
        setIsHost(false);
        setRoomStatus('idle');
        setMicRestricted(false);
        setHandRaiseStatus('idle');
        setPendingHandRaises([]);
    }, []);

    // Stable identity: never depends on media/session state, so a localStream
    // change cannot re-trigger the unmount effect and reset an active room.
    const cleanup = useCallback(() => {
        disposeResources();
        resetRoomState();
    }, [disposeResources, resetRoomState]);

    // 1. Create a Room (Host)
    const createRoom = useCallback(async () => {
        if (!user?.uid) return null;
        cleanup();

        const db = getAppFirestore();
        // Atomically claim a free 6-digit code; an existing room document is never overwritten.
        const newRoomId = await createRoomWithUniqueCode(db, (code) => ({
            id: code,
            hostUid: user.uid,
            createdAt: Timestamp.now(),
            status: 'active',
            micRestricted: false
        }));

        // Listen for hand raises (Host side)
        const handsRef = collection(db, "rooms", newRoomId, "handRaises");
        const qHands = query(handsRef, orderBy("timestamp", "asc"));
        listenerTrackerRef.current?.trackRoom(onSnapshot(qHands, (snapshot) => {
            const list: HandRaiseData[] = [];
            snapshot.forEach(doc => {
                const data = doc.data() as HandRaiseData;
                if (data.status === 'pending') {
                    list.push(data);
                }
            });
            setPendingHandRaises(list);
        }));

        setRoomId(newRoomId);
        setIsHost(true);
        setRoomStatus('hosting');
        return newRoomId;
    }, [user, cleanup]);

    // 2. Join a Room (Student)
    const joinRoom = useCallback(async (targetRoomId: string) => {
        cleanup();
        const db = getAppFirestore();
        const roomRef = doc(db, "rooms", targetRoomId);
        const roomSnap = await getDoc(roomRef);

        if (!roomSnap.exists() || roomSnap.data().status !== 'active') {
            throw new Error("유효하지 않거나 종료된 방 번호입니다.");
        }

        setRoomId(targetRoomId);
        setIsHost(false);
        setRoomStatus('joined');

        // Listen for room changes (especially micRestricted status)
        listenerTrackerRef.current?.trackRoom(onSnapshot(roomRef, (doc) => {
            if (doc.exists()) {
                const data = doc.data() as RoomData;
                setMicRestricted(!!data.micRestricted);
            }
        }));

        // Listen for own hand raise status (disposed on leave like every other listener)
        if (user?.uid) {
            const handRef = doc(db, "rooms", targetRoomId, "handRaises", user.uid);
            listenerTrackerRef.current?.trackRoom(onSnapshot(handRef, (doc) => {
                if (doc.exists()) {
                    setHandRaiseStatus(doc.data().status);
                } else {
                    setHandRaiseStatus('idle');
                }
            }));
        }

        // Listen for new messages
        const msgsRef = collection(db, "rooms", targetRoomId, "messages");
        const q = query(msgsRef, orderBy("timestamp", "asc"));

        listenerTrackerRef.current?.trackRoom(onSnapshot(q, (snapshot) => {
            snapshot.docChanges().forEach((change) => {
                if (change.type === "added") {
                    const data = change.doc.data();
                    const msgTime = data.timestamp?.toMillis() || 0;
                    // Only process messages added after we joined (approx)
                    if (msgTime > lastMessageTimeRef.current) {
                        onMessageReceived(data.text, data.langCode);
                        lastMessageTimeRef.current = msgTime;
                    }
                }
            });
        }));

        lastMessageTimeRef.current = Date.now();
    }, [cleanup, onMessageReceived, user]);

    // 3. Moderation & Hand Raise Functions
    const toggleMicRestriction = useCallback(async (restricted: boolean) => {
        if (!isHost || !roomId) return;
        const db = getAppFirestore();
        const roomRef = doc(db, "rooms", roomId);
        await updateDoc(roomRef, { micRestricted: restricted });
    }, [isHost, roomId]);

    const raiseHand = useCallback(async () => {
        if (isHost || !roomId || !user) return;
        const db = getAppFirestore();
        const handRef = doc(db, "rooms", roomId, "handRaises", user.uid);
        await setDoc(handRef, {
            studentUid: user.uid,
            displayName: user.displayName || 'Guest',
            timestamp: Timestamp.now(),
            status: 'pending'
        });
    }, [isHost, roomId, user]);

    const lowerHand = useCallback(async () => {
        if (isHost || !roomId || !user) return;
        const db = getAppFirestore();
        const handRef = doc(db, "rooms", roomId, "handRaises", user.uid);
        await deleteDoc(handRef);
    }, [isHost, roomId, user]);

    const approveHandRaise = useCallback(async (studentUid: string) => {
        if (!isHost || !roomId) return;
        const db = getAppFirestore();
        const handRef = doc(db, "rooms", roomId, "handRaises", studentUid);
        await updateDoc(handRef, { status: 'approved' });
    }, [isHost, roomId]);

    const denyHandRaise = useCallback(async (studentUid: string) => {
        if (!isHost || !roomId) return;
        const db = getAppFirestore();
        const handRef = doc(db, "rooms", roomId, "handRaises", studentUid);
        await updateDoc(handRef, { status: 'denied' });
    }, [isHost, roomId]);

    // Dispose a single peer's resources: its connection, listeners and remote stream.
    const removePeer = useCallback((peerId: string) => {
        listenerTrackerRef.current?.disposePeer(peerId);
        const pc = peerConnectionsRef.current[peerId];
        if (pc) {
            pc.close();
            delete peerConnectionsRef.current[peerId];
        }
        setRemoteStreams(prev => {
            if (!prev[peerId]) return prev;
            const next = { ...prev };
            delete next[peerId];
            return next;
        });
    }, []);

    // 5. WebRTC Stream & Signaling
    const startWebRTC = useCallback(async () => {
        if (!roomId || !user) return;
        try {
            // Dispose any previous WebRTC runtime first so start → stop → start
            // (or a double start) can never leave stale listeners/streams behind.
            stopWebRTC();

            const stream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });
            localStreamRef.current = stream;
            setLocalStream(stream);
            setIsVideoOn(true);

            if (isHost) {
                // Host setup: signaling for EACH student
                const db = getAppFirestore();
                const webrtcRef = collection(db, "rooms", roomId, "webRTC");
                listenerTrackerRef.current?.trackWebRtc(onSnapshot(webrtcRef, (snapshot) => {
                    snapshot.docChanges().forEach(async (change) => {
                        const studentUid = change.doc.id;
                        if (studentUid === user.uid) return;

                        if (change.type === "added") {
                            // New student joined, create connection
                            setupHostPeer(studentUid, stream);
                        } else if (change.type === "removed") {
                            // Student left: close only that peer's connection + listeners
                            removePeer(studentUid);
                        }
                    });
                }));
            } else {
                // Student setup: signaling for THE host
                // Register ourselves in webRTC collection
                const db = getAppFirestore();
                const signalRef = doc(db, "rooms", roomId, "webRTC", user.uid);
                await setDoc(signalRef, {
                    uid: user.uid,
                    displayName: user.displayName || 'Student',
                    joinedAt: serverTimestamp()
                }, { merge: true });

                setupStudentPeer(signalRef, stream);
            }
        } catch (err) {
            console.error("Failed to get media devices:", err);
            throw err;
        }
    }, [roomId, user, isHost, removePeer]);

    const stopWebRTC = useCallback(() => {
        stopLocalMedia();

        Object.values(peerConnectionsRef.current as Record<string, RTCPeerConnection>).forEach(pc => pc.close());
        peerConnectionsRef.current = {};

        // Dispose WebRTC-owned listeners only; room listeners stay until leave/cleanup.
        listenerTrackerRef.current?.disposeWebRtc();
        listenerTrackerRef.current?.disposePeers();
        setRemoteStreams({});
    }, [stopLocalMedia]);

    const setupHostPeer = useCallback(async (studentUid: string, stream: MediaStream) => {
        if (!roomId || !user) return;
        const db = getAppFirestore();
        const pc = new RTCPeerConnection(ICE_CONFIG);
        peerConnectionsRef.current[studentUid] = pc;

        stream.getTracks().forEach(track => pc.addTrack(track, stream));

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                const candidatesRef = collection(db, "rooms", roomId, "webRTC", studentUid, "candidates");
                addDoc(candidatesRef, { ...event.candidate.toJSON(), sender: 'host' });
            }
        };

        pc.ontrack = (event) => {
            setRemoteStreams(prev => ({ ...prev, [studentUid]: event.streams[0] }));
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const signalRef = doc(db, "rooms", roomId, "webRTC", studentUid);
        await updateDoc(signalRef, { offer: { sdp: offer.sdp, type: offer.type } });

        // The peer may have been removed while the offer was being written.
        if (peerConnectionsRef.current[studentUid] !== pc) return;

        // Listen for answer (owned per-peer, disposed with the peer)
        listenerTrackerRef.current?.trackPeer(studentUid, onSnapshot(signalRef, async (snapshot) => {
            const data = snapshot.data();
            if (data?.answer && !pc.currentRemoteDescription) {
                await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            }
        }));

        // Listen for student candidates
        const candidatesRef = collection(db, "rooms", roomId, "webRTC", studentUid, "candidates");
        const q = query(candidatesRef, where("sender", "==", "client"));
        listenerTrackerRef.current?.trackPeer(studentUid, onSnapshot(q, (snapshot) => {
            snapshot.docChanges().forEach(async (change) => {
                if (change.type === "added") {
                    await pc.addIceCandidate(new RTCIceCandidate(change.doc.data() as any));
                }
            });
        }));
    }, [roomId, user]);

    const setupStudentPeer = useCallback(async (signalRef: any, stream: MediaStream) => {
        const pc = new RTCPeerConnection(ICE_CONFIG);
        const hostUid = 'HOST'; // We treat host specially or we'd need host's UID. 
        // In our case, the host creates the room, their UID is hostUid in room doc.

        peerConnectionsRef.current[hostUid] = pc;
        stream.getTracks().forEach(track => pc.addTrack(track, stream));

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                const candidatesRef = collection(signalRef, "candidates");
                addDoc(candidatesRef, { ...event.candidate.toJSON(), sender: 'client' });
            }
        };

        pc.ontrack = (event) => {
            setRemoteStreams(prev => ({ ...prev, [hostUid]: event.streams[0] }));
        };

        // Listen for offer (owned per-peer, disposed with the peer)
        listenerTrackerRef.current?.trackPeer(hostUid, onSnapshot(signalRef, async (snapshot) => {
            const data = snapshot.data();
            if (data?.offer && !pc.currentRemoteDescription) {
                await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                await updateDoc(signalRef, { answer: { sdp: answer.sdp, type: answer.type } });
            }
        }));

        // Listen for host candidates
        const candidatesRef = collection(signalRef, "candidates");
        const q = query(candidatesRef, where("sender", "==", "host"));
        listenerTrackerRef.current?.trackPeer(hostUid, onSnapshot(q, (snapshot) => {
            snapshot.docChanges().forEach(async (change) => {
                if (change.type === "added") {
                    await pc.addIceCandidate(new RTCIceCandidate(change.doc.data() as any));
                }
            });
        }));
    }, []);

    // 6. Broadcast Message
    const broadcastMessage = useCallback(async (text: string, langCode: string) => {
        if (!roomId) return;
        // Host can always broadcast, Students only if not restricted or approved
        if (!isHost && micRestricted && handRaiseStatus !== 'approved') return;

        const db = getAppFirestore();
        const msgsRef = collection(db, "rooms", roomId, "messages");
        await addDoc(msgsRef, {
            text,
            langCode,
            timestamp: Timestamp.now(),
            senderUid: user?.uid
        });
    }, [isHost, roomId, user, micRestricted, handRaiseStatus]);

    // 7. Close/Leave Room
    const leaveRoom = useCallback(async () => {
        if (isHost && roomId) {
            const db = getAppFirestore();
            const roomRef = doc(db, "rooms", roomId);
            await setDoc(roomRef, { status: 'closed' }, { merge: true });
        }
        stopWebRTC();
        cleanup();
    }, [isHost, roomId, cleanup, stopWebRTC]);

    useEffect(() => {
        return () => cleanup();
    }, [cleanup]);

    return {
        roomId,
        isHost,
        roomStatus,
        micRestricted,
        handRaiseStatus,
        pendingHandRaises,
        localStream,
        remoteStreams,
        isVideoOn,
        createRoom,
        joinRoom,
        broadcastMessage,
        leaveRoom,
        toggleMicRestriction,
        raiseHand,
        lowerHand,
        approveHandRaise,
        denyHandRaise,
        startWebRTC,
        stopWebRTC
    };
}
