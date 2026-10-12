import { GoogleGenAI, Type } from '@google/genai';
import {
  enforceTextLimit,
  readJsonBody,
  safeErrorDetail,
  MAX_DETECT_TEXT_CHARS,
} from './_aiGuards';

const SUPPORTED_CODES = ['ko', 'en', 'ja', 'zh', 'vi', 'es', 'fr', 'de', 'ru', 'th', 'id', 'ar', 'hi', 'tl', 'mn', 'uz'] as const;
type SupportedCode = (typeof SUPPORTED_CODES)[number];

// Detector pool (#85, owner-selected 2026-10-12): a latency/cost-appropriate
// subset of the approved product model catalog.
//
// The retired detector-only routes are gone. Gemini 2.5 Flash-Lite, Gemini 2.0
// Flash, Llama 3.3 70B Versatile and Llama 3.1 8B Instant are not part of the
// approved catalog, the 70B route answered 404 model_not_found in production,
// and the loop stopped there instead of falling through to the next candidate.
const DETECT_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
];

// The Google SDK requires a request timeout of at least 10 seconds (#36).
const DETECT_MODEL_TIMEOUT_MS = 10_000;

// Hard stop for the whole detector. Two candidates bound the worst case at
// ~20s, which stays below the platform limit that produced #84's 504.
const DETECT_TOTAL_BUDGET_MS = 18_000;

/**
 * #85: a detector answer is usable only when the model returned both a
 * supported language code and a numeric confidence. Empty text, broken JSON, an
 * unsupported code or a missing confidence is a model failure - mapping those to
 * `en` reports a wrong language as a success and stops the fallback.
 */
const parseDetectedLanguage = (
  raw: string | undefined,
): { code: SupportedCode; confidence: number } | null => {
  if (!raw) return null;

  let parsed: any = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!SUPPORTED_CODES.includes(parsed?.code)) return null;
  if (typeof parsed?.confidence !== 'number' || !Number.isFinite(parsed.confidence)) return null;

  return {
    code: parsed.code as SupportedCode,
    confidence: Math.min(1, Math.max(0, parsed.confidence)),
  };
};

export const handler = async (event: any) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '허용되지 않은 메서드입니다.' }),
    };
  }

  const userApiKey = event.headers['x-user-api-key'];
  const geminiApiKey = userApiKey || process.env.GEMINI_API_KEY || process.env.API_KEY;
  // #85: the detector pool is Google-only, so a Google credential is required.
  if (!geminiApiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'API 키가 설정되지 않았습니다.' }),
    };
  }

  // 요청 본문 파싱
  // Malformed JSON is an explicit 400 before any provider call (#36).
  const parsedBody = readJsonBody(event);
  if (parsedBody.ok === false) return parsedBody.response;
  const body = parsedBody.body;

  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '필수 값(text)이 누락되었습니다.' }),
    };
  }

  const oversize = enforceTextLimit(text, MAX_DETECT_TEXT_CHARS, 'text');
  if (oversize) return oversize;

  const prompt = `Detect the language of the following text.
Return JSON only: {"code": "xx", "confidence": 0.95}
Rules:
- code must be one of: ${SUPPORTED_CODES.join(', ')}
- confidence must be a number between 0 and 1.
Text: ${JSON.stringify(text)}`;

  const startedAt = Date.now();
  let lastFailure: any = null;
  // The Google SDK takes its request timeout on the client and requires at least
  // 10 seconds. Binding it here keeps one stalled model from eating the whole
  // detector budget (#85).
  const ai = new GoogleGenAI({
    apiKey: geminiApiKey,
    httpOptions: { timeout: DETECT_MODEL_TIMEOUT_MS, retryOptions: { attempts: 1 } },
  });

  for (const model of DETECT_MODELS) {
    // #85: never start a candidate that cannot finish inside the total budget.
    if (Date.now() - startedAt >= DETECT_TOTAL_BUDGET_MS) {
      console.error(`detect-language: total budget exhausted before ${model}`);
      break;
    }

    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              code: { type: Type.STRING },
              confidence: { type: Type.NUMBER },
            },
            required: ['code', 'confidence'],
          },
        },
      });

      const detected = parseDetectedLanguage(response.text);
      if (!detected) {
        lastFailure = `malformed_output:${model}`;
        console.error(`detect-language: ${model} returned unusable output`);
        continue;
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: detected.code,
          confidence: detected.confidence,
          model,
          provider: 'gemini',
        }),
      };
    } catch (error: any) {
      // #85: 404 model_not_found, 429 quota, 5xx and timeouts must all fall
      // through to the next candidate. Breaking here left the detector dead on
      // the first unavailable model, which is how Production returned 500.
      lastFailure = safeErrorDetail(error);
      console.error(`detect-language: Gemini ${model} failed:`, lastFailure);
      continue;
    }
  }

  return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      error: '언어 감지에 실패했습니다. 사용 가능한 감지 모델을 모두 시도했습니다.',
      detail: lastFailure || 'unknown',
    }),
  };
};
