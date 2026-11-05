import { describe, expect, test, vi, beforeEach } from 'vitest';
import {
    AI_RATE_LIMITS,
    DEVICE_ID_HEADER,
    TRIAL_DEVICE_LIMIT,
    TRIAL_SESSION_HEADER,
    TRIAL_SESSION_LIMIT,
    USER_KEY_HEADER,
    enforceAiUsageGate,
    resetTrialCountersForTests,
    resetRateLimitsForTests,
} from '../../netlify/functions/_rateLimit';

const DEVICE = 'device-token-abcdef01';
const SESSION = 'session-token-12345678';
const ENDPOINT = 'test';
/** 누적 맛보기 계수만 검사하는 시험용 규칙 — 버스트 한도가 먼저 걸리지 않게 한다. */
const GENEROUS_RULE = { burstLimit: 500, perMinuteLimit: 500 };

const event = (headers: Record<string, string>) => ({ headers });

const trialEvent = (overrides: Record<string, string> = {}) => event({
    [DEVICE_ID_HEADER]: DEVICE,
    [TRIAL_SESSION_HEADER]: SESSION,
    ...overrides,
});

const gate = (eventLike: any, rule = GENEROUS_RULE) =>
    enforceAiUsageGate(eventLike, rule, ENDPOINT);

beforeEach(() => {
    resetTrialCountersForTests();
    resetRateLimitsForTests();
    vi.restoreAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('#120 shared-trial counting per device/session', () => {
    test('기기 누적 한도 안의 맛보기 호출은 모두 통과한다', async () => {
        for (let i = 0; i < TRIAL_DEVICE_LIMIT; i += 1) {
            // 세션은 브라우저 세션마다 로테이션된다(누적은 기기 단위로 계속).
            const result = await gate(
                trialEvent({ [TRIAL_SESSION_HEADER]: SESSION + '-' + i }),
            );
            expect(result.blocked).toBeNull();
        }
    });

    test('기기 누적 한도를 넘으면 429 등록 안내로 막힌다', async () => {
        for (let i = 0; i < TRIAL_DEVICE_LIMIT; i += 1) {
            await gate(trialEvent({ [TRIAL_SESSION_HEADER]: SESSION + '-' + i }));
        }
        const result = await gate(
            trialEvent({ [TRIAL_SESSION_HEADER]: SESSION + '-' + TRIAL_DEVICE_LIMIT }),
        );
        expect(result.blocked?.statusCode).toBe(429);
        const body = JSON.parse(result.blocked!.body);
        expect(body.code).toBe('trial_exhausted');
        expect(body.error).toContain('개인 API 키를 등록');
        expect(result.blocked!.headers['Retry-After']).toBeTruthy();
    });

    test('세션 한도를 넘으면 세션 사유로 막히고, 세션을 바꾸면 다시 통과한다', async () => {
        for (let i = 0; i < TRIAL_SESSION_LIMIT; i += 1) {
            await gate(trialEvent());
        }
        const blocked = await gate(trialEvent());
        expect(JSON.parse(blocked.blocked!.body).reason).toBe('session_limit');
        const fresh = await gate(
            trialEvent({ [TRIAL_SESSION_HEADER]: SESSION + 'fresh' }),
        );
        expect(fresh.blocked).toBeNull();
    });

    test('기기 번호가 없는 요청은 IP 보조 버킷만으로 통과한다(누적 미적용)', async () => {
        const headerless = event({});
        for (let i = 0; i < TRIAL_DEVICE_LIMIT + 5; i += 1) {
            const result = await gate(headerless);
            expect(result.blocked).toBeNull();
        }
    });
});

describe('#120 keyed requests (personal/class) skip the trial counter', () => {
    test('x-user-api-key가 있으면 맛보기 카운터가 세지 않는다', async () => {
        const keyed = trialEvent({ [USER_KEY_HEADER]: 'AIzaSyClassKeyExample0000000000' });
        for (let i = 0; i < TRIAL_DEVICE_LIMIT + 10; i += 1) {
            const result = await gate(keyed);
            expect(result.blocked).toBeNull();
        }
    });

    test('반 키 사용 후 같은 기기로 돌아온 맛보기는 남은 횟수를 그대로 쓴다', async () => {
        for (let i = 0; i < 10; i += 1) {
            await gate(trialEvent());
        }
        const keyed = trialEvent({ [USER_KEY_HEADER]: 'AIzaSyClassKeyExample0000000000' });
        for (let i = 0; i < 10; i += 1) {
            expect((await gate(keyed)).blocked).toBeNull();
        }
        // Back on the shared trial with a fresh session: still inside the
        // device cumulative budget, so the run continues.
        const fresh = await gate(
            trialEvent({ [TRIAL_SESSION_HEADER]: SESSION + '2' }),
        );
        expect(fresh.blocked).toBeNull();
    });
});

describe('#120 device-less burst budget', () => {
    test('기기 번호 없는 요청은 IP 버킷의 버스트·분당 한도를 그대로 받는다', async () => {
        const rule = AI_RATE_LIMITS.translate;
        for (let i = 0; i < rule.burstLimit; i += 1) {
            expect((await gate(event({}), rule)).blocked).toBeNull();
        }
        const blocked = await gate(event({}), rule);
        expect(blocked.blocked?.statusCode).toBe(429);
        expect(JSON.parse(blocked.blocked!.body).code).toBeUndefined();
    });
});
