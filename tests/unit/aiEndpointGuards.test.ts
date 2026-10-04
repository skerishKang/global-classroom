import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Provider stubs: #36 tests only exercise validation and request shaping.
// No live provider call is ever made.
const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  authTokensCreate: vi.fn(),
  groqCreate: vi.fn(),
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  class GoogleGenAI {
    models = { generateContent: mocks.generateContent };
    authTokens = { create: mocks.authTokensCreate };
  }
  return { ...actual, GoogleGenAI };
});

vi.mock('groq-sdk', () => ({
  default: class Groq {
    chat = { completions: { create: mocks.groqCreate } };
  },
}));

import { MODEL_LIVE, MODEL_TTS, MODEL_VISION } from '../../constants';
import {
  ALLOWED_LIVE_MODELS,
  ALLOWED_TTS_MODELS,
  ALLOWED_VISION_MODELS,
  MAX_DETECT_TEXT_CHARS,
  MAX_LIVE_TOKEN_BODY_BYTES,
  MAX_SUMMARY_TEXT_CHARS,
  MAX_TRANSLATE_TEXT_CHARS,
  MAX_TTS_TEXT_CHARS,
  MAX_VISION_IMAGE_BYTES,
  redactSecrets,
} from '../../netlify/functions/_aiGuards';
import { handler as detectHandler } from '../../netlify/functions/detect-language';
import { handler as liveTokenHandler } from '../../netlify/functions/live-token';
import { handler as summarizeHandler } from '../../netlify/functions/summarize';
import { handler as translateHandler } from '../../netlify/functions/translate';
import { handler as ttsHandler } from '../../netlify/functions/tts';
import { handler as visionHandler } from '../../netlify/functions/vision';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

type HandlerResponse = { statusCode: number; headers: Record<string, string>; body: string };
type Handler = (event: any) => Promise<HandlerResponse>;

const makeEvent = (body: unknown, raw?: string) => ({
  httpMethod: 'POST',
  headers: {} as Record<string, string>,
  body: raw !== undefined ? raw : JSON.stringify(body),
});

const parseResponse = (response: HandlerResponse) => ({
  statusCode: response.statusCode,
  json: JSON.parse(response.body || '{}'),
});

const readSource = (relativePath: string): string =>
  readFileSync(path.join(ROOT, relativePath), 'utf8');

const repeat = (length: number): string => 'a'.repeat(length);

beforeEach(() => {
  vi.clearAllMocks();
  // Fake env key: providers are stubbed, so this never leaves the process.
  process.env.GEMINI_API_KEY = 'test-env-key';
  delete process.env.API_KEY;
  delete process.env.GROQ_API_KEY;
  mocks.generateContent.mockResolvedValue({ text: 'ok' });
  mocks.authTokensCreate.mockResolvedValue({ name: 'auth_tokens/test-token' });
});

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
});

describe('#36 summarize runtime API', () => {
  test('uses ai.models.generateContent (current SDK) and returns { summary }', async () => {
    mocks.generateContent.mockResolvedValue({ text: '## 📝 Summary\n- point one' });
    const res = parseResponse(
      await summarizeHandler(makeEvent({ history: 'Hello\n안녕하세요', lang: 'ko' })),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json.summary).toBe('## 📝 Summary\n- point one');
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
    const request = mocks.generateContent.mock.calls[0][0];
    expect(request.model).toBe('gemini-2.5-flash-lite');
    expect(JSON.stringify(request.contents)).toContain('Hello');
  });

  test('falls back to the second model when the first fails', async () => {
    mocks.generateContent
      .mockRejectedValueOnce(new Error('model unavailable'))
      .mockResolvedValueOnce({ text: 'fallback summary' });
    const res = parseResponse(await summarizeHandler(makeEvent({ history: 'hi' })));
    expect(res.statusCode).toBe(200);
    expect(res.json.summary).toBe('fallback summary');
    expect(mocks.generateContent).toHaveBeenCalledTimes(2);
    expect(mocks.generateContent.mock.calls[1][0].model).toBe('gemini-2.0-flash');
  });

  test('source no longer contains the legacy getGenerativeModel shape', () => {
    const source = readSource('netlify/functions/summarize.ts');
    expect(source).not.toContain('getGenerativeModel');
    expect(source).not.toContain('as any');
  });

  test('oversized history is rejected (413) before any provider call', async () => {
    const res = parseResponse(
      await summarizeHandler(makeEvent({ history: repeat(MAX_SUMMARY_TEXT_CHARS + 1) })),
    );
    expect(res.statusCode).toBe(413);
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });
});

