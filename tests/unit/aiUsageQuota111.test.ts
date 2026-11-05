import { describe, expect, test, vi } from 'vitest';
import {
    AI_RATE_LIMITS,
    BUCKET_MAX,
    bucketCount,
    clientKeyFromHeaders,
    consumeRateLimit,
    enforceRateLimit,
    rateLimitResponse,
} from '../../netlify/functions/_rateLimit';
import runSttHandler, { runSttAttempt } from '../../netlify/functions/transcribe.mts';

describe('#111 client identity from platform headers', () => {
    test('Netlify 연결 IP 헤더를 최우선으로 쓴다', () => {
        const key = clientKeyFromHeaders((name) => {
            if (name === 'x-forwarded-for') return '198.51.100.7';
            if (name === 'x-nf-client-connection-ip') return '203.0.113.9';
            return undefined;
        });
        expect(key).toBe('203.0.113.9');
    });

    test('x-forwarded-for 체인은 첫 값을 쓴다', () => {
        const key = clientKeyFromHeaders((name) => (
            name === 'x-forwarded-for' ? '198.51.100.7, 10.0.0.1' : undefined
        ));
        expect(key).toBe('198.51.100.7');
    });

    test('식별 불가 요청은 전부 unknown 하나로 묶는다(fail-closed)', () => {
        expect(clientKeyFromHeaders(() => undefined)).toBe('unknown');
        const first = consumeRateLimit('unknown', { burstLimit: 2, perMinuteLimit: 100 });
        expect(first.allowed).toBe(true);
        const second = consumeRateLimit('unknown', { burstLimit: 2, perMinuteLimit: 100 });
        expect(second.allowed).toBe(true);
        const third = consumeRateLimit('unknown', { burstLimit: 2, perMinuteLimit: 100 });
        expect(third.allowed).toBe(false);
    });
});

describe('#111 token bucket + per-minute budget', () => {
    test('버스트 한도 안의 연속 호출은 모두 통과하고 초과분은 429 판정을 받는다', () => {
        const rule = { burstLimit: 5, perMinuteLimit: 100 };
        let now = 0;
        const clock = () => now;
        const results = Array.from({ length: 6 }, () => consumeRateLimit('burst-test', rule, clock));
        expect(results.slice(0, 5).every((r) => r.allowed)).toBe(true);
        expect(results[5].allowed).toBe(false);
        expect(results[5].retryAfterSeconds).toBeGreaterThanOrEqual(1);
    });

    test('분당 예산을 채우면 창이 닫힐 때까지의 시간으로 재시도를 안내한다', () => {
        const rule = { burstLimit: 100, perMinuteLimit: 3 };
        let now = 0;
        const clock = () => now;
        for (let i = 0; i < 3; i += 1) {
            now = i * 1000;
            expect(consumeRateLimit('minute-test', rule, clock).allowed).toBe(true);
        }
        now = 2000;
        const denied = consumeRateLimit('minute-test', rule, clock);
        expect(denied.allowed).toBe(false);
        expect(denied.retryAfterSeconds).toBe(58);
    });

    test('시간이 지나면 버스트가 다시 차서 허용된다', () => {
        const rule = { burstLimit: 2, perMinuteLimit: 60 };
        let now = 0;
        const clock = () => now;
        expect(consumeRateLimit('refill-test', rule, clock).allowed).toBe(true);
        expect(consumeRateLimit('refill-test', rule, clock).allowed).toBe(true);
        expect(consumeRateLimit('refill-test', rule, clock).allowed).toBe(false);
        now = 2000; // 2초 경과: 분당 60개 리필 → 2개 회복
        expect(consumeRateLimit('refill-test', rule, clock).allowed).toBe(true);
    });

    test('키가 다르면 한도가 독립이다', () => {
        const rule = { burstLimit: 1, perMinuteLimit: 100 };
        expect(consumeRateLimit('ip-a', rule).allowed).toBe(true);
        expect(consumeRateLimit('ip-b', rule).allowed).toBe(true);
        expect(consumeRateLimit('ip-a', rule).allowed).toBe(false);
        expect(consumeRateLimit('ip-b', rule).allowed).toBe(false);
    });

    test('버킷 상한을 넘으면 오래된 버킷이 정리된다', () => {
        const rule = { burstLimit: 1, perMinuteLimit: 1 };
        for (let i = 0; i < BUCKET_MAX + 5; i += 1) {
            consumeRateLimit(`flood-${i}`, rule);
        }
        expect(bucketCount()).toBeLessThanOrEqual(BUCKET_MAX);
    });
});

