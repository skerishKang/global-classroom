// #120 observability at the handler boundary: the trial headers must reach the
// actual translate response, and keyed calls must stay without them.
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  groqCreate: vi.fn(),
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  class GoogleGenAI {
    models = { generateContent: mocks.generateContent };
    constructor(_options: any) {}
  }
  return { ...actual, GoogleGenAI };
});

vi.mock('groq-sdk', () => ({
  default: class Groq {
    chat = { completions: { create: mocks.groqCreate } };
    constructor(_options: any) {}
  },
}));

import { handler } from '../../netlify/functions/translate';
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
} from '../../netlify/functions/_rateLimit';

const DEVICE = 'test-device-token-0001';
const SESSION = 'test-session-token-0001';

const event = (headers: Record<string, string>) => ({
  httpMethod: 'POST',
  headers,
  body: JSON.stringify({ text: 'Hello', from: 'English', to: 'French' }),
});

const trialHeaders = {
  [DEVICE_ID_HEADER]: DEVICE,
  [TRIAL_SESSION_HEADER]: SESSION,
};

beforeEach(() => {
  resetTrialCountersForTests();
  resetRateLimitsForTests();
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.env.GROQ_API_KEY = 'test';
  delete process.env.GEMINI_API_KEY;
  delete process.env.API_KEY;
  mocks.groqCreate.mockReset();
  mocks.groqCreate.mockResolvedValue({ choices: [{ message: { content: 'Bonjour' } }] });
});

describe('#120 trial headers at /translate', () => {
  test('공용 맛보기 번역 성공 응답에 남은 횟수·저장 위치가 실린다', async () => {
    const response: any = await handler(event(trialHeaders));
    expect(response.statusCode).toBe(200);
    expect(response.headers[TRIAL_REMAINING_HEADER]).toBe(String(TRIAL_DEVICE_LIMIT - 1));
    expect(response.headers[TRIAL_STORE_HEADER]).toBe('memory');
  });

  test('개인·반 키 번역 성공 응답에는 맛보기 머리글이 없다', async () => {
    const response: any = await handler(event({ [USER_KEY_HEADER]: 'test-key' }));
    expect(response.statusCode).toBe(200);
    expect(response.headers[TRIAL_REMAINING_HEADER]).toBeUndefined();
    expect(response.headers[TRIAL_STORE_HEADER]).toBeUndefined();
  });

  test('맛보기 소진 429에도 남은 0회·저장 위치가 실린다', async () => {
    const rule = { burstLimit: 500, perMinuteLimit: 500 };
    for (let i = 0; i < TRIAL_DEVICE_LIMIT; i += 1) {
      await enforceAiUsageGate(
        { headers: { ...trialHeaders, [TRIAL_SESSION_HEADER]: `${SESSION}-${i}` } },
        rule,
        'test',
      );
    }
    // Keep the trial counters but clear the burst buckets, so the handler's
    // own 30/min window does not mask the trial-exhausted response.
    resetRateLimitsForTests();
    const response: any = await handler(event(trialHeaders));
    expect(response.statusCode).toBe(429);
    expect(response.headers[TRIAL_REMAINING_HEADER]).toBe('0');
    expect(response.headers[TRIAL_STORE_HEADER]).toBe('memory');
  });
});
