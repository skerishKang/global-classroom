import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useLiveSharing } from '../../hooks/useLiveSharing';
import { createRoomWithUniqueCode, MAX_ROOM_CODE_ATTEMPTS } from '../../utils/liveSharingRoom';

/**
 * Issue #33 regression tests.
 *
 * Covers: room lifecycle stability across startWebRTC, Firestore listener
 * ownership/disposal, leave/rejoin callback isolation, and bounded atomic
 * room-code allocation.
 *
 * The repo ships without jsdom/@testing-library, so the hook runs against a
 * minimal React dispatcher that reproduces the exact semantics this issue is
 * about: an effect re-runs its previous cleanup whenever a dependency
 * changes identity (the root cause of WEBRTC_START_RESETS_ROOM).
 */
const reactRuntime = vi.hoisted(() => {
    interface EffectSlot {
        deps: unknown[] | undefined;
        cleanup: (() => void) | undefined;
        mounted: boolean;
    }

    let hookIndex = 0;
    let stateSlots: unknown[] = [];
    let refSlots: Array<{ current: unknown } | undefined> = [];
    let callbackSlots: Array<{ value: unknown; deps: unknown[] | undefined } | undefined> = [];
    let memoSlots: Array<{ value: unknown; deps: unknown[] | undefined } | undefined> = [];
    let effectSlots: Array<EffectSlot | undefined> = [];
    let dirty = false;
    let pendingEffects: Array<() => void> = [];

    const depsChanged = (prev: unknown[] | undefined, next: unknown[] | undefined): boolean => {
        if (prev === undefined || next === undefined) return true;
        if (prev.length !== next.length) return true;
        return prev.some((value, index) => !Object.is(value, next[index]));
    };

    const useState = <T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] => {
        const index = hookIndex++;
        if (!(index in stateSlots)) {
            stateSlots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
        }
        const setState = (next: T | ((prev: T) => T)): void => {
            const prev = stateSlots[index] as T;
            const value = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
            if (!Object.is(prev, value)) {
                stateSlots[index] = value;
                dirty = true;
            }
        };
        return [stateSlots[index] as T, setState];
    };

    const useRef = <T>(initial: T): { current: T } => {
        const index = hookIndex++;
        if (!(index in refSlots)) {
            refSlots[index] = { current: initial };
        }
        return refSlots[index] as { current: T };
    };

    const useCallback = <T>(factory: T, deps: unknown[] | undefined): T => {
        const index = hookIndex++;
        const slot = callbackSlots[index];
        if (!slot || depsChanged(slot.deps, deps)) {
            callbackSlots[index] = { value: factory, deps };
        }
        return callbackSlots[index]!.value as T;
    };

    const useMemo = <T>(factory: () => T, deps: unknown[] | undefined): T => {
        const index = hookIndex++;
        const slot = memoSlots[index];
        if (!slot || depsChanged(slot.deps, deps)) {
            memoSlots[index] = { value: factory(), deps };
        }
        return memoSlots[index]!.value as T;
    };

    const useEffect = (effect: () => void | (() => void), deps?: unknown[]): void => {
        const index = hookIndex++;
        let slot = effectSlots[index];
        if (!slot) {
            slot = { deps: undefined, cleanup: undefined, mounted: false };
            effectSlots[index] = slot;
        }
        const currentSlot = slot;
        const changed = !currentSlot.mounted || depsChanged(currentSlot.deps, deps);
        currentSlot.deps = deps;
        if (changed) {
            pendingEffects.push(() => {
                if (currentSlot.cleanup) currentSlot.cleanup();
                const result = effect();
                currentSlot.cleanup = typeof result === 'function' ? result : undefined;
                currentSlot.mounted = true;
            });
        }
    };

    const renderOnce = (component: () => unknown): unknown => {
        hookIndex = 0;
        return component();
    };

    const flush = (component: () => unknown): void => {
        let guard = 0;
        while (dirty || pendingEffects.length > 0) {
            guard += 1;
            if (guard > 200) throw new Error('render loop did not settle');
            if (dirty) {
                dirty = false;
                renderOnce(component);
            }
            const runs = pendingEffects;
            pendingEffects = [];
            runs.forEach(run => run());
        }
    };

    const runUnmount = (): void => {
        pendingEffects = [];
        effectSlots.forEach(slot => {
            if (!slot) return;
            if (slot.mounted && slot.cleanup) slot.cleanup();
            slot.mounted = false;
            slot.cleanup = undefined;
        });
    };

    const reset = (): void => {
        hookIndex = 0;
        stateSlots = [];
        refSlots = [];
        callbackSlots = [];
        memoSlots = [];
        effectSlots = [];
        dirty = false;
        pendingEffects = [];
    };

    const createRenderer = <T>(component: () => T) => {
        let current: T | undefined;
        const wrapped = (): T => {
            current = component();
            return current;
        };
        return {
            render(): void {
                renderOnce(wrapped);
                flush(wrapped);
            },
            flush(): void {
                flush(wrapped);
            },
            unmount(): void {
                runUnmount();
            },
            get current(): T {
                if (current === undefined) throw new Error('renderer has not mounted yet');
                return current;
            },
        };
    };

    return { useState, useRef, useCallback, useMemo, useEffect, createRenderer, reset };
});