describe('#111 429 response shape', () => {
    test('한국어 안내와 Retry-After 헤더를 함께 돌려준다', () => {
        const response = rateLimitResponse({ allowed: false, retryAfterSeconds: 42 });
        expect(response.statusCode).toBe(429);
        expect(response.headers['Retry-After']).toBe('42');
        const body = JSON.parse(response.body);
        expect(body.error).toContain('일시적으로 제한');
        expect(body.retryAfterSeconds).toBe(42);
    });

    test('legacy 핸들러 게이트는 허용 시 null, 초과 시 429 응답을 돌려준다', () => {
        const event = { headers: { 'x-nf-client-connection-ip': '203.0.113.50' } };
        const rule = AI_RATE_LIMITS.translate;

        expect(enforceRateLimit(event, rule)).toBeNull();
        for (let i = 1; i < rule.burstLimit; i += 1) {
            enforceRateLimit(event, rule);
        }
        const denied = enforceRateLimit(event, rule);
        expect(denied).not.toBeNull();
        expect(denied!.statusCode).toBe(429);
        expect(JSON.parse(denied!.body).error).toContain('일시적으로 제한');
    });
});

describe('#111 STT attempt deadline', () => {
    const audio = { mimeType: 'audio/webm', bytes: Buffer.from('fake'), extension: 'webm' };

    test('정상 응답은 공백을 정리해 돌려준다', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ text: '  안녕하세요  ' }),
        });
        const result = await runSttAttempt({
            apiKey: 'test', model: 'whisper-large-v3-turbo', audio, language: 'auto',
            timeoutMs: 500, fetchImpl: fetchImpl as any,
        });
        expect(result).toEqual({ ok: 'ok', text: '안녕하세요' });
    });

    test('업스트림 HTTP 오류는 http_error로 분류된다', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false,
            json: async () => ({ error: { message: 'quota exceeded' } }),
        });
        const result = await runSttAttempt({
            apiKey: 'test', model: 'whisper-large-v3-turbo', audio, language: 'auto',
            timeoutMs: 500, fetchImpl: fetchImpl as any,
        });
        expect(result.ok).toBe('failed');
        expect((result as any).outcome).toBe('http_error');
        expect((result as any).error).toContain('quota exceeded');
    });

    test('빈 전사는 empty로 분류된다', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ text: '   ' }),
        });
        const result = await runSttAttempt({
            apiKey: 'test', model: 'whisper-large-v3-turbo', audio, language: 'auto',
            timeoutMs: 500, fetchImpl: fetchImpl as any,
        });
        expect(result.ok).toBe('failed');
        expect((result as any).outcome).toBe('empty');
    });

    test('신호를 무시하고 멈추는 업스트림도 마감이 지나면 timeout으로 끝난다', async () => {
        const startedAt = Date.now();
        const fetchImpl = vi.fn(() => new Promise<Response>(() => { /* never settles */ }));
        const result = await runSttAttempt({
            apiKey: 'test', model: 'whisper-large-v3-turbo', audio, language: 'auto',
            timeoutMs: 60, fetchImpl: fetchImpl as any,
        });
        expect(result.ok).toBe('failed');
        expect((result as any).outcome).toBe('timeout');
        expect(Date.now() - startedAt).toBeLessThan(2000);
    });

    test('abort 신호를 지키는 업스트림도 timeout으로 분류된다(단순 abort와 구분)', async () => {
        const fetchImpl = vi.fn((_url: any, init: any) => new Promise<Response>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }));
        const result = await runSttAttempt({
            apiKey: 'test', model: 'whisper-large-v3-turbo', audio, language: 'auto',
            timeoutMs: 60, fetchImpl: fetchImpl as any,
        });
        expect(result.ok).toBe('failed');
        expect((result as any).outcome).toBe('timeout');
    });
});

describe('#111 transcribe handler rate gate', () => {
    const makeRequest = () => new Request('http://localhost/api/transcribe', {
        method: 'POST',
        headers: { 'x-nf-client-connection-ip': '203.0.113.77' },
        body: JSON.stringify({ language: 'auto', audioDataUrl: 'data:audio/webm;base64,AAAA' }),
    });

    test('게이트를 통과하면 다음 단계(키 검증)로 진행한다', async () => {
        const response = await runSttHandler(makeRequest());
        // GROQ_API_KEY가 없어 500이지만, 429가 아님으로 게이트 통과를 확인한다.
        expect(response.status).toBe(500);
    });

    test('버스트를 모두 소진한 클라이언트는 429와 Retry-After를 받는다', async () => {
        const key = '203.0.113.77';
        const rule = AI_RATE_LIMITS.transcribe;
        for (let i = 0; i < rule.burstLimit; i += 1) {
            consumeRateLimit(key, rule);
        }
        const response = await runSttHandler(makeRequest());
        expect(response.status).toBe(429);
        expect(response.headers.get('Retry-After')).not.toBeNull();
        const body = await response.json();
        expect(body.error).toContain('일시적으로 제한');
        expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    });
});
