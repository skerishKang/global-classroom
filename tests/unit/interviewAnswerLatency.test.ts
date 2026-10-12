// Interview-answer latency budget, fallback and cancellation.
//
// #102 bounded /api/translate; this endpoint routed the same five models with no
// timeout, no retries limit, no shared budget and no cancellation, so a long
// interview could hang on the suggested answer after the transcript and
// translation had already finished. Every provider below is stubbed: no live call
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
  ANSWER_GROQ_MODEL_TIMEOUT_MS,
  ANSWER_GOOGLE_MODEL_TIMEOUT_MS,
  ANSWER_MIN_USEFUL_ATTEMPT_MS,
  ANSWER_TOTAL_BUDGET_MS,
  handler,
} from '../../netlify/functions/interview-answer';

const GROQ_ORDER = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];
const GOOGLE_ORDER = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const GOOD = '{"shouldAnswer":true,"answer":"I would start with the failing request."}';

const postEvent = (body: unknown, headers: Record<string, string> = {}) => ({
  httpMethod: 'POST',
  headers,
  body: JSON.stringify(body),
});

const ask = (body: unknown = { text: 'Explain dependency injection.', answerLanguage: 'en' }) =>
  handler(postEvent(body));

const json = (response: any) => JSON.parse(response.body || '{}');

const httpError = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

/** A route that stalls until the caller's signal fires. */
function stalled() {
  return (_body: any, options: any) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.googleCtorOptions.length = 0;
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  delete process.env.API_KEY;
  mocks.groqCreate.mockResolvedValue({ choices: [{ message: { content: GOOD } }] });
  mocks.generateContent.mockResolvedValue({ text: GOOD });
});

afterEach(() => {
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('#answer budget constants', () => {
  test('the schedule fits inside the ~30s platform window', () => {
    expect(ANSWER_TOTAL_BUDGET_MS).toBeLessThan(30_000);
    expect(ANSWER_GROQ_MODEL_TIMEOUT_MS).toBeLessThan(ANSWER_TOTAL_BUDGET_MS);
    expect(ANSWER_GOOGLE_MODEL_TIMEOUT_MS).toBeLessThan(ANSWER_TOTAL_BUDGET_MS);
    expect(ANSWER_MIN_USEFUL_ATTEMPT_MS).toBeLessThan(ANSWER_GROQ_MODEL_TIMEOUT_MS);
  });

  test('naive per-model caps repeated over the pool would not have fixed it', () => {
    const naive = ANSWER_GROQ_MODEL_TIMEOUT_MS * 3 + ANSWER_GOOGLE_MODEL_TIMEOUT_MS * 2;
    expect(naive).toBeGreaterThan(ANSWER_TOTAL_BUDGET_MS);
  });
});

describe('#answer success and contract preservation', () => {
  test('the first Groq route serves and the call is bounded', async () => {
    const res = await ask();
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ shouldAnswer: true, answer: 'I would start with the failing request.', language: 'en' });

    const [, options] = mocks.groqCreate.mock.calls[0];
    expect(options.timeout).toBe(ANSWER_GROQ_MODEL_TIMEOUT_MS);
    expect(options.maxRetries).toBe(0);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    // The JSON-mode request shape the #62 contract depends on is unchanged.
    expect(mocks.groqCreate.mock.calls[0][0]).toMatchObject({
      model: GROQ_ORDER[0],
      response_format: { type: 'json_object' },
      reasoning_effort: 'low',
    });
  });

  test('malformed model output still fails closed to "no answer" on the first route', async () => {
    mocks.groqCreate.mockResolvedValue({ choices: [{ message: { content: 'Sorry, I cannot help.' } }] });
    const res = await ask({ text: 'hello', answerLanguage: 'ko' });

    // Preserved #62 behaviour: a valid response with no suggestion, not a
    // fall-through and not a hallucinated answer.
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ shouldAnswer: false, answer: '', language: 'ko' });
    expect(mocks.groqCreate).toHaveBeenCalledTimes(1);
  });

  test('an empty provider payload is never returned as a successful answer', async () => {
    mocks.groqCreate.mockResolvedValue({ choices: [{ message: { content: '   ' } }] });
    mocks.generateContent.mockResolvedValue({ text: '' });
    const res = await ask();

    expect(res.statusCode).toBe(502);
    expect(json(res).answer).toBeUndefined();
  });

  test('the answer language stays server-owned for the fallback route too', async () => {
    mocks.groqCreate.mockRejectedValue(httpError(500, 'down'));
    const res = await ask({ text: 'Explain GC.', answerLanguage: 'ko_KR' });
    expect(res.statusCode).toBe(200);
    expect(json(res).language).toBe('ko');
  });
});

