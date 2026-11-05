import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
    DEVICE_ID_HEADER,
    TRIAL_DEVICE_LIMIT,
    TRIAL_REMAINING_HEADER,
    TRIAL_SESSION_HEADER,
    TRIAL_STORE_HEADER,
    USER_KEY_HEADER,
    enforceAiUsageGate,
    resetTrialCountersForTests,
    resetRateLimitsForTests,
    withTrialHeaders,
} from '../../netlify/functions/_rateLimit';

const DEVICE = 'device-token-abcdef01';
const SESSION = 'session-token-12345678';
const RULE = { burstLimit: 500, perMinuteLimit: 500 };

const trialEvent = (overrides: Record<string, string> = {}) => ({
    headers: {
        [DEVICE_ID_HEADER]: DEVICE,
        [TRIAL_SESSION_HEADER]: SESSION,
        ...overrides,
    },
});

const gate = (event: any, endpoint = 'translate') =>
    enforceAiUsageGate(event, RULE, endpoint);

const devicePrefix = createHash('sha256').update(DEVICE).digest('hex').slice(0, 8);

beforeEach(() => {
    resetTrialCountersForTests();
    resetRateLimitsForTests();
    vi.restoreAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('#120 trial observability headers', () => {
    test('공용 맛보기 통과 응답은 남은 횟수와 저장 위치를 머리글로 돌려준다', async () => {
        const result = await gate(trialEvent());
        expect(result.blocked).toBeNull();
        expect(result.headers[TRIAL_REMAINING_HEADER]).toBe(String(TRIAL_DEVICE_LIMIT - 1));
        expect(result.headers[TRIAL_STORE_HEADER]).toBe('memory');
        expect(result.trial).toEqual({
            remaining: TRIAL_DEVICE_LIMIT - 1,
            storeMode: 'memory',
        });
    });

    test('호출마다 남은 횟수가 한 번씩 줄어든다', async () => {
        for (let i = 0; i < 10; i += 1) {
            await gate(trialEvent({ [TRIAL_SESSION_HEADER]: `${SESSION}-${i}` }));
        }
        const result = await gate(trialEvent({ [TRIAL_SESSION_HEADER]: `${SESSION}-10` }));
        expect(result.headers[TRIAL_REMAINING_HEADER]).toBe(String(TRIAL_DEVICE_LIMIT - 11));
    });

    test('개인·반 키 요청에는 맛보기 머리글을 붙이지 않는다', async () => {
        const result = await gate(trialEvent({ [USER_KEY_HEADER]: 'AIzaSyExampleKey000000000000' }));
        expect(result.blocked).toBeNull();
        expect(result.headers).toEqual({});
        expect(result.trial).toBeNull();
    });

    test('기기 번호가 없는 요청에도 맛보기 머리글을 붙이지 않는다', async () => {
        const result = await gate({ headers: {} });
        expect(result.blocked).toBeNull();
        expect(result.headers).toEqual({});
        expect(result.trial).toBeNull();
    });

    test('소진 응답도 남은 0회와 저장 위치를 머리글로 알린다', async () => {
        for (let i = 0; i < TRIAL_DEVICE_LIMIT; i += 1) {
            await gate(trialEvent({ [TRIAL_SESSION_HEADER]: `${SESSION}-${i}` }));
        }
        const result = await gate(trialEvent({ [TRIAL_SESSION_HEADER]: `${SESSION}-last` }));
        expect(result.blocked?.statusCode).toBe(429);
        expect(result.headers[TRIAL_REMAINING_HEADER]).toBe('0');
        expect(result.headers[TRIAL_STORE_HEADER]).toBe('memory');
        expect(result.blocked!.headers[TRIAL_REMAINING_HEADER]).toBe('0');
        expect(result.blocked!.headers[TRIAL_STORE_HEADER]).toBe('memory');
    });
});

describe('#120 trial observability log line', () => {
    test('엔드포인트·저장 위치·남은 횟수·기기 해시 앞 8자만 한 줄로 남긴다', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        await gate(trialEvent(), 'translate');
        expect(info).toHaveBeenCalledTimes(1);
        const line = String(info.mock.calls[0][0]);
        expect(line).toContain('endpoint=translate');
        expect(line).toContain('store=memory');
        expect(line).toContain(`remaining=${TRIAL_DEVICE_LIMIT - 1}`);
        expect(line).toContain(`device=${devicePrefix}`);
        // 원문 기기·세션 번호는 로그에 남기지 않는다.
        expect(line).not.toContain(DEVICE);
        expect(line).not.toContain(SESSION);
    });

    test('키 요청은 맛보기 로그를 남기지 않는다', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        await gate(trialEvent({ [USER_KEY_HEADER]: 'AIzaSyExampleKey000000000000' }));
        expect(info).not.toHaveBeenCalled();
    });
});

describe('withTrialHeaders', () => {
    test('성공 응답의 기존 머리글을 유지한 채 맛보기 머리글을 합친다', async () => {
        const result = await gate(trialEvent());
        const merged = withTrialHeaders(
            { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' },
            result,
        );
        expect(merged.headers!['Content-Type']).toBe('application/json');
        expect(merged.headers![TRIAL_REMAINING_HEADER]).toBe(String(TRIAL_DEVICE_LIMIT - 1));
        expect(merged.headers![TRIAL_STORE_HEADER]).toBe('memory');
    });

    test('붙일 머리글이 없으면 응답을 그대로 돌려준다', () => {
        const response = { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' };
        expect(withTrialHeaders(response, { blocked: null, headers: {}, trial: null })).toBe(response);
    });
});