/**
 * In-memory Firestore double with listener bookkeeping, so tests can assert
 * "onSnapshot creations == disposals" and detect leaked/stale listeners.
 */
const firestore = vi.hoisted(() => {
    type DocData = Record<string, any>;

    interface Listener {
        kind: 'doc' | 'col';
        path: string;
        cb: (snapshot: any) => void;
        active: boolean;
        invocations: number;
        seen: Map<string, DocData>;
    }

    const db = { kind: 'db' };
    const docs = new Map<string, DocData>();
    const listeners: Listener[] = [];
    const stats = { created: 0, unsubscribed: 0, transactions: 0 };
    let docSeq = 0;
    let clock = 0;

    const depthOf = (path: string): number => path.split('/').filter(Boolean).length;

    const docSnapshot = (path: string) => {
        const data = docs.get(path);
        return {
            id: path.split('/').filter(Boolean).pop(),
            exists: () => data !== undefined,
            data: () => data,
        };
    };

    const childrenOf = (colPath: string): Map<string, DocData> => {
        const result = new Map<string, DocData>();
        const prefix = `${colPath}/`;
        const targetDepth = depthOf(colPath) + 1;
        docs.forEach((data, key) => {
            if (key.startsWith(prefix) && depthOf(key) === targetDepth) {
                result.set(key.slice(prefix.length), data);
            }
        });
        return result;
    };

    const collectionSnapshot = (listener: Listener, changes: any[]) => {
        const children = childrenOf(listener.path);
        const docSnaps = [...children.entries()].map(([id, data]) => ({
            id,
            exists: () => true,
            data: () => data,
        }));
        return {
            id: listener.path,
            empty: children.size === 0,
            size: children.size,
            docs: docSnaps,
            forEach: (fn: (snap: any) => void) => docSnaps.forEach(fn),
            docChanges: () => changes,
        };
    };

    const notify = (writePath: string): void => {
        [...listeners].forEach(listener => {
            if (!listener.active) return;
            if (listener.kind === 'doc') {
                // A document listener only fires for writes to that exact document.
                if (writePath !== listener.path) return;
                listener.invocations += 1;
                listener.cb(docSnapshot(listener.path));
                return;
            }
            // A collection/query listener only sees its direct children.
            const matches = writePath === listener.path
                || (writePath.startsWith(`${listener.path}/`) && depthOf(writePath) === depthOf(listener.path) + 1);
            if (!matches) return;

            const children = childrenOf(listener.path);
            const changes: any[] = [];
            children.forEach((data, id) => {
                const prev = listener.seen.get(id);
                if (prev === undefined) {
                    changes.push({ type: 'added', doc: { id, exists: () => true, data: () => data } });
                } else if (prev !== data) {
                    changes.push({ type: 'modified', doc: { id, exists: () => true, data: () => data } });
                }
            });
            listener.seen.forEach((data, id) => {
                if (!children.has(id)) {
                    changes.push({ type: 'removed', doc: { id, exists: () => false, data: () => data } });
                }
            });
            listener.seen = new Map(children);
            if (changes.length === 0) return;
            listener.invocations += 1;
            listener.cb(collectionSnapshot(listener, changes));
        });
    };

    const setPath = (path: string, data: DocData, merge: boolean): void => {
        const existing = docs.get(path);
        docs.set(path, merge && existing ? { ...existing, ...data } : { ...data });
        notify(path);
    };

    const resolvePath = (target: any, rest: string[]): string => {
        if (target && target.kind === 'db') return rest.join('/');
        if (target && typeof target.path === 'string') return [target.path, ...rest].join('/');
        return rest.join('/');
    };

    const doc = (...args: any[]): any => ({ kind: 'doc', path: resolvePath(args[0], args.slice(1)) });
    const collection = (...args: any[]): any => ({ kind: 'col', path: resolvePath(args[0], args.slice(1)) });
    const query = (ref: any, ..._constraints: any[]): any => ({
        kind: ref.kind === 'doc' ? 'doc' : 'col',
        path: ref.path,
    });
    const orderBy = (_field: string, _direction?: string): any => ({ type: 'orderBy' });
    const where = (_field: string, _operator: string, _value: any): any => ({ type: 'where' });
    const limit = (_count: number): any => ({ type: 'limit' });
    const collectionGroup = (_id: string): any => ({ kind: 'col', path: '__collectionGroup__' });
    const serverTimestamp = (): null => null;

    const onSnapshot = (ref: any, cb: (snapshot: any) => void) => {
        const listener: Listener = {
            kind: ref.kind === 'doc' ? 'doc' : 'col',
            path: ref.path,
            cb,
            active: true,
            invocations: 0,
            seen: new Map(),
        };
        listeners.push(listener);
        stats.created += 1;

        // Firestore always delivers an initial snapshot.
        if (listener.kind === 'doc') {
            listener.invocations += 1;
            cb(docSnapshot(listener.path));
        } else {
            const children = childrenOf(listener.path);
            listener.seen = new Map(children);
            const changes = [...children.entries()].map(([id, data]) => ({
                type: 'added',
                doc: { id, exists: () => true, data: () => data },
            }));
            listener.invocations += 1;
            cb(collectionSnapshot(listener, changes));
        }

        return () => {
            if (!listener.active) return;
            listener.active = false;
            stats.unsubscribed += 1;
        };
    };

    const setDoc = (ref: any, data: DocData, options?: { merge?: boolean }) => {
        setPath(ref.path, data, !!options?.merge);
        return Promise.resolve();
    };
    const updateDoc = (ref: any, data: DocData) => {
        setPath(ref.path, data, true);
        return Promise.resolve();
    };
    const deleteDoc = (ref: any) => {
        docs.delete(ref.path);
        notify(ref.path);
        return Promise.resolve();
    };
    const getDoc = (ref: any) => Promise.resolve(docSnapshot(ref.path));
    const addDoc = (ref: any, data: DocData) => {
        docSeq += 1;
        const id = `auto_${docSeq}`;
        docs.set(`${ref.path}/${id}`, { ...data });
        notify(ref.path);
        return Promise.resolve({ id, path: `${ref.path}/${id}` });
    };

    const Timestamp = {
        now: () => {
            clock = Math.max(Date.now(), clock + 5);
            const value = clock;
            return {
                toMillis: () => value,
                seconds: Math.floor(value / 1000),
                nanoseconds: 0,
            };
        },
    };

    const runTransaction = async (_db: any, update: (transaction: any) => Promise<any>): Promise<any> => {
        stats.transactions += 1;
        const writes: Array<{ path: string; data: DocData }> = [];
        const transaction = {
            get: (ref: any) => Promise.resolve(docSnapshot(ref.path)),
            set: (ref: any, data: DocData) => {
                writes.push({ path: ref.path, data });
            },
        };
        const result = await update(transaction);
        // Commit atomically: all reads happened before any write.
        writes.forEach(write => docs.set(write.path, { ...write.data }));
        writes.forEach(write => notify(write.path));
        return result;
    };

    const api = {
        collection,
        doc,
        query,
        orderBy,
        where,
        limit,
        addDoc,
        setDoc,
        updateDoc,
        deleteDoc,
        getDoc,
        onSnapshot,
        runTransaction,
        Timestamp,
        serverTimestamp,
        collectionGroup,
    };

    return {
        db,
        api,
        stats,
        reset(): void {
            docs.clear();
            listeners.length = 0;
            stats.created = 0;
            stats.unsubscribed = 0;
            stats.transactions = 0;
            docSeq = 0;
            clock = 0;
        },
        seed(path: string, data: DocData): void {
            docs.set(path, { ...data });
        },
        write(path: string, data: DocData, merge = false): void {
            setPath(path, data, merge);
        },
        read(path: string): DocData | undefined {
            return docs.get(path);
        },
        activeListeners(): Listener[] {
            return listeners.filter(listener => listener.active);
        },
        timestampNow() {
            return Timestamp.now();
        },
    };
});