describe('#36 input size limits', () => {
  test('oversized translate is rejected before any provider call', async () => {
    const res = parseResponse(
      await translateHandler(
        makeEvent({ text: repeat(MAX_TRANSLATE_TEXT_CHARS + 1), from: 'Korean', to: 'English' }),
      ),
    );
    expect(res.statusCode).toBe(413);
    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(mocks.groqCreate).not.toHaveBeenCalled();
  });

  test('oversized detect-language is rejected before any provider call', async () => {
    const res = parseResponse(
      await detectHandler(makeEvent({ text: repeat(MAX_DETECT_TEXT_CHARS + 1) })),
    );
    expect(res.statusCode).toBe(413);
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  test('oversized tts is rejected before any provider call', async () => {
    const res = parseResponse(
      await ttsHandler(makeEvent({ text: repeat(MAX_TTS_TEXT_CHARS + 1), model: MODEL_TTS })),
    );
    expect(res.statusCode).toBe(413);
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  test('oversized vision image is rejected by decoded bytes before any provider call', async () => {
    const base64Image = Buffer.alloc(MAX_VISION_IMAGE_BYTES + 1, 7).toString('base64');
    const res = parseResponse(
      await visionHandler(makeEvent({ base64Image, langA: 'ko', langB: 'en', model: MODEL_VISION })),
    );
    expect(res.statusCode).toBe(413);
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  test('oversized live-token body is rejected before any provider call', async () => {
    const raw = `{"model":"${'x'.repeat(MAX_LIVE_TOKEN_BODY_BYTES + 1)}"}`;
    const res = parseResponse(await liveTokenHandler(makeEvent(null, raw)));
    expect(res.statusCode).toBe(413);
    expect(mocks.authTokensCreate).not.toHaveBeenCalled();
  });
});

describe('#36 model allowlists', () => {
  test('allowlists cover exactly the models this repo uses', () => {
    expect(ALLOWED_TTS_MODELS).toContain(MODEL_TTS);
    expect(ALLOWED_VISION_MODELS).toContain(MODEL_VISION);
    expect(ALLOWED_LIVE_MODELS).toContain(MODEL_LIVE);
    expect(ALLOWED_LIVE_MODELS).toContain('gemini-3.5-transcribe-live');
    expect(ALLOWED_LIVE_MODELS).toContain('gemini-3.5-live-translate-preview');
  });

  test('unsupported tts model is rejected before any provider call', async () => {
    const res = parseResponse(await ttsHandler(makeEvent({ text: 'hello', model: 'evil-model' })));
    expect(res.statusCode).toBe(400);
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  test('unsupported vision model is rejected before any provider call', async () => {
    const res = parseResponse(
      await visionHandler(
        makeEvent({ base64Image: 'QUJD', langA: 'ko', langB: 'en', model: 'evil-model' }),
      ),
    );
    expect(res.statusCode).toBe(400);
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  test('allowed tts model passes validation and is forwarded to the provider', async () => {
    mocks.generateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ inlineData: { data: 'QUJD' } }] } }],
    });
    const res = parseResponse(
      await ttsHandler(makeEvent({ text: 'hello', voiceName: 'Kore', model: MODEL_TTS })),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json.audioBase64).toBe('QUJD');
    expect(mocks.generateContent.mock.calls[0][0].model).toBe(MODEL_TTS);
  });

  test('allowed vision model passes validation and is forwarded to the provider', async () => {
    mocks.generateContent.mockResolvedValue({
      text: JSON.stringify({ originalText: 'a', translatedText: 'b' }),
    });
    const res = parseResponse(
      await visionHandler(
        makeEvent({ base64Image: 'QUJD', langA: 'ko', langB: 'en', model: MODEL_VISION }),
      ),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json).toEqual({ originalText: 'a', translatedText: 'b' });
    expect(mocks.generateContent.mock.calls[0][0].model).toBe(MODEL_VISION);
  });

  test('translate ignores any caller-provided model and uses the server pool', async () => {
    mocks.generateContent.mockResolvedValue({ text: 'translated' });
    const res = parseResponse(
      await translateHandler(
        makeEvent({ text: 'Hello', from: 'English', to: 'French', model: 'evil-model' }),
      ),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json.translated).toBe('translated');
    expect(mocks.generateContent.mock.calls[0][0].model).toBe('gemma-4-26b-a4b-it');
  });
});

describe('#36 live token model binding', () => {
  test.each([MODEL_LIVE, 'gemini-3.5-transcribe-live', 'gemini-3.5-live-translate-preview'])(
    'allowed model %s receives a token bound via liveConnectConstraints',
    async (model) => {
      const res = parseResponse(await liveTokenHandler(makeEvent({ model })));
      expect(res.statusCode).toBe(200);
      expect(res.json.token).toBe('auth_tokens/test-token');
      expect(mocks.authTokensCreate).toHaveBeenCalledTimes(1);
      const config = mocks.authTokensCreate.mock.calls[0][0].config;
      expect(config.liveConnectConstraints).toEqual({ model });
    },
  );

  test('unsupported live model is rejected before any token request', async () => {
    const res = parseResponse(await liveTokenHandler(makeEvent({ model: 'gemini-ultra-evil' })));
    expect(res.statusCode).toBe(400);
    expect(mocks.authTokensCreate).not.toHaveBeenCalled();
  });

  test('missing live model is rejected (no unbound token)', async () => {
    const res = parseResponse(await liveTokenHandler(makeEvent({})));
    expect(res.statusCode).toBe(400);
    expect(mocks.authTokensCreate).not.toHaveBeenCalled();
  });

  test('anonymous request (no x-user-api-key header) still works with env key', async () => {
    const res = parseResponse(await liveTokenHandler(makeEvent({ model: MODEL_LIVE })));
    expect(res.statusCode).toBe(200);
  });
});

describe('#36 malformed JSON policy', () => {
  const endpoints: Array<[string, Handler]> = [
    ['translate', translateHandler],
    ['detect-language', detectHandler],
    ['summarize', summarizeHandler],
    ['tts', ttsHandler],
    ['vision', visionHandler],
    ['live-token', liveTokenHandler],
  ];

  test.each(endpoints)('%s rejects malformed JSON with an explicit 400', async (_name, handler) => {
    const res = parseResponse(await handler(makeEvent(null, '{not-json')));
    expect(res.statusCode).toBe(400);
    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(mocks.authTokensCreate).not.toHaveBeenCalled();
  });
});

describe('#36 secret redaction', () => {
  test('credential-like strings are redacted while rate-limit info survives', () => {
    expect(redactSecrets('key AIzaSyD-1234567890abcdefghijklmnopqrstuv failed')).not.toContain('AIzaSyD-1234567890');
    expect(redactSecrets('token gsk_abcdefghijklmnopqrstuvwxyz123')).not.toContain('gsk_abcdefghij');
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop')).not.toContain('Bearer abcdefghijklmnop');
    expect(redactSecrets('429 RESOURCE_EXHAUSTED')).toContain('429');
  });
});
