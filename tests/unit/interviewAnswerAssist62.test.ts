import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Provider stubs: #62 tests only exercise routing, prompt shaping, response
// validation and fail-closed handling. No live provider call is ever made.
const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  groqCreate: vi.fn(),
  ctorKeys: [] as string[],
  groqCtorKeys: [] as string[],
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

vi.mock('groq-sdk', () => {
  class Groq {
    chat = { completions: { create: mocks.groqCreate } };
    constructor(options: { apiKey?: string }) {
      mocks.groqCtorKeys.push(options?.apiKey || '');
    }
  }
  return { default: Groq };
});

import { handler, parseAnswerPayload, ANSWER_PRIMARY_MODEL } from '../../netlify/functions/interview-answer';
import {
  buildAnswerRequest,
  isAnswerTranslationFresh,
  planAnswerTranslation,
  resolveAnswerLanguage,
  resolveAnswerTranslationTarget,
  MAX_ANSWER_CONTEXT_TURNS,
} from '../../utils/interviewAnswer';

const postEvent = (body: unknown, headers: Record<string, string> = {}, method = 'POST') => ({
  httpMethod: method,
  headers,
  body: JSON.stringify(body),
});

const groqReply = (text: string) => {
  mocks.groqCreate.mockResolvedValueOnce({ choices: [{ message: { content: text } }] });
};

const googleReply = (text: string) => {
  mocks.generateContent.mockResolvedValueOnce({ text });
};

const promptOf = (call = 0) => String(
  mocks.groqCreate.mock.calls[call]?.[0]?.messages?.[0]?.content
  || mocks.generateContent.mock.calls[call]?.[0]?.contents?.[0]?.parts?.[0]?.text
  || '',
);

