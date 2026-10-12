// #84 — translation latency budget, fallback and cancellation.
//
// Production returned ~30s HTTP 504 from /api/translate because no provider call
// had a bound: the Groq client alone defaults to a 60s timeout with 2 retries.
// These tests pin the repaired schedule. Every provider is stubbed; no live call
// is made and no real key exists in this process.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  groqCreate: vi.fn(),
  googleCtorOptions: [] as any[],
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  class GoogleGenAI {
    models = { generateContent: mocks.generateContent };
    constructor(options: any) {
      mocks.googleCtorOptions.push(options);
    }
  }
  return { ...actual, GoogleGenAI };
});

vi.mock('groq-sdk', () => ({
  default: class Groq {
    chat = { completions: { create: mocks.groqCreate } };
    constructor(_options: any) {}
  },
}));

import {
  GOOGLE_MODEL_TIMEOUT_MS,
  GOOGLE_RESERVE_MS,
  GROQ_MODEL_TIMEOUT_MS,
  MIN_USEFUL_ATTEMPT_MS,
  TRANSLATION_TOTAL_BUDGET_MS,
  TranslationTelemetry,
  classifyProviderError,
  planAttempt,
} from '../../netlify/functions/_translationBudget';
import { handler } from '../../netlify/functions/translate';

const GROQ_ORDER = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];
const GOOGLE_ORDER = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

const makeEvent = (body: unknown) => ({
  httpMethod: 'POST',
  headers: {} as Record<string, string>,
  body: JSON.stringify(body),
});

const parse = (response: any) => ({ statusCode: response.statusCode, json: JSON.parse(response.body || '{}') });

const httpError = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

const groqOk = (translated: string) => ({
  choices: [{ message: { content: translated } }],
});

const request = { text: 'Hello there', from: 'English', to: 'French' };

/** A Groq route that stalls until the caller's signal fires, then rejects the way
 * an aborted fetch does. Proves the bound is enforced by real cancellation. */
function stalledGroq() {
  return (_body: any, options: any) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      });
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.googleCtorOptions.length = 0;
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.GROQ_API_KEY = 'test-groq-key';
  delete process.env.API_KEY;
  mocks.groqCreate.mockResolvedValue(groqOk('translated'));
  mocks.generateContent.mockResolvedValue({ text: 'translated' });
});

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('#84 budget constants', () => {
  test('the whole schedule fits well inside the ~30s platform window', () => {
    expect(TRANSLATION_TOTAL_BUDGET_MS).toBeLessThan(30_000);
    expect(TRANSLATION_TOTAL_BUDGET_MS).toBeGreaterThan(GOOGLE_MODEL_TIMEOUT_MS);
  });

  test('per-model bounds are smaller than the total, so no single call owns it', () => {
    expect(GROQ_MODEL_TIMEOUT_MS).toBeLessThan(TRANSLATION_TOTAL_BUDGET_MS);
    expect(GOOGLE_MODEL_TIMEOUT_MS).toBeLessThan(TRANSLATION_TOTAL_BUDGET_MS);
    expect(MIN_USEFUL_ATTEMPT_MS).toBeLessThan(GROQ_MODEL_TIMEOUT_MS);
  });

  test('five unbounded 10s allowances would NOT have been a fix', () => {
    // The naive design the owner warned about: one cap repeated per candidate.
    const naivePerModelRepeat = GROQ_MODEL_TIMEOUT_MS * 3 + GOOGLE_MODEL_TIMEOUT_MS * 2;
    expect(naivePerModelRepeat).toBeGreaterThan(TRANSLATION_TOTAL_BUDGET_MS);
  });
});