describe('#answer fallback by failure class', () => {
  test.each([
    ['404', httpError(404, 'model_not_found')],
    ['429', httpError(429, 'quota exceeded')],
    ['5xx', httpError(503, 'upstream unavailable')],
    ['network', Object.assign(new Error('fetch failed'), { name: 'TypeError' })],
  ])('%s falls through to the next candidate and still answers', async (_label, error) => {
    mocks.groqCreate.mockRejectedValue(error);
    const res = await ask();
    expect(res.statusCode).toBe(200);
    expect(mocks.groqCreate).toHaveBeenCalledTimes(GROQ_ORDER.length);
    expect(json(res).shouldAnswer).toBe(true);
  });

  test('a first-model failure reaches the second Groq route', async () => {
    mocks.groqCreate.mockRejectedValueOnce(httpError(429, 'quota'));
    const res = await ask();
    expect(res.statusCode).toBe(200);
    expect(mocks.groqCreate.mock.calls.map(([body]) => body.model)).toEqual([
      GROQ_ORDER[0], GROQ_ORDER[1],
    ]);
  });

  test('the owner-approved order is preserved across both providers', async () => {
    mocks.groqCreate.mockRejectedValue(httpError(500, 'down'));
    mocks.generateContent.mockRejectedValue(httpError(503, 'down'));

    const res = await ask();
    expect(res.statusCode).toBe(502);
    expect(mocks.groqCreate.mock.calls.map(([body]) => body.model)).toEqual(GROQ_ORDER);
    expect(mocks.generateContent.mock.calls.map(([body]) => body.model)).toEqual(GOOGLE_ORDER);
  });

  test('every candidate failing returns 502 with a closed-vocabulary detail', async () => {
    mocks.groqCreate.mockRejectedValue(httpError(429, 'quota'));
    mocks.generateContent.mockRejectedValue(httpError(429, 'quota'));
    const res = await ask();
    expect(res.statusCode).toBe(502);
    expect(json(res).detail).toBe('rate_limited');
  });
});

describe('#answer cancellation', () => {
  test('the Google client is constructed with a bound and no in-client retry', async () => {
    mocks.groqCreate.mockRejectedValue(httpError(429, 'quota'));
    await ask();

    expect(mocks.googleCtorOptions.length).toBeGreaterThan(0);
    for (const options of mocks.googleCtorOptions) {
      expect(options.httpOptions.timeout).toBeGreaterThanOrEqual(ANSWER_GOOGLE_MODEL_TIMEOUT_MS);
      expect(options.httpOptions.timeout).toBeLessThanOrEqual(ANSWER_TOTAL_BUDGET_MS);
      expect(options.httpOptions.retryOptions).toEqual({ attempts: 1 });
    }
    expect(mocks.generateContent.mock.calls[0][0].config.abortSignal).toBeInstanceOf(AbortSignal);
  });

  test('the signal is aborted once the attempt settles, so nothing lingers', async () => {
    let captured: AbortSignal | undefined;
    mocks.groqCreate.mockImplementation((_body: any, options: any) => {
      captured = options.signal;
      return Promise.resolve({ choices: [{ message: { content: GOOD } }] });
    });

    await ask();
    expect(captured?.aborted).toBe(true);
  });

  test('a stalled route is cancelled and the pool keeps moving', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    mocks.groqCreate.mockImplementation(stalled());

    const pending = ask();
    await vi.advanceTimersByTimeAsync(ANSWER_TOTAL_BUDGET_MS);
    const res = await pending;

    expect(res.statusCode).toBe(200);
    expect(json(res).shouldAnswer).toBe(true);
    expect(mocks.groqCreate).toHaveBeenCalledTimes(GROQ_ORDER.length);
    expect(Date.now() - start).toBeLessThanOrEqual(ANSWER_TOTAL_BUDGET_MS);
  });

  test('a provider that ignores its cancellation signal is still bounded', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    // Never settles and never listens to the signal: the local deadline is the
    // only thing that can end this.
    mocks.groqCreate.mockImplementation(() => new Promise(() => {}));
    mocks.generateContent.mockImplementation(() => new Promise(() => {}));

    const pending = ask();
    await vi.advanceTimersByTimeAsync(ANSWER_TOTAL_BUDGET_MS);
    const res = await pending;

    expect(res.statusCode).toBe(502);
    expect(Date.now() - start).toBeLessThanOrEqual(ANSWER_TOTAL_BUDGET_MS);
  });
});

