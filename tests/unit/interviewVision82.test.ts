import { beforeEach, describe, expect, test, vi } from 'vitest';

const fake = vi.hoisted(() => ({ generate: vi.fn(), groq: vi.fn() }));
vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return { ...actual, GoogleGenAI: class {
    models = { generateContent: fake.generate };
  } };
});

vi.mock('groq-sdk', () => ({ default: class Groq {
  chat = { completions: { create: fake.groq } };
} }));

import { handler, parseVisionResult, VISION_MODEL_ORDER } from '../../netlify/functions/vision';

const jpeg = '/9j/2Q==';
const event = (body: object) => ({
  httpMethod: 'POST', headers: {}, body: JSON.stringify(body),
});
const parse = (r: { statusCode: number; body: string }) => ({
  status: r.statusCode, json: JSON.parse(r.body),
});

beforeEach(() => {
  fake.generate.mockReset();
  fake.groq.mockReset();
  delete process.env.GROQ_API_KEY;
  process.env.GEMINI_API_KEY = 'mock-key';
});

describe('#82 Interview image OCR/model contract', () => {
  test('prioritizes image-capable Flash-Lite then Gemma 31B / 26B', () => {
    expect(VISION_MODEL_ORDER).toEqual([
      'gemini-3.5-flash-lite', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it',
    ]);
  });
  test('reads interview image only; preserved model prompt and source text', async () => {
    fake.generate.mockResolvedValue({ text: JSON.stringify({
      originalText: 'What does this code do?', translatedText: '',
    }) });
    const r = parse(await handler(event({
      base64Image: jpeg, langA: 'auto', langB: 'en', extractOnly: true,
    })));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ originalText: 'What does this code do?', translatedText: '' });
    const request = fake.generate.mock.calls[0][0];
    expect(request.model).toBe('gemini-3.5-flash-lite');
    expect(request.contents[0].parts[0].inlineData.mimeType).toBe('image/jpeg');
    expect(request.contents[0].parts[0].inlineData.data).toBe(jpeg);
    expect(JSON.stringify(request.contents)).toContain('Transcribe ALL legible');
    expect(request.config.responseMimeType).toBe('application/json');
  });
  test('fallback to Gemma 31B, then Gemma 26B on provider errors', async () => {
    fake.generate.mockRejectedValueOnce(new Error('429'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce({ text: '```json\n{"originalText":"y=x^2","translatedText":""}\n```' });
    const r = parse(await handler(event({
      base64Image: jpeg, langA: 'ko', langB: 'en', extractOnly: true,
    })));
    expect(r.status).toBe(200);
    expect(r.json.originalText).toBe('y=x^2');
    expect(fake.generate.mock.calls.map(([a]) => a.model)).toEqual([
      'gemini-3.5-flash-lite', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it',
    ]);
    expect(fake.generate.mock.calls[2][0].config).toBeUndefined();
  });
  test('exhausted Google models fall back to existing Groq vision Qwen', async () => {
    fake.generate.mockRejectedValue(new Error('429 rate limited'));
    fake.groq.mockResolvedValueOnce({ choices: [{
      message: { content: '{"originalText":"What is this chart?","translatedText":""}' },
    }] });
    process.env.GROQ_API_KEY = 'existing-key';
    const r = parse(await handler(event({
      base64Image: jpeg, langA: 'auto', langB: 'ko', extractOnly: true,
    })));
    expect(r.status).toBe(200);
    expect(r.json.originalText).toBe('What is this chart?');
    const request = fake.groq.mock.calls[0][0];
    expect(request.model).toBe('qwen/qwen3.8-27b');
    expect(request.messages[0].content[1].image_url.url).toBe('data:image/jpeg;base64,' + jpeg);
    expect(request.response_format).toEqual({ type: 'json_object' });
    delete process.env.GROQ_API_KEY;
  });

  test('classroom photo still asks for both OCR and translation', async () => {
    fake.generate.mockResolvedValue({ text: '{"originalText":"hello","translatedText":"안녕하세요"}' });
    const r = parse(await handler(event({
      base64Image: jpeg, langA: 'en', langB: 'ko',
    })));
    expect(r.status).toBe(200);
    expect(r.json.translatedText).toBe('안녕하세요');
    expect(JSON.stringify(fake.generate.mock.calls[0][0].contents)).toContain('translate');
  });
  test('no-text image reports empty extraction without inventing a question', async () => {
    fake.generate.mockResolvedValue({ text: '{"originalText":"","translatedText":""}' });
    const r = parse(await handler(event({
      base64Image: jpeg, langA: 'auto', langB: 'ko', extractOnly: true,
    })));
    expect(r.status).toBe(200);
    expect(r.json.originalText).toBe('');
  });
  test('malformed JPEG, unsupported model and oversized image rejected before AI', async () => {
    expect((await handler(event({
      base64Image: 'QUJD', langA: 'ko', langB: 'en',
    }))).statusCode).toBe(400);
    expect((await handler(event({
      base64Image: jpeg, langA: 'ko', langB: 'en', model: 'not-allowed',
    }))).statusCode).toBe(400);
    expect((await handler(event({
      base64Image: 'A'.repeat(4 * 1024 * 1024 + 4), langA: 'ko', langB: 'en',
    }))).statusCode).toBe(413);
    expect(fake.generate).not.toHaveBeenCalled();
  });
  test('JSON parses only complete valid fields', () => {
    expect(parseVisionResult('text')).toBeNull();
    expect(parseVisionResult('{"translation":"x"}')).toBeNull();
    expect(parseVisionResult('{"originalText":"Hi!"}')).toEqual({
      originalText: 'Hi!', translatedText: '',
    });
  });
});