describe('#84 planAttempt', () => {
  test('a fresh request starts a Groq candidate at the provider cap', () => {
    expect(planAttempt({ provider: 'groq', elapsedMs: 0, googleCandidatesRemaining: 2 }))
      .toEqual({ state: 'start', timeoutMs: GROQ_MODEL_TIMEOUT_MS });
  });

  test('a Groq candidate is shortened to exactly what remains after the reserve', () => {
    const elapsed = TRANSLATION_TOTAL_BUDGET_MS - GOOGLE_RESERVE_MS - 2_000;
    expect(planAttempt({ provider: 'groq', elapsedMs: elapsed, googleCandidatesRemaining: 1 }))
      .toEqual({ state: 'start', timeoutMs: 2_000 });
  });

  test('Groq must not consume the Google fallback reserve', () => {
    const elapsed = TRANSLATION_TOTAL_BUDGET_MS - GOOGLE_RESERVE_MS;
    expect(planAttempt({ provider: 'groq', elapsedMs: elapsed, googleCandidatesRemaining: 2 }))
      .toEqual({ state: 'skip', reason: 'budget_exhausted' });
  });

  test('without a Google fallback the whole remainder goes to Groq', () => {
    const elapsed = TRANSLATION_TOTAL_BUDGET_MS - 3_000;
    expect(planAttempt({ provider: 'groq', elapsedMs: elapsed, googleCandidatesRemaining: 0 }))
      .toEqual({ state: 'start', timeoutMs: 3_000 });
  });

  test('Google is never started below the client minimum', () => {
    const elapsed = TRANSLATION_TOTAL_BUDGET_MS - (GOOGLE_MODEL_TIMEOUT_MS - 1);
    expect(planAttempt({ provider: 'google', elapsedMs: elapsed, googleCandidatesRemaining: 2 }))
      .toEqual({ state: 'skip', reason: 'below_sdk_minimum' });
  });

  test('a spent budget starts nothing at all', () => {
    expect(planAttempt({ provider: 'google', elapsedMs: TRANSLATION_TOTAL_BUDGET_MS, googleCandidatesRemaining: 1 }))
      .toEqual({ state: 'skip', reason: 'budget_exhausted' });
  });
});

