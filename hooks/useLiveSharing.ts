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
    deleteDoc
} from 'firebase/firestore';
import { ConversationItem, Language } from '../types';
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

    const unsubscribeRef = useRef<(() => void) | null>(null);
    const roomUnsubscribeRef = useRef<(() => void) | null>(null);
    const handsUnsubscribeRef = useRef<(() => void) | null>(null);
    const lastMessageTimeRef = useRef<number>(0);

    const cleanup = useCallback(() => {
        if (unsubscribeRef.current) unsubscribeRef.current();
        if (roomUnsubscribeRef.current) roomUnsubscribeRef.current();
        if (handsUnsubscribeRef.current) handsUnsubscribeRef.current();

        unsubscribeRef.current = null;
        roomUnsubscribeRef.current = null;
        handsUnsubscribeRef.current = null;

        setRoomId(null);
        setIsHost(false);
        setRoomStatus('idle');
        setMicRestricted(false);
        setHandRaiseStatus('idle');
        setPendingHandRaises([]);
    }, []);

    // 1. Create a Room (Host)
    const createRoom = useCallback(async () => {
        if (!user?.uid) return null;
        cleanup();

        const db = getAppFirestore();
        const newRoomId = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit code
        const roomRef = doc(db, "rooms", newRoomId);

        await setDoc(roomRef, {
            id: newRoomId,
            hostUid: user.uid,
            createdAt: Timestamp.now(),
            status: 'active',
            micRestricted: false
        });

        // Listen for hand raises (Host side)
        const handsRef = collection(db, "rooms", newRoomId, "handRaises");
        const qHands = query(handsRef, orderBy("timestamp", "asc"));
        handsUnsubscribeRef.current = onSnapshot(qHands, (snapshot) => {
            const list: HandRaiseData[] = [];
            snapshot.forEach(doc => {
                const data = doc.data() as HandRaiseData;
                if (data.status === 'pending') {
                    list.push(data);
                }
            });
            setPendingHandRaises(list);
        });

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
        roomUnsubscribeRef.current = onSnapshot(roomRef, (doc) => {
            if (doc.exists()) {
                const data = doc.data() as RoomData;
                setMicRestricted(!!data.micRestricted);
            }
        });

        // Listen for own hand raise status
        if (user?.uid) {
            const handRef = doc(db, "rooms", targetRoomId, "handRaises", user.uid);
            onSnapshot(handRef, (doc) => {
                if (doc.exists()) {
                    setHandRaiseStatus(doc.data().status);
                } else {
                    setHandRaiseStatus('idle');
                }
            });
        }

        // Listen for new messages
        const msgsRef = collection(db, "rooms", targetRoomId, "messages");
        const q = query(msgsRef, orderBy("timestamp", "asc"));

        unsubscribeRef.current = onSnapshot(q, (snapshot) => {
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
        });

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

    // 4. Broadcast Message
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

    // 4. Close/Leave Room
    const leaveRoom = useCallback(async () => {
        if (isHost && roomId) {
            const db = getAppFirestore();
            const roomRef = doc(db, "rooms", roomId);
            await setDoc(roomRef, { status: 'closed' }, { merge: true });
        }
        cleanup();
    }, [isHost, roomId, cleanup]);

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
        createRoom,
        joinRoom,
        broadcastMessage,
        leaveRoom,
        toggleMicRestriction,
        raiseHand,
        lowerHand,
        approveHandRaise,
        denyHandRaise
    };
}