beforeEach(() => {
  mocks.generateContent.mockReset();
  mocks.groqCreate.mockReset();
  mocks.ctorKeys.length = 0;
  mocks.groqCtorKeys.length = 0;
  delete process.env.GEMINI_API_KEY;
  delete process.env.API_KEY;
  // Production shape: Groq is configured and is the primary answer route.
  process.env.GROQ_API_KEY = 'grok-server-key';
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
      { text: 'x'.repeat(5000), answerLanguage: 'en' },
      { 'x-user-api-key': 'k' },
    ));
    expect(huge.statusCode).toBe(413);
  });

  test('answers in the finalized source language without switching to output language (#70/#76)', async () => {
    // English question, English source-language answer.
    groqReply('{"shouldAnswer":true,"answer":"Pass dependencies through the constructor."}');
    const englishQuestion = await handler(postEvent(
      {
        text: 'Explain dependency injection.',
        answerLanguage: 'en',
        answerLanguageName: 'English',
        sourceLanguage: 'en',
      },
      { 'x-user-api-key': 'user-key' },
    ));
    expect(englishQuestion.statusCode).toBe(200);
    expect(JSON.parse(englishQuestion.body)).toEqual({
      shouldAnswer: true,
      answer: 'Pass dependencies through the constructor.',
      language: 'en',
    });
    // The prompt preserves the source language and includes behavioral questions.
    const prompt = promptOf();
    expect(prompt).toContain('English (en)');
    expect(prompt).toContain('personal strengths');
    expect(prompt).toContain('shouldAnswer=true');

    // Korean question, Korean source-language answer.
    groqReply('{"shouldAnswer":true,"answer":"의존성은 생성자로 주입합니다."}');
    const koreanQuestion = await handler(postEvent(
      {
        text: '의존성 주입을 설명해 주세요.',
        answerLanguage: 'ko',
        answerLanguageName: '한국어 (Korean)',
        sourceLanguage: 'ko',
      },
      { 'x-user-api-key': 'user-key' },
    ));
    expect(JSON.parse(koreanQuestion.body).language).toBe('ko');
  });

  test('#80 answers are short, speakable and conversational, not textbook-style', async () => {
    groqReply('{"shouldAnswer":true,"answer":"I\'d use isotonic when the validation set is large, but it can overfit on noisy data."}');
    const result = await handler(postEvent(
      {
        text: 'When would you prefer isotonic regression over Platt scaling for calibration, and what overfitting risk does isotonic introduce?',
        answerLanguage: 'en',
        answerLanguageName: 'English',
        sourceLanguage: 'en',
      },
      { 'x-user-api-key': 'user-key' },
    ));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).shouldAnswer).toBe(true);
    const prompt = promptOf();
    expect(prompt).toContain('LIVE SPOKEN INTERVIEW CUE, NOT a textbook or essay');
    expect(prompt).toContain('2 SHORT sentences');
    expect(prompt).toContain('25–55 English words');
    expect(prompt).toContain('at most one practical check');
    expect(prompt).toContain('1–2 short conversational sentences');
    expect(prompt).toContain('read this aloud comfortably');
    expect(prompt).toContain('Never invent personal experiences');
    expect(prompt).toContain('separate holdout set');
    expect(prompt).toContain('When would you prefer isotonic regression');
    expect(mocks.groqCreate.mock.calls[0][0].model).toBe('openai/gpt-oss-20b');
  });

  test('#78 substantive statements request a contextual opinion instead of silent suppression', async () => {
    groqReply('{"shouldAnswer":true,"answer":"That practical certification approach makes sense."}');
    const response = await handler(postEvent(
      {
        text: 'Mercor Academy awards certification after completing projects.',
        answerLanguage: 'en',
        sourceLanguage: 'en',
        recentContext: ['Mercor training is free and self-paced.'],
      },
      { 'x-user-api-key': 'k' },
    ));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ shouldAnswer: true, language: 'en' });
    expect(promptOf()).toContain('substantive statement');
    expect(promptOf()).toContain('short, relevant conversational reaction');
    expect(promptOf()).toContain('Mercor training is free and self-paced.');
    expect(promptOf()).toContain('Mercor Academy awards certification');
  });

  test('the answer language is the endpoint contract, not a model choice', async () => {
    // A model that reports its own language cannot move the answer off the
    // requested output language.
    groqReply('{"shouldAnswer":true,"answer":"answer text","language":"en"}');
    const res = await handler(postEvent(
      { text: 'Explain GC.', answerLanguage: 'ko', sourceLanguage: 'en' },
      { 'x-user-api-key': 'k' },
    ));
    expect(JSON.parse(res.body).language).toBe('ko');

    // A missing answerLanguage still answers deterministically.
    groqReply('{"shouldAnswer":true,"answer":"answer text"}');
    const defaulted = await handler(postEvent({ text: 'Explain GC.' }, { 'x-user-api-key': 'k' }));
    expect(JSON.parse(defaulted.body).language).toBe('en');
  });

  test('region tags are reduced to the base answer language', async () => {
    groqReply('{"shouldAnswer":true,"answer":"ok"}');
    const res = await handler(postEvent(
      { text: 'Explain GC.', answerLanguage: 'ko-KR', sourceLanguage: 'en-US' },
      { 'x-user-api-key': 'k' },
    ));
    expect(JSON.parse(res.body).language).toBe('ko');
    expect(promptOf()).toContain('(ko)');
  });

  test('the primary answer model is the same speed-first model as translation', async () => {
    groqReply('{"shouldAnswer":true,"answer":"ok"}');
    await handler(postEvent(
      { text: 'Explain GC.', answerLanguage: 'ko' },
      { 'x-user-api-key': 'k' },
    ));
    expect(ANSWER_PRIMARY_MODEL).toBe('openai/gpt-oss-20b');
    expect(mocks.groqCreate.mock.calls[0]?.[0]?.model).toBe('openai/gpt-oss-20b');
    // Low reasoning effort + hidden reasoning, matching translate.ts.
    expect(mocks.groqCreate.mock.calls[0]?.[0]?.reasoning_effort).toBe('low');
    expect(mocks.groqCreate.mock.calls[0]?.[0]?.reasoning_format).toBe('hidden');
    // The personal key is a Google credential: Groq must not receive it.
    expect(mocks.groqCtorKeys).toEqual(['grok-server-key']);
    expect(mocks.ctorKeys).toEqual([]);
  });

  test('falls back through the speed-first route when Groq is unavailable', async () => {
    // No Groq key configured at all: the Google family takes over directly.
    delete process.env.GROQ_API_KEY;
    googleReply('{"shouldAnswer":true,"answer":"ok"}');
    await handler(postEvent({ text: 'Explain GC.', answerLanguage: 'ko' }, { 'x-user-api-key': 'k' }));
    expect(mocks.groqCreate).not.toHaveBeenCalled();
    expect(mocks.ctorKeys).toEqual(['k']);
  });

  test('a failing primary model falls through to the next route', async () => {
    mocks.groqCreate.mockRejectedValueOnce(new Error('rate limited'));
    googleReply('{"shouldAnswer":true,"answer":"ok"}');
    const res = await handler(postEvent(
      { text: 'Explain GC.', answerLanguage: 'ko' },
      { 'x-user-api-key': 'k' },
    ));
    expect(res.statusCode).toBe(200);
    expect(mocks.groqCreate.mock.calls[1]?.[0]?.model).toBe('openai/gpt-oss-120b');
    expect(mocks.generateContent.mock.calls[0]?.[0]?.model).toBe('gemma-4-26b-a4b-it');
  });

  test('fails closed on malformed or empty model output', async () => {
    groqReply('Sorry, I cannot help with that.');
    const prose = await handler(postEvent(
      { text: 'hello', answerLanguage: 'ko' },
      { 'x-user-api-key': 'k' },
    ));
    expect(JSON.parse(prose.body)).toEqual({ shouldAnswer: false, answer: '', language: 'ko' });

    groqReply('{"shouldAnswer":true,"answer":"","language":"ko"}');
    const emptyAnswer = await handler(postEvent(
      { text: 'hello', answerLanguage: 'ko' },
      { 'x-user-api-key': 'k' },
    ));
    expect(JSON.parse(emptyAnswer.body).shouldAnswer).toBe(false);

    groqReply('{ not json at all');
    const broken = await handler(postEvent(
      { text: 'hello', answerLanguage: 'ko' },
      { 'x-user-api-key': 'k' },
    ));
    expect(JSON.parse(broken.body)).toEqual({ shouldAnswer: false, answer: '', language: 'ko' });

    groqReply('');
    const emptyRaw = await handler(postEvent(
      { text: 'hello', answerLanguage: 'ko' },
      { 'x-user-api-key': 'k' },
    ));
    expect(emptyRaw.statusCode).toBe(502);
  });

  test('a non-question never produces an answer', async () => {
    groqReply('{"shouldAnswer":false,"answer":""}');
    const res = await handler(postEvent(
      { text: 'Okay, thank you.', answerLanguage: 'ko' },
      { 'x-user-api-key': 'k' },
    ));
    const payload = JSON.parse(res.body);
    expect(payload.shouldAnswer).toBe(false);
    expect(payload.answer).toBe('');
  });

  test('the parser itself fails closed to the requested language', () => {
    expect(parseAnswerPayload('{"shouldAnswer":true,"answer":"ok","language":"en"}', 'ko').language).toBe('ko');
    expect(parseAnswerPayload('{"shouldAnswer":true}', 'ko')).toEqual({ shouldAnswer: false, answer: '', language: 'ko' });
    expect(parseAnswerPayload('', 'ko')).toEqual({ shouldAnswer: false, answer: '', language: 'ko' });
  });

  test('recent context is bounded to the last five turns', async () => {
    groqReply('{"shouldAnswer":true,"answer":"ok"}');
    const recentContext = Array.from({ length: 9 }, (_, i) => `turn ${i}`);
    await handler(postEvent(
      { text: 'What about production?', answerLanguage: 'en', recentContext },
      { 'x-user-api-key': 'k' },
    ));
    const prompt = promptOf();
    expect(prompt).toContain('turn 8');
    expect(prompt).not.toContain('turn 2\n');
    expect(prompt.split('---').length).toBeLessThanOrEqual(MAX_ANSWER_CONTEXT_TURNS + 1);
  });

  test('server errors surface as a 502 without leaking key material', async () => {
    process.env.GROQ_API_KEY = 'gsk_server_secret_value';
    mocks.groqCreate.mockRejectedValue(new Error('provider exploded'));
    const res = await handler(postEvent(
      { text: 'Explain GC.', answerLanguage: 'en' },
      { 'x-user-api-key': 'secret-value' },
    ));
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('secret-value');
    expect(res.body).not.toContain('gsk_server_secret_value');
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
    expect(request.answerLanguage).toBe('ko');
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

  test('the answer language is the output language and never the source language', () => {
    const englishQuestionKoreanOutput = buildAnswerRequest('Hello', [], 'ko', {
      answerLanguageName: '한국어 (Korean)',
      sourceLanguage: 'en',
    });
    expect(englishQuestionKoreanOutput.answerLanguage).toBe('ko');
    expect(englishQuestionKoreanOutput.answerLanguageName).toBe('한국어 (Korean)');
    expect(englishQuestionKoreanOutput.sourceLanguage).toBe('en');

    const koreanQuestionEnglishOutput = buildAnswerRequest('안녕', [], 'en', { sourceLanguage: 'ko' });
    expect(koreanQuestionEnglishOutput.answerLanguage).toBe('en');
    expect(koreanQuestionEnglishOutput.sourceLanguage).toBe('ko');

    // Output language is required and canonical; a region tag collapses.
    expect(buildAnswerRequest('Hello', [], '').answerLanguage).toBe('en');
    expect(buildAnswerRequest('Hello', [], 'ko-KR').answerLanguage).toBe('ko');
  });

  test('generation needs no translation: the payload carries only transcript, languages and context', () => {
    const request = buildAnswerRequest('Explain GC.', ['earlier'], 'ko', { sourceLanguage: 'en' });
    expect(Object.keys(request).sort()).toEqual(
      ['answerLanguage', 'answerLanguageName', 'recentContext', 'sourceLanguage', 'text'].sort(),
    );
    // No translated answer/translation text is requested: the answer starts
    // from the finalized transcript alone.
    expect(JSON.stringify(request)).not.toContain('translated');
  });
});