describe('#84 provider error classification', () => {
  test.each([
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [503, 'server_error'],
    [400, 'client_error'],
  ])('HTTP %i maps to %s', (status, expected) => {
    expect(classifyProviderError(httpError(status, 'boom'))).toBe(expected);
  });

  test('Google ApiError status is read from its $meta shape', () => {
    expect(classifyProviderError(Object.assign(new Error('quota'), { $: { status: 429 } })))
      .toBe('rate_limited');
  });

  test('connection failure and no-response are network class', () => {
    expect(classifyProviderError(Object.assign(new Error('fetch failed'), { name: 'TypeError' })))
      .toBe('network');
    expect(classifyProviderError(Object.assign(new Error('conn'), { name: 'APIConnectionError' })))
      .toBe('network');
    expect(classifyProviderError(Object.assign(new Error('t'), { name: 'APIConnectionTimeoutError' })))
      .toBe('timeout');
  });

  test('an abort is distinguishable from a status failure', () => {
    expect(classifyProviderError(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      .toBe('aborted');
    expect(classifyProviderError(new Error('plain'))).toBe('unknown');
  });
});

describe('#84 handler success and fallback', () => {
  test('the first Groq route serves when it answers, and the call is bounded', async () => {
    const res = parse(await handler(makeEvent(request)));
    expect(res.statusCode).toBe(200);
    expect(res.json).toMatchObject({ provider: 'groq', model: GROQ_ORDER[0] });

    const [, options] = mocks.groqCreate.mock.calls[0];
    expect(options.timeout).toBe(GROQ_MODEL_TIMEOUT_MS);
    expect(options.maxRetries).toBe(0);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  test('404, 429, 5xx and network errors all fall through to the next model', async () => {
    for (const error of [httpError(404, 'model_not_found'), httpError(429, 'quota'),
                         httpError(503, 'upstream'), Object.assign(new Error('fetch failed'), { name: 'TypeError' })]) {
      mocks.groqCreate.mockReset().mockRejectedValue(error);
      mocks.generateContent.mockResolvedValue({ text: 'translated' });
      const res = parse(await handler(makeEvent(request)));
      expect(res.statusCode).toBe(200);
      expect(mocks.groqCreate).toHaveBeenCalledTimes(GROQ_ORDER.length);
      expect(res.json).toMatchObject({ provider: 'google', model: GOOGLE_ORDER[0] });
    }
  });

  test('an empty completion is a failure and never reaches the caller as success', async () => {
    mocks.groqCreate.mockResolvedValue(groqOk('   '));
    const res = parse(await handler(makeEvent(request)));
    expect(res.json.translated).not.toBe('');
    expect(mocks.groqCreate).toHaveBeenCalledTimes(GROQ_ORDER.length);
  });

  test('a stalled Groq route is cancelled and the pool keeps moving', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    mocks.groqCreate.mockImplementation(stalledGroq());

    const pending = handler(makeEvent(request));
    await vi.advanceTimersByTimeAsync(TRANSLATION_TOTAL_BUDGET_MS);
    const res = parse(await pending);

    // Every Groq route stalled; the Google fallback served inside the budget.
    expect(res.statusCode).toBe(200);
    expect(res.json.provider).toBe('google');
    expect(mocks.groqCreate).toHaveBeenCalledTimes(GROQ_ORDER.length);
    // The bound was a real timeout, not a hang: total stays far below 30s.
    expect(Date.now() - start).toBeLessThanOrEqual(TRANSLATION_TOTAL_BUDGET_MS);
  });

  test('the signal handed to the provider is aborted once the attempt settles', async () => {
    let captured: AbortSignal | undefined;
    mocks.groqCreate.mockImplementation((_body: any, options: any) => {
      captured = options.signal;
      return Promise.resolve(groqOk('translated'));
    });

    await handler(makeEvent(request));
    expect(captured?.aborted).toBe(true);
  });

  test('the Google client is constructed with a bound and no in-client retry', async () => {
    mocks.groqCreate.mockRejectedValue(httpError(429, 'quota'));
    await handler(makeEvent(request));

    expect(mocks.googleCtorOptions.length).toBeGreaterThan(0);
    for (const options of mocks.googleCtorOptions) {
      expect(options.httpOptions.timeout).toBeGreaterThanOrEqual(GOOGLE_MODEL_TIMEOUT_MS);
      expect(options.httpOptions.timeout).toBeLessThanOrEqual(TRANSLATION_TOTAL_BUDGET_MS);
      expect(options.httpOptions.retryOptions).toEqual({ attempts: 1 });
    }
    expect(mocks.generateContent.mock.calls[0][0].config.abortSignal).toBeInstanceOf(AbortSignal);
  });

  test('the owner-approved model order is preserved across both providers', async () => {
    mocks.groqCreate.mockRejectedValue(httpError(500, 'down'));
    mocks.generateContent.mockRejectedValue(httpError(503, 'down'));

    const res = parse(await handler(makeEvent(request)));
    expect(res.statusCode).toBe(500);
    expect(mocks.groqCreate.mock.calls.map(([body]) => body.model)).toEqual(GROQ_ORDER);
    expect(mocks.generateContent.mock.calls.map(([body]) => body.model)).toEqual(GOOGLE_ORDER);
  });
});

describe('#84 total budget exhaustion', () => {
  test('the Groq pool cannot spend the reserve: one Google fallback still runs', async () => {
    vi.useFakeTimers();
    // Groq routes never settle, so only the reserve rule can still reach Google.
    mocks.groqCreate.mockImplementation(() => new Promise(() => {}));

    const pending = handler(makeEvent(request));
    await vi.advanceTimersByTimeAsync(TRANSLATION_TOTAL_BUDGET_MS);
    const res = parse(await pending);

    expect(res.statusCode).toBe(200);
    expect(res.json).toMatchObject({ provider: 'google', model: GOOGLE_ORDER[0] });
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
  });

  test('when every candidate is silent the request fails inside the budget', async () => {
    vi.useFakeTimers();
    mocks.groqCreate.mockImplementation(() => new Promise(() => {}));
    mocks.generateContent.mockImplementation(() => new Promise(() => {}));

    const pending = handler(makeEvent(request));
    await vi.advanceTimersByTimeAsync(TRANSLATION_TOTAL_BUDGET_MS);
    const res = parse(await pending);

    expect(res.statusCode).toBe(500);
    // At most one Groq route plus the reserved Google attempt: the remaining
    // candidates were withheld instead of being allowed to overrun the limit.
    expect(mocks.groqCreate.mock.calls.length).toBeLessThanOrEqual(GROQ_ORDER.length);
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
    expect(res.json.detail).toMatch(/budget_exhausted|below_sdk_minimum/);
  });

  test('the handler answers inside the budget even when every route ignores cancellation', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    mocks.groqCreate.mockImplementation(() => new Promise(() => {}));
    mocks.generateContent.mockImplementation(() => new Promise(() => {}));

    const pending = handler(makeEvent(request));
    await vi.advanceTimersByTimeAsync(TRANSLATION_TOTAL_BUDGET_MS);
    const res = parse(await pending);

    expect(res.statusCode).toBeLessThan(600);
    expect(Date.now() - start).toBeLessThanOrEqual(TRANSLATION_TOTAL_BUDGET_MS);
  });

  test('without a Groq key the whole budget is available to the Google fallbacks', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    delete process.env.GROQ_API_KEY;
    mocks.generateContent.mockImplementation(() => new Promise(() => {}));

    const pending = handler(makeEvent(request));
    await vi.advanceTimersByTimeAsync(TRANSLATION_TOTAL_BUDGET_MS);
    const res = parse(await pending);

    expect(res.statusCode).toBe(500);
    expect(mocks.groqCreate).not.toHaveBeenCalled();
    // No reserve is needed on a Google-only path, so both candidates can run,
    // but the total still bounds the request.
    expect(mocks.generateContent.mock.calls.length).toBeLessThanOrEqual(GOOGLE_ORDER.length);
    expect(Date.now() - start).toBeLessThanOrEqual(TRANSLATION_TOTAL_BUDGET_MS);
  });
});

describe('#84 telemetry safety', () => {
  test('attempt and summary lines carry latency and outcome only', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    mocks.groqCreate.mockRejectedValueOnce(httpError(429, 'quota'));
    await handler(makeEvent({ ...request, glossary: [{ source: '비밀용어', target: 'secret-term' }] }));

    const lines = info.mock.calls.map(([line]) => String(line));
    const attempts = lines.filter((line) => line.includes('[translate] attempt'));
    const done = lines.find((line) => line.includes('[translate] done'));

    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts[0]).toMatch(/provider=groq model=openai\/gpt-oss-20b ms=\d+ outcome=rate_limited/);
    expect(done).toMatch(/status=200 totalMs=\d+ attempts=\d+ served=(groq|google)\//);
  });

  test('no API key, request text or glossary term is ever logged', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.groqCreate.mockRejectedValue(httpError(500, 'down'));
    mocks.generateContent.mockRejectedValue(httpError(500, 'down'));

    await handler(makeEvent({
      text: 'CONFIDENTIAL-SPEAKER-TEXT must never be logged',
      from: 'English',
      to: 'French',
      glossary: [{ source: 'CONFIDENTIAL-TERM', target: 'CONFIDENTIAL-TARGET' }],
    }));

    const logged = [
      ...info.mock.calls.map(([line]) => String(line)),
      ...error.mock.calls.map(([...args]) => args.map(String).join(' ')),
    ].join('\n');

    expect(logged).not.toContain('test-groq-key');
    expect(logged).not.toContain('test-gemini-key');
    expect(logged).not.toContain('CONFIDENTIAL-SPEAKER-TEXT');
    expect(logged).not.toContain('CONFIDENTIAL-TERM');
  });

  test('telemetry summary tallies outcomes without provider payloads', () => {
    const telemetry = new TranslationTelemetry(() => Date.now(), 1_000);
    telemetry.record({ provider: 'groq', model: 'm1', ms: 5, outcome: 'timeout' });
    telemetry.record({ provider: 'groq', model: 'm2', ms: 6, outcome: 'timeout' });
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const line = telemetry.summary({ statusCode: 500, provider: null, model: null });
    expect(line).toContain('timeout=2');
    expect(line).toContain('served=none/none');
    spy.mockRestore();
  });
});