describe('#answer total budget exhaustion', () => {
  test('the Groq pool cannot spend the reserve: one Google fallback still runs', async () => {
    vi.useFakeTimers();
    mocks.groqCreate.mockImplementation(() => new Promise(() => {}));

    const pending = ask();
    await vi.advanceTimersByTimeAsync(ANSWER_TOTAL_BUDGET_MS);
    const res = await pending;

    expect(res.statusCode).toBe(200);
    expect(json(res).shouldAnswer).toBe(true);
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
  });

  test('a candidate that cannot finish in what is left is never started', async () => {
    vi.useFakeTimers();
    // First two Groq routes consume the budget; the rest must be withheld.
    mocks.groqCreate.mockImplementation((_body: any, options: any) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }));
    mocks.generateContent.mockImplementation(() => new Promise(() => {}));

    const pending = ask();
    await vi.advanceTimersByTimeAsync(ANSWER_TOTAL_BUDGET_MS);
    const res = await pending;

    expect(res.statusCode).toBe(502);
    expect(json(res).detail).toMatch(/budget_exhausted|below_sdk_minimum/);
    // Fewer than the full pool was attempted: the budget, not the pool, ended it.
    expect(mocks.groqCreate.mock.calls.length + mocks.generateContent.mock.calls.length)
      .toBeLessThan(GROQ_ORDER.length + GOOGLE_ORDER.length);
  });
});

describe('#answer telemetry safety', () => {
  test('attempt and summary lines carry only provider, model, latency and outcome', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    mocks.groqCreate.mockRejectedValueOnce(httpError(429, 'quota'));
    await ask({ text: 'Explain dependency injection.', answerLanguage: 'en' });

    const lines = info.mock.calls.map(([line]) => String(line));
    const attempts = lines.filter((line) => line.includes('[interview-answer] attempt'));
    const done = lines.find((line) => line.includes('[interview-answer] done'));

    expect(attempts[0]).toMatch(/provider=groq model=openai\/gpt-oss-20b ms=\d+ outcome=rate_limited/);
    expect(done).toMatch(/status=200 totalMs=\d+ attempts=\d+ served=groq\/openai\/gpt-oss-120b/);
  });

  test('no API key, question, context turn or answer text is ever logged', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.groqCreate.mockRejectedValue(httpError(500, 'down'));
    mocks.generateContent.mockRejectedValue(httpError(500, 'down'));

    await ask({
      text: 'CONFIDENTIAL-QUESTION about the candidate',
      answerLanguage: 'en',
      recentContext: ['CONFIDENTIAL-CONTEXT-TURN'],
    });

    const logged = [
      ...info.mock.calls.map(([line]) => String(line)),
      ...error.mock.calls.map(([, ...rest]) => rest.map(String).join(' ')),
    ].join('\n');

    expect(logged).not.toContain('test-groq-key');
    expect(logged).not.toContain('test-gemini-key');
    expect(logged).not.toContain('CONFIDENTIAL-QUESTION');
    expect(logged).not.toContain('CONFIDENTIAL-CONTEXT-TURN');
  });
});