// --- WebRTC / media doubles -------------------------------------------------

interface FakeTrack {
    kind: string;
    stopped: boolean;
    stop: () => void;
}

const createdTracks: FakeTrack[] = [];

const makeTrack = (kind: string): FakeTrack => {
    const track: FakeTrack = { kind, stopped: false, stop: () => undefined };
    track.stop = () => {
        track.stopped = true;
    };
    return track;
};

const makeStream = () => {
    const tracks = [makeTrack('video'), makeTrack('audio')];
    tracks.forEach(track => createdTracks.push(track));
    return { getTracks: () => tracks };
};

class FakeRTCPeerConnection {
    static instances: FakeRTCPeerConnection[] = [];
    onicecandidate: ((event: any) => void) | null = null;
    ontrack: ((event: any) => void) | null = null;
    currentRemoteDescription: any = null;
    localDescription: any = null;
    closed = false;
    addedTracks: any[] = [];

    constructor(_config?: any) {
        FakeRTCPeerConnection.instances.push(this);
    }

    addTrack(track: any, _stream?: any) {
        this.addedTracks.push(track);
        return { track };
    }

    async createOffer() {
        return { type: 'offer', sdp: 'v=0\r\nfake-offer' };
    }

    async createAnswer() {
        return { type: 'answer', sdp: 'v=0\r\nfake-answer' };
    }

