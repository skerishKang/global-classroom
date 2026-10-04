import type { Firestore } from 'firebase/firestore';
import { doc, runTransaction } from 'firebase/firestore';

export type Unsubscribe = () => void;

/** Maximum number of room-code candidates tried before failing loudly. */
export const MAX_ROOM_CODE_ATTEMPTS = 10;

/** 6-digit room code (100000 ~ 999999), matching the existing room UX. */
export function generateRoomCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

export interface RoomCodeAllocationOptions {
    /** Bounded retry budget. Defaults to MAX_ROOM_CODE_ATTEMPTS. Never unbounded. */
    maxAttempts?: number;
    /** Candidate generator override (tests / deterministic allocation). */
    generateCode?: () => string;
}

/**
 * Atomically claim a free 6-digit room code.
 *
 * Each candidate is checked with a Firestore transaction so an existing room
 * document (active or otherwise) is NEVER overwritten, even under concurrent
 * creates. On collision another candidate is generated, up to a bounded
 * number of attempts; exhaustion throws a clear error instead of looping
 * forever.
 */
export async function createRoomWithUniqueCode(
    db: Firestore,
    buildRoomData: (roomId: string) => Record<string, unknown>,
    options: RoomCodeAllocationOptions = {}
): Promise<string> {
    const maxAttempts = options.maxAttempts ?? MAX_ROOM_CODE_ATTEMPTS;
    const generateCode = options.generateCode ?? generateRoomCode;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const candidate = generateCode();
        const roomRef = doc(db, 'rooms', candidate);

        const created = await runTransaction(db, async (transaction) => {
            const existing = await transaction.get(roomRef);
            if (existing.exists()) {
                // Collision: leave the existing room document untouched.
                return false;
            }
            transaction.set(roomRef, buildRoomData(candidate));
            return true;
        });

        if (created) {
            return candidate;
        }
    }

    throw new Error(
        `사용 가능한 방 코드 생성에 실패했습니다. 잠시 후 다시 시도해주세요. (최대 ${maxAttempts}회 시도)`
    );
}

/**
 * Owns every Firestore unsubscribe handle created by the live-sharing session.
 *
 * - room: listeners tied to the joined room (room doc, messages, hand raises)
 * - webrtc: the host's webRTC collection listener (disposed on stopWebRTC)
 * - peer: per-peer signaling listeners (disposed when that peer goes away)
 *
 * Every wrapped unsubscribe is idempotent, so dispose calls can never
 * double-fire an underlying Firestore unsubscribe.
 */
export class ListenerTracker {
    private roomListeners = new Set<Unsubscribe>();
    private webRtcListeners = new Set<Unsubscribe>();
    private peerListeners = new Map<string, Set<Unsubscribe>>();

    private track(set: Set<Unsubscribe>, unsubscribe: Unsubscribe): Unsubscribe {
        const wrapped: Unsubscribe = () => {
            if (!set.delete(wrapped)) return;
            unsubscribe();
        };
        set.add(wrapped);
        return wrapped;
    }

    trackRoom(unsubscribe: Unsubscribe): Unsubscribe {
        return this.track(this.roomListeners, unsubscribe);
    }

    trackWebRtc(unsubscribe: Unsubscribe): Unsubscribe {
        return this.track(this.webRtcListeners, unsubscribe);
    }

    trackPeer(peerId: string, unsubscribe: Unsubscribe): Unsubscribe {
        let set = this.peerListeners.get(peerId);
        if (!set) {
            set = new Set<Unsubscribe>();
            this.peerListeners.set(peerId, set);
        }
        return this.track(set, unsubscribe);
    }

    disposeWebRtc(): void {
        [...this.webRtcListeners].forEach(unsubscribe => unsubscribe());
    }

    disposePeer(peerId: string): void {
        const set = this.peerListeners.get(peerId);
        if (!set) return;
        [...set].forEach(unsubscribe => unsubscribe());
        this.peerListeners.delete(peerId);
    }

    disposePeers(): void {
        [...this.peerListeners.keys()].forEach(peerId => this.disposePeer(peerId));
    }

    disposeAll(): void {
        [...this.roomListeners].forEach(unsubscribe => unsubscribe());
        this.disposeWebRtc();
        this.disposePeers();
    }

    get roomListenerCount(): number {
        return this.roomListeners.size;
    }

    get webRtcListenerCount(): number {
        return this.webRtcListeners.size;
    }

    peerListenerCount(peerId?: string): number {
        if (peerId !== undefined) {
            return this.peerListeners.get(peerId)?.size ?? 0;
        }
        let total = 0;
        this.peerListeners.forEach(set => {
            total += set.size;
        });
        return total;
    }

    get totalListenerCount(): number {
        return this.roomListenerCount + this.webRtcListenerCount + this.peerListenerCount();
    }
}