describe('#70 answer language resolution', () => {
  test('the finalized source language is the answer language', () => {
    expect(resolveAnswerLanguage('ko', ['ko', 'en'], 'en')).toBe('en');
    expect(resolveAnswerLanguage('en', ['ko', 'en'], 'ko')).toBe('ko');
  });

  test('falls back to the active target only when source identity is unavailable', () => {
    expect(resolveAnswerLanguage('ko', ['ko', 'en'], '')).toBe('ko');
    expect(resolveAnswerLanguage('', ['vi', 'en'], '')).toBe('vi');
    expect(resolveAnswerLanguage('', ['auto', 'vi'], '')).toBe('vi');
    expect(resolveAnswerLanguage('', [], '')).toBe('en');
  });
});

describe('#70 automatic answer translation policy', () => {
  const answerState = {
    suggestedAnswer: 'Inject dependencies through the constructor.',
    answerLanguage: 'en',
    activeTarget: 'ko',
  };

  test('the active question-translation target is the answer translation target', () => {
    expect(planAnswerTranslation(answerState)).toEqual({ kind: 'request', targetLanguage: 'ko' });

    const cached = {
      ...answerState,
      answerTranslation: 'translated answer',
      answerTranslationLanguage: 'ko',
      answerTranslationSource: answerState.suggestedAnswer,
      answerTranslationStatus: 'ready' as const,
      answerTranslationVisible: true,
    };
    expect(planAnswerTranslation(cached)).toEqual({ kind: 'hide' });
    expect(planAnswerTranslation({ ...cached, answerTranslationVisible: false })).toEqual({ kind: 'show' });
    expect(isAnswerTranslationFresh(cached, cached.suggestedAnswer, 'ko')).toBe(true);
  });

  test('changing the answer or active target invalidates the cached translation', () => {
    const cached = {
      ...answerState,
      answerTranslation: 'translated answer',
      answerTranslationLanguage: 'ko',
      answerTranslationSource: answerState.suggestedAnswer,
      answerTranslationStatus: 'ready' as const,
      answerTranslationVisible: true,
    };

    expect(planAnswerTranslation({ ...cached, suggestedAnswer: 'A new answer.' }))
      .toEqual({ kind: 'request', targetLanguage: 'ko' });
    expect(planAnswerTranslation({ ...cached, activeTarget: 'vi' }))
      .toEqual({ kind: 'request', targetLanguage: 'vi' });
    expect(isAnswerTranslationFresh(cached, cached.suggestedAnswer, 'vi')).toBe(false);
  });

  test('no answer, same-language target, missing target, or in-flight request means no request', () => {
    expect(planAnswerTranslation({ ...answerState, suggestedAnswer: '' })).toEqual({ kind: 'ignore' });
    expect(planAnswerTranslation({ ...answerState, activeTarget: 'en' })).toEqual({ kind: 'ignore' });
    expect(planAnswerTranslation({ ...answerState, activeTarget: '' })).toEqual({ kind: 'ignore' });
    expect(planAnswerTranslation({ ...answerState, answerTranslationStatus: 'loading' }))
      .toEqual({ kind: 'ignore' });
  });

  test('a failed translation may be retried', () => {
    expect(planAnswerTranslation({ ...answerState, answerTranslationStatus: 'error' }))
      .toEqual({ kind: 'request', targetLanguage: 'ko' });
  });

  test('translation target is the active target, not the source-side language', () => {
    expect(resolveAnswerTranslationTarget('en', 'ko')).toBe('ko');
    expect(resolveAnswerTranslationTarget('ko', 'en-US')).toBe('en');
    expect(resolveAnswerTranslationTarget('ko', 'ko')).toBe('');
    expect(resolveAnswerTranslationTarget('', 'en')).toBe('');
  });
});
