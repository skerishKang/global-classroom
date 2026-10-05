import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Provider stub: #62 tests only exercise request shaping, response validation
// and fail-closed handling. No live provider call is ever made.
const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  ctorKeys: [] as string[],
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  class GoogleGenAI {
    models = { generateContent: mocks.generateContent };
    constructor(options: { apiKey?: string }) {
      mocks.ctorKeys.push(options?.apiKey || '');
    }
  }
  return { ...actual, GoogleGenAI };
});

import { handler, parseAnswerPayload, MAX_ANSWER_CONTEXT_TURNS } from '../../netlify/functions/interview-answer';
import { buildAnswerRequest } from '../../utils/interviewAnswer';

const postEvent = (body: unknown, headers: Record<string, string> = {}, method = 'POST') => ({
  httpMethod: method,
  headers,
  body: JSON.stringify(body),
});

const modelReply = (text: string) => {
  mocks.generateContent.mockResolvedValueOnce({ text });
};

beforeEach(() => {
  mocks.generateContent.mockReset();
  mocks.ctorKeys.length = 0;
  delete process.env.GEMINI_API_KEY;
  delete process.env.API_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#62 interview answer assist endpoint', () => {
  test('rejects non-POST and oversized or missing payloads', async () => {
    const method = await handler({ httpMethod: 'GET', headers: {}, body: '' });
    expect(method.statusCode).toBe(405);

    const missing = await handler(postEvent({}, { 'x-user-api-key': 'k' }));
    expect(missing.statusCode).toBe(400);

    const huge = await handler(postEvent(
      { text: 'x'.repeat(5000), language: 'en' },
      { 'x-user-api-key': 'k' },
    ));
    expect(huge.statusCode).toBe(413);
  });

  test('a technical question yields a bounded structured answer in one call', async () => {
    modelReply('{"shouldAnswer":true,"answer":"Use constructor injection.","language":"en"}');
    const res = await handler(postEvent(
      { text: 'Explain dependency injection.', language: 'en', recentContext: ['previous question'] },
      { 'x-user-api-key': 'user-key' },
    ));
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body);
    expect(payload).toEqual({ shouldAnswer: true, answer: 'Use constructor injection.', language: 'en' });
    // One call decides everything; no classifier round trip.
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
    // #32 contract: the personal key is what the endpoint used.
    expect(mocks.ctorKeys).toEqual(['user-key']);
  });

  test('fails closed on malformed or empty model output', async () => {
    modelReply('Sorry, I cannot help with that.');
    const prose = await handler(postEvent({ text: 'hello', language: 'en' }, { 'x-user-api-key': 'k' }));
    expect(JSON.parse(prose.body)).toEqual({ shouldAnswer: false, answer: '', language: 'en' });

    modelReply('{"shouldAnswer":true,"answer":"","language":"en"}');
    const emptyAnswer = await handler(postEvent({ text: 'hello', language: 'en' }, { 'x-user-api-key': 'k' }));
    expect(JSON.parse(emptyAnswer.body).shouldAnswer).toBe(false);

    modelReply('{ not json at all');
    const broken = await handler(postEvent({ text: 'hello', language: 'en' }, { 'x-user-api-key': 'k' }));
    expect(JSON.parse(broken.body)).toEqual({ shouldAnswer: false, answer: '', language: 'en' });
  });

  test('a non-question never produces an answer', async () => {
    modelReply('{"shouldAnswer":false,"answer":"","language":"en"}');
    const res = await handler(postEvent({ text: 'Okay, thank you.', language: 'en' }, { 'x-user-api-key': 'k' }));
    const payload = JSON.parse(res.body);
    expect(payload.shouldAnswer).toBe(false);
    expect(payload.answer).toBe('');
  });

  test('falls back to the source language when the model omits language', async () => {
    modelReply('{"shouldAnswer":true,"answer":"의존성 주입은 생성자로 받습니다."}');
    const res = await handler(postEvent({ text: '의존성 주입을 설명해 주세요.', language: 'ko' }, { 'x-user-api-key': 'k' }));
    expect(JSON.parse(res.body).language).toBe('ko');
  });

  test('recent context is bounded to the last five turns', async () => {
    modelReply('{"shouldAnswer":true,"answer":"ok","language":"en"}');
    const recentContext = Array.from({ length: 9 }, (_, i) => `turn ${i}`);
    await handler(postEvent({ text: 'What about production?', language: 'en', recentContext }, { 'x-user-api-key': 'k' }));
    const prompt = String(mocks.generateContent.mock.calls[0]?.[0]?.contents?.[0]?.parts?.[0]?.text || '');
    expect(prompt).toContain('turn 8');
    expect(prompt).not.toContain('turn 2\n');
    expect(prompt.split('---').length).toBeLessThanOrEqual(MAX_ANSWER_CONTEXT_TURNS + 1);
  });

  test('server errors surface as a 502 without leaking key material', async () => {
    mocks.generateContent.mockRejectedValue(new Error('provider exploded'));
    const res = await handler(postEvent({ text: 'Explain GC.', language: 'en' }, { 'x-user-api-key': 'secret-value' }));
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('secret-value');
  });
});

describe('#62 buildAnswerRequest', () => {
  test('bounds turns, truncates long ones and normalizes whitespace', () => {
    const request = buildAnswerRequest(
      '  Explain  GC  ',
      ['  earlier  turn  ', 'x'.repeat(900), '', 'a', 'b'],
      'ko',
    );
    expect(request.text).toBe('Explain GC');
    expect(request.language).toBe('ko');
    // The empty turn is dropped and the oversized one is truncated.
    expect(request.recentContext).toHaveLength(4);
    expect(request.recentContext[0]).toBe('earlier turn');
    expect(request.recentContext[1]).toHaveLength(600);
  });

  test('keeps only the most recent turns when the session is long', () => {
    const turns = Array.from({ length: 8 }, (_, i) => `turn ${i}`);
    const request = buildAnswerRequest('What about production?', turns, 'en');
    expect(request.recentContext).toHaveLength(5);
    expect(request.recentContext[0]).toBe('turn 3');
    expect(request.recentContext[4]).toBe('turn 7');
  });

  test('the answer language hint is the source language, never the translation', () => {
    expect(buildAnswerRequest('Hello', [], 'en').language).toBe('en');
    expect(buildAnswerRequest('안녕', [], 'ko').language).toBe('ko');
    expect(buildAnswerRequest('Hello', [], '').language).toBe('en');
  });
});