    async setLocalDescription(description: any) {
        this.localDescription = description;
    }

    async setRemoteDescription(description: any) {
        this.currentRemoteDescription = description;
    }

    async addIceCandidate(_candidate: any) {
        // no-op
    }

    close() {
        this.closed = true;
    }
}

const installGlobals = (): void => {
    (globalThis as any).RTCPeerConnection = FakeRTCPeerConnection;
    (globalThis as any).RTCSessionDescription = class {
        init: any;
        constructor(init: any) {
            this.init = init;
            Object.assign(this, init);
        }
    };
    (globalThis as any).RTCIceCandidate = class {
        init: any;
        constructor(init: any) {
            this.init = init;
            Object.assign(this, init);
        }
    };

    const navigatorValue = {
        mediaDevices: {
            getUserMedia: async (_constraints: any) => makeStream(),
        },
    };
    try {
        Object.defineProperty(globalThis, 'navigator', {
            value: navigatorValue,
            configurable: true,
            writable: true,
        });
    } catch {
        try {
            (globalThis as any).navigator = navigatorValue;
        } catch {
            Object.defineProperty((globalThis as any).navigator, 'mediaDevices', {
                value: navigatorValue.mediaDevices,
                configurable: true,
            });
        }
    }
};

// --- module mocks -------------------------------------------------------------

vi.mock('react', () => ({
    useState: reactRuntime.useState,
    useRef: reactRuntime.useRef,
    useCallback: reactRuntime.useCallback,
    useMemo: reactRuntime.useMemo,
    useEffect: reactRuntime.useEffect,
}));

vi.mock('firebase/firestore', () => firestore.api);

vi.mock('../../utils/firebase', () => ({
    getAppFirestore: () => firestore.db,
}));

// --- harness ------------------------------------------------------------------

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface LiveSharingHarness {
    current: ReturnType<typeof useLiveSharing>;
    onMessageReceived: ReturnType<typeof vi.fn>;
    act: (fn: () => Promise<void> | void) => Promise<void>;
    unmount: () => void;
}

const renderLiveSharing = (user: any, onMessageReceived = vi.fn()): LiveSharingHarness => {
    reactRuntime.reset();
    const renderer = reactRuntime.createRenderer(() => useLiveSharing({ user, onMessageReceived }));
    renderer.render();
    return {
        get current() {
            return renderer.current;
        },
        onMessageReceived,
        act: async (fn: () => Promise<void> | void) => {
            await fn();
            renderer.flush();
        },
        unmount: () => renderer.unmount(),
    };
};

