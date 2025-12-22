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
    where
} from 'firebase/firestore';
import { ConversationItem, Language } from '../types';

interface RoomData {
    id: string;
    hostUid: string;
    createdAt: any;
    status: 'active' | 'closed';
}

interface UseLiveSharingProps {
    user: any;
    onMessageReceived: (text: string, langCode: string) => void;
}

export function useLiveSharing({ user, onMessageReceived }: UseLiveSharingProps) {
    const [roomId, setRoomId] = useState<string | null>(null);
    const [isHost, setIsHost] = useState(false);
    const [roomStatus, setRoomStatus] = useState<'idle' | 'hosting' | 'joined'>('idle');
    const unsubscribeRef = useRef<(() => void) | null>(null);
    const lastMessageTimeRef = useRef<number>(0);

    const cleanup = useCallback(() => {
        if (unsubscribeRef.current) {
            unsubscribeRef.current();
            unsubscribeRef.current = null;
        }
        setRoomId(null);
        setIsHost(false);
        setRoomStatus('idle');
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
            status: 'active'
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
    }, [cleanup, onMessageReceived]);

    // 3. Broadcast Message (Host)
    const broadcastMessage = useCallback(async (text: string, langCode: string) => {
        if (!isHost || !roomId) return;
        const db = getAppFirestore();
        const msgsRef = collection(db, "rooms", roomId, "messages");
        await addDoc(msgsRef, {
            text,
            langCode,
            timestamp: Timestamp.now(),
            senderUid: user?.uid
        });
    }, [isHost, roomId, user]);

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
        createRoom,
        joinRoom,
        broadcastMessage,
        leaveRoom
    };
}
