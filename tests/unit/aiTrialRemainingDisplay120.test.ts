import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
    TRIAL_DEVICE_LIMIT,
    bumpTrialCount,
    rememberTrialRemaining,
    setClassApiKey,
    trialRemaining,
} from '../../utils/apiKey';

class MemoryStorage implements Storage {
    private store = new Map<string, string>();
    get length(): number { return this.store.size; }
    clear(): void { this.store.clear(); }
    getItem(key: string): string | null {
        return this.store.has(key) ? this.store.get(key)! : null;
    }
    key(index: number): string | null {
        return [...this.store.keys()][index] ?? null;
    }
    removeItem(key: string): void { this.store.delete(key); }
    setItem(key: string, value: string): void { this.store.set(key, String(value)); }
}

let storage: MemoryStorage;

const headers = (value: string | null) => ({
    get: (name: string) => (name === 'x-trial-remaining' ? value : null),
});

beforeEach(() => {
    storage = new MemoryStorage();
    (globalThis as Record<string, unknown>).localStorage = storage;
});

afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
});

describe('#120 remaining trial count display', () => {
    test('서버 x-trial-remaining이 로컬 낙관 카운터보다 우선한다', () => {
        bumpTrialCount();
        bumpTrialCount();
        bumpTrialCount();
        expect(trialRemaining()).toBe(TRIAL_DEVICE_LIMIT - 3);

        rememberTrialRemaining(headers('17'));
        expect(trialRemaining()).toBe(17);
    });

    test('서버 머리글이 없으면 기존 로컬 계산을 쓴다', () => {
        bumpTrialCount();
        rememberTrialRemaining(headers(null));
        expect(trialRemaining()).toBe(TRIAL_DEVICE_LIMIT - 1);
    });

    test('숫자가 아닌 값은 무시한다', () => {
        rememberTrialRemaining(headers('soon'));
        rememberTrialRemaining(headers('-1'));
        expect(trialRemaining()).toBe(TRIAL_DEVICE_LIMIT);
    });

    test('키를 등록하면 맛보기 표시도 초기화된다', () => {
        rememberTrialRemaining(headers('4'));
        expect(trialRemaining()).toBe(4);

        setClassApiKey('class-key-value');
        expect(trialRemaining()).toBe(TRIAL_DEVICE_LIMIT);
    });
});
