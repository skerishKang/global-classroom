import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useConversationHistory } from '../../hooks/useConversationHistory';
import { MAX_LOCAL_SESSIONS } from '../../utils/localStorage';
import { ConversationSession } from '../../types';

/**
 * Issue #39 — behavior tests for useConversationHistory: bounded retention
 * in React state + storage, and save failures surfaced to the caller
 * (the app turns this into a toast) without flooding.
 *
 * The repo has no jsdom/@testing-library, so the hook runs on a minimal
 * React dispatcher that reproduces effect cleanup/deps semantics.
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
            get current(): T {
                if (current === undefined) throw new Error('renderer has not mounted yet');
                return current;
            },
        };
    };

    return { useState, useRef, useCallback, useMemo, useEffect, createRenderer, reset };
});

vi.mock('react', () => ({
    useState: reactRuntime.useState,
    useRef: reactRuntime.useRef,
    useCallback: reactRuntime.useCallback,
    useMemo: reactRuntime.useMemo,
    useEffect: reactRuntime.useEffect,
}));

// --- in-memory localStorage double ------------------------------------------

type FailMode = 'none' | 'generic' | 'quota';

const store = new Map<string, string>();
let failMode: FailMode = 'none';

const SESSIONS_KEY = 'global_classroom_sessions';

const installLocalStorage = () => {
    const storage = {
        getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
        setItem: (key: string, value: string) => {
            if (failMode === 'generic') throw new Error('write failed');
            if (failMode === 'quota') {
                throw Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError', code: 22 });
            }
            store.set(key, value);
        },
        removeItem: (key: string) => {
            store.delete(key);
        },
        clear: () => {
            store.clear();
        },
    };
    Object.defineProperty(globalThis, 'localStorage', {
        value: storage,
        configurable: true,
        writable: true,
    });
};

const makeSession = (id: string, createdAt: number, items: any[] = []): ConversationSession => ({
    id,
    createdAt,
    updatedAt: createdAt,
    items,
    title: `title-${id}`,
});

interface HistoryHarness {
    current: ReturnType<typeof useConversationHistory>;
    act: (fn: () => Promise<void> | void) => Promise<void>;
}

const renderHistory = (onSaveFailure?: (reason: 'quota' | 'unavailable' | 'unknown') => void): HistoryHarness => {
    reactRuntime.reset();
    const renderer = reactRuntime.createRenderer(() => useConversationHistory({ onSaveFailure }));
    renderer.render();
    return {
        get current() {
            return renderer.current;
        },
        act: async (fn: () => Promise<void> | void) => {
            await fn();
            renderer.flush();
        },
    };
};

beforeEach(() => {
    store.clear();
    failMode = 'none';
    installLocalStorage();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('#39 useConversationHistory retention + save surface', () => {
    test('mount persists the initial session (normal save path)', () => {
        const h = renderHistory();

        const raw = store.get(SESSIONS_KEY);
        expect(raw).toBeDefined();
        const persisted = JSON.parse(raw as string);
        expect(persisted).toHaveLength(1);
        expect(h.current.sessions).toHaveLength(1);
        expect(h.current.currentSessionId).toBe(persisted[0].id);
        expect(h.current.isSessionsReady).toBe(true);
    });

    test('state over MAX is pruned to MAX in React state and storage; active preserved', async () => {
        const onSaveFailure = vi.fn();
        const h = renderHistory(onSaveFailure);

        const count = MAX_LOCAL_SESSIONS + 7;
        const big = Array.from({ length: count }, (_, i) => makeSession(`s${i}`, 200_000 - i));
        const activeId = `s${Math.floor(count / 2)}`;

        await h.act(async () => {
            h.current.setCurrentSessionId(activeId);
            h.current.setSessions(big);
        });

        // React state is bounded…
        expect(h.current.sessions).toHaveLength(MAX_LOCAL_SESSIONS);
        expect(h.current.sessions.some(s => s.id === activeId)).toBe(true);
        // …and so is what actually got written.
        const persisted = JSON.parse(store.get(SESSIONS_KEY) as string);
        expect(persisted).toHaveLength(MAX_LOCAL_SESSIONS);
        expect(persisted.some((s: any) => s.id === activeId)).toBe(true);
        expect(persisted.some((s: any) => s.id === `s${count - 1}`)).toBe(false); // oldest pruned
        expect(persisted.some((s: any) => s.id === 's0')).toBe(true); // newest kept
        // Storage worked — no failure surfaced.
        expect(onSaveFailure).not.toHaveBeenCalled();
    });

    test('8./9. write failure surfaces once; repeated failing updates do not flood', async () => {
        failMode = 'quota';
        const onSaveFailure = vi.fn();
        const h = renderHistory(onSaveFailure);

        // The mount-time save already fails → surfaced immediately.
        expect(onSaveFailure).toHaveBeenCalledTimes(1);
        expect(onSaveFailure).toHaveBeenCalledWith('quota');

        // Every following state update also fails to persist…
        await h.act(async () => {
            h.current.handleNewConversation();
        });
        expect(onSaveFailure).toHaveBeenCalledTimes(1); // …but the user is not spammed.

        await h.act(async () => {
            h.current.handleNewConversation();
        });
        expect(onSaveFailure).toHaveBeenCalledTimes(1);

        // The app state still works; only persistence failed.
        expect(h.current.sessions).toHaveLength(3);
    });

    test('unknown failures are surfaced with their reason', () => {
        failMode = 'generic';
        const onSaveFailure = vi.fn();
        renderHistory(onSaveFailure);

        expect(onSaveFailure).toHaveBeenCalledTimes(1);
        expect(onSaveFailure).toHaveBeenCalledWith('unknown');
    });

    test('successful saves after a failure do not notify', async () => {
        failMode = 'quota';
        const onSaveFailure = vi.fn();
        const h = renderHistory(onSaveFailure);
        expect(onSaveFailure).toHaveBeenCalledTimes(1);

        failMode = 'none'; // storage recovers (e.g. retention freed space)
        await h.act(async () => {
            h.current.handleNewConversation();
        });

        expect(onSaveFailure).toHaveBeenCalledTimes(1);
        expect(JSON.parse(store.get(SESSIONS_KEY) as string)).toHaveLength(2);
    });
});