beforeEach(() => {
    firestore.reset();
    FakeRTCPeerConnection.instances.length = 0;
    createdTracks.length = 0;
    installGlobals();
});

afterEach(() => {
    vi.restoreAllMocks();
});

// --- #33 regression tests -----------------------------------------------------

describe('#33 host WebRTC lifecycle', () => {
    test('startWebRTC does not reset roomId/isHost/roomStatus', async () => {
        const h = renderLiveSharing({ uid: 'host-1', displayName: 'Host' });

        let created: string | null = null;
        await h.act(async () => {
            created = await h.current.createRoom();
        });

        expect(created).toMatch(/^\d{6}$/);
        expect(h.current.roomId).toBe(created);
        expect(h.current.isHost).toBe(true);
        expect(h.current.roomStatus).toBe('hosting');
        expect(firestore.activeListeners().map(l => l.path)).toEqual([`rooms/${created}/handRaises`]);

        await h.act(async () => {
            await h.current.startWebRTC();
        });

        // WEBRTC_START_RESETS_ROOM=0: acquiring the camera must not reset the session.
        expect(h.current.roomId).toBe(created);
        expect(h.current.isHost).toBe(true);
        expect(h.current.roomStatus).toBe('hosting');
        expect(h.current.localStream).not.toBeNull();
        expect(h.current.isVideoOn).toBe(true);
        expect(createdTracks.some(track => track.stopped)).toBe(false);

        // Host owns its webrtc collection listener in addition to the hands listener.
        expect(firestore.activeListeners()).toHaveLength(2);
        expect(firestore.stats.unsubscribed).toBe(0);
    });

    test('host leave closes the room document (existing semantics kept)', async () => {
        const h = renderLiveSharing({ uid: 'host-1' });
        let created: string | null = null;
        await h.act(async () => {
            created = await h.current.createRoom();
        });
        await h.act(async () => {
            await h.current.startWebRTC();
        });
        await h.act(async () => {
            await h.current.leaveRoom();
        });

        expect(firestore.read(`rooms/${created}`)?.status).toBe('closed');
        expect(h.current.roomId).toBeNull();
        expect(h.current.roomStatus).toBe('idle');
        expect(h.current.isHost).toBe(false);
        expect(h.current.localStream).toBeNull();
        expect(firestore.activeListeners()).toHaveLength(0);
    });
});

describe('#33 student lifecycle', () => {
    test('startWebRTC keeps joined room state', async () => {
        firestore.seed('rooms/246810', {
            id: '246810',
            hostUid: 'host-1',
            status: 'active',
            micRestricted: false,
        });
        const h = renderLiveSharing({ uid: 'student-1', displayName: 'Student' });

        await h.act(async () => {
            await h.current.joinRoom('246810');
        });
        expect(h.current.roomId).toBe('246810');
        expect(h.current.isHost).toBe(false);
        expect(h.current.roomStatus).toBe('joined');
        // room doc + own handRaise + messages
        expect(firestore.activeListeners()).toHaveLength(3);

        await h.act(async () => {
            await h.current.startWebRTC();
        });

        expect(h.current.roomId).toBe('246810');
        expect(h.current.isHost).toBe(false);
        expect(h.current.roomStatus).toBe('joined');
        expect(h.current.localStream).not.toBeNull();
        expect(h.current.isVideoOn).toBe(true);
        // + signal doc listener + candidates listener for the HOST peer
        expect(firestore.activeListeners()).toHaveLength(5);
        expect(firestore.stats.unsubscribed).toBe(0);
    });
});

