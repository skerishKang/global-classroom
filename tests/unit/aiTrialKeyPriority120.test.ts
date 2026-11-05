import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    buildAiHeaders,
    getDeviceId,
    resolveApiKey,
    setClassApiKey,
    TRIAL_DEVICE_LIMIT,
} from '../../utils/apiKey';

const PERSONAL = 'AIzaSyPersonalKeyExample00000000001';
const CLASS = 'AIzaSyClassKeyExample000000000000001';

const storage = () => (globalThis as any).localStorage as {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
    removeItem(k: string): void;
    clear(): void;
};

beforeEach(() => {
    const backing = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
        setItem: (k: string, v: string) => void backing.set(k, String(v)),
        removeItem: (k: string) => void backing.delete(k),
        clear: () => void backing.clear(),
    });
    vi.stubGlobal('sessionStorage', {
        getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
        setItem: (k: string, v: string) => void backing.set(k, String(v)),
        removeItem: (k: string) => void backing.delete(k),
        clear: () => void backing.clear(),
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('#120 key priority: personal > class > shared trial', () => {
    test('개인 키가 최우선이다', () => {
        expect(resolveApiKey({ userApiKey: PERSONAL })).toBe(PERSONAL);
        setClassApiKey(CLASS);
        expect(resolveApiKey({ userApiKey: PERSONAL })).toBe(PERSONAL);
    });

    test('개인 키가 없으면 반 키가 쓰인다', () => {
        setClassApiKey(CLASS);
        expect(resolveApiKey({ userApiKey: '' })).toBe(CLASS);
        expect(resolveApiKey({})).toBe(CLASS);
        expect(resolveApiKey(null)).toBe(CLASS);
    });

    test('둘 다 없으면 빈 값 — 헤더를 보내지 않고 공용 맛보기로 간다', () => {
        expect(resolveApiKey({ userApiKey: '' })).toBe('');
        const headers = buildAiHeaders({ userApiKey: '' });
        expect(headers['x-user-api-key']).toBeUndefined();
        expect(headers['x-device-id']).toBe(getDeviceId());
        expect(headers['x-trial-session']).toBeTruthy();
    });

    test('buildAiHeaders는 키가 있으면 x-user-api-key만 실는다', () => {
        setClassApiKey(CLASS);
        const keyed = buildAiHeaders({ userApiKey: PERSONAL });
        expect(keyed).toEqual({ 'x-user-api-key': PERSONAL });
        const classed = buildAiHeaders(null);
        expect(classed).toEqual({ 'x-user-api-key': CLASS });
    });

    test('반 키를 지우면 맛보기 카운터도 초기화된다', () => {
        setClassApiKey(CLASS);
        setClassApiKey('');
        expect(resolveApiKey(null)).toBe('');
    });

    test('기기 번호는 재호출에도 동일하게 유지된다', () => {
        expect(getDeviceId()).toBe(getDeviceId());
        expect(getDeviceId().length).toBeGreaterThanOrEqual(8);
    });

    test('한도 상수는 문서화된 기본값과 같다', () => {
        expect(TRIAL_DEVICE_LIMIT).toBe(30);
    });
});