describe('#33 listener ownership', () => {
    test('host leave disposes every listener including per-peer ones', async () => {
        const h = renderLiveSharing({ uid: 'host-1' });
        let created: string | null = null;
        await h.act(async () => {
            created = await h.current.createRoom();
        });
        await h.act(async () => {
            await h.current.startWebRTC();
        });

        // A student registers in the signaling collection → host opens a peer.
        await h.act(async () => {
            firestore.write(`rooms/${created}/webRTC/student-1`, { uid: 'student-1' });
            await sleep(0);
        });

        // hands + webrtc collection + peer signal + peer candidates
        expect(firestore.stats.created).toBe(4);
        expect(firestore.activeListeners()).toHaveLength(4);
        expect(FakeRTCPeerConnection.instances).toHaveLength(1);

        await h.act(async () => {
            await h.current.leaveRoom();
        });

        expect(firestore.stats.unsubscribed).toBe(firestore.stats.created);
        expect(firestore.activeListeners()).toHaveLength(0);
        expect(FakeRTCPeerConnection.instances.every(pc => pc.closed)).toBe(true);
        expect(createdTracks.every(track => track.stopped)).toBe(true);
    });

    test('stopWebRTC/startWebRTC cycles never accumulate listeners', async () => {
        firestore.seed('rooms/135790', { id: '135790', hostUid: 'host-1', status: 'active' });
        const h = renderLiveSharing({ uid: 'student-2' });

        await h.act(async () => {
            await h.current.joinRoom('135790');
        });
        expect(firestore.activeListeners()).toHaveLength(3);

        await h.act(async () => {
            await h.current.startWebRTC();
        });
        expect(firestore.activeListeners()).toHaveLength(5);

        // stopWebRTC disposes WebRTC/peer listeners only; room listeners survive.
        await h.act(async () => {
            h.current.stopWebRTC();
        });
        expect(firestore.activeListeners()).toHaveLength(3);
        expect(h.current.roomStatus).toBe('joined');
        expect(h.current.roomId).toBe('135790');

        // restart → exactly 3 room + 2 peer listeners again (no stale duplicates)
        await h.act(async () => {
            await h.current.startWebRTC();
        });
        expect(firestore.activeListeners()).toHaveLength(5);

        await h.act(async () => {
            await h.current.leaveRoom();
        });
        expect(firestore.activeListeners()).toHaveLength(0);
        expect(firestore.stats.unsubscribed).toBe(firestore.stats.created);
    });

    test('student leave does not close the room document', async () => {
        firestore.seed('rooms/222200', { id: '222200', hostUid: 'host-1', status: 'active' });
        const h = renderLiveSharing({ uid: 'student-3' });

        await h.act(async () => {
            await h.current.joinRoom('222200');
        });
        await h.act(async () => {
            await h.current.leaveRoom();
        });

        expect(firestore.read('rooms/222200')?.status).toBe('active');
        expect(firestore.read('rooms/222200')?.hostUid).toBe('host-1');
        expect(h.current.roomStatus).toBe('idle');
    });

    test('unmount disposes all listeners', async () => {
        firestore.seed('rooms/333300', { id: '333300', hostUid: 'host-1', status: 'active' });
        const h = renderLiveSharing({ uid: 'student-4' });

        await h.act(async () => {
            await h.current.joinRoom('333300');
        });
        expect(firestore.activeListeners()).toHaveLength(3);

        h.unmount();

        expect(firestore.activeListeners()).toHaveLength(0);
        expect(firestore.stats.unsubscribed).toBe(firestore.stats.created);
    });
});

describe('#33 leave → rejoin isolation', () => {
    test('room A listeners are gone; room B callbacks fire exactly once', async () => {
        firestore.seed('rooms/411111', { id: '411111', hostUid: 'host-a', status: 'active' });
        firestore.seed('rooms/422222', { id: '422222', hostUid: 'host-b', status: 'active' });
        const onMessageReceived = vi.fn();
        const h = renderLiveSharing({ uid: 'student-9' }, onMessageReceived);

        await h.act(async () => {
            await h.current.joinRoom('411111');
        });
        expect(h.current.roomId).toBe('411111');

        await h.act(async () => {
            await h.current.leaveRoom();
        });
        expect(firestore.activeListeners()).toHaveLength(0);

        await h.act(async () => {
            await h.current.joinRoom('422222');
        });
        expect(h.current.roomId).toBe('422222');
        expect(h.current.roomStatus).toBe('joined');

        const activePaths = firestore.activeListeners().map(l => l.path);
        expect(activePaths).toHaveLength(3);
        expect(activePaths.every(p => p === 'rooms/422222' || p.startsWith('rooms/422222/'))).toBe(true);
        expect(activePaths.some(p => p === 'rooms/411111' || p.startsWith('rooms/411111/'))).toBe(false);

        // A write into the OLD room must reach nobody.
        firestore.write('rooms/411111/messages/m1', {
            text: 'stale',
            langCode: 'ko',
            timestamp: firestore.timestampNow(),
        });
        expect(onMessageReceived).not.toHaveBeenCalled();
        expect(h.current.roomId).toBe('422222');

        // A write into the CURRENT room fires exactly one listener callback.
        const messageListener = firestore.activeListeners().find(l => l.path === 'rooms/422222/messages');
        expect(messageListener).toBeDefined();
        const invocationsBefore = messageListener!.invocations;
        await sleep(10);
        firestore.write('rooms/422222/messages/m2', {
            text: 'fresh',
            langCode: 'ko',
            timestamp: firestore.timestampNow(),
        });
        expect(messageListener!.invocations).toBe(invocationsBefore + 1);
        expect(onMessageReceived).toHaveBeenCalledTimes(1);
        expect(onMessageReceived).toHaveBeenCalledWith('fresh', 'ko');
    });
});

describe('#33 room code collision', () => {
    test('existing room is never overwritten; the next candidate is used', async () => {
        firestore.seed('rooms/111111', {
            id: '111111',
            hostUid: 'other-host',
            status: 'active',
            createdAt: 'original',
        });

        const candidates = ['111111', '222222'];
        const roomId = await createRoomWithUniqueCode(
            firestore.db as any,
            code => ({ id: code, hostUid: 'me', status: 'active' }),
            { generateCode: () => candidates.shift()! }
        );

        expect(roomId).toBe('222222');
        expect(firestore.read('rooms/111111')).toEqual({
            id: '111111',
            hostUid: 'other-host',
            status: 'active',
            createdAt: 'original',
        });
        expect(firestore.read('rooms/222222')).toEqual({ id: '222222', hostUid: 'me', status: 'active' });
        expect(firestore.stats.transactions).toBe(2);
    });

    test('hook createRoom skips a colliding active room', async () => {
        firestore.seed('rooms/550000', { id: '550000', hostUid: 'other-host', status: 'active' });
        // Math.random 0.5 → floor(100000 + 0.5 * 900000) = 550000 (collision first)
        const randomSpy = vi.spyOn(Math, 'random')
            .mockReturnValueOnce(0.5)
            .mockReturnValue(0.123456789);

        const h = renderLiveSharing({ uid: 'host-7' });
        let created: string | null = null;
        await h.act(async () => {
            created = await h.current.createRoom();
        });
        randomSpy.mockRestore();

        expect(created).not.toBe('550000');
        expect(created).toMatch(/^\d{6}$/);
        expect(firestore.read('rooms/550000')).toEqual({
            id: '550000',
            hostUid: 'other-host',
            status: 'active',
        });
        expect(firestore.read(`rooms/${created}`)?.hostUid).toBe('host-7');
        expect(h.current.roomStatus).toBe('hosting');
        expect(h.current.roomId).toBe(created);
        expect(firestore.stats.transactions).toBe(2);
    });

    test('bounded retry: clear error at MAX attempts, never an infinite loop', async () => {
        firestore.seed('rooms/999999', { id: '999999', hostUid: 'other-host', status: 'active' });

        await expect(
            createRoomWithUniqueCode(
                firestore.db as any,
                code => ({ id: code, hostUid: 'me', status: 'active' }),
                { generateCode: () => '999999' }
            )
        ).rejects.toThrow(`최대 ${MAX_ROOM_CODE_ATTEMPTS}회 시도`);

        expect(firestore.stats.transactions).toBe(MAX_ROOM_CODE_ATTEMPTS);
        expect(firestore.read('rooms/999999')).toEqual({
            id: '999999',
            hostUid: 'other-host',
            status: 'active',
        });
    });

    test('hook createRoom surfaces the bounded failure to the caller', async () => {
        firestore.seed('rooms/550000', { id: '550000', hostUid: 'other-host', status: 'active' });
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5); // always 550000 → always collides

        const h = renderLiveSharing({ uid: 'host-8' });
        await expect(
            h.act(async () => {
                await h.current.createRoom();
            })
        ).rejects.toThrow(/방 코드/);
        randomSpy.mockRestore();

        expect(firestore.stats.transactions).toBe(MAX_ROOM_CODE_ATTEMPTS);
        expect(firestore.read('rooms/550000')?.hostUid).toBe('other-host');
        expect(h.current.roomStatus).toBe('idle');
        expect(h.current.roomId).toBeNull();
        expect(firestore.activeListeners()).toHaveLength(0);
    });
});








