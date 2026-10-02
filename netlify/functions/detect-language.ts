import { GoogleGenAI, Type } from '@google/genai';
import Groq from 'groq-sdk';

const SUPPORTED_CODES = ['ko', 'en', 'ja', 'zh', 'vi', 'es', 'fr', 'de', 'ru', 'th', 'id', 'ar', 'hi', 'tl', 'mn', 'uz'] as const;
type SupportedCode = (typeof SUPPORTED_CODES)[number];

// Gemini 모델 우선순위 (무료 제한량 많은 순서)
const GEMINI_MODELS = [
  'gemini-2.5-flash-lite',  // 1순위: 1000+ RPD
  'gemini-2.0-flash',       // 2순위: 1500 RPD
];

// Groq 모델 우선순위 (Gemini 소진 시 폴백)
const GROQ_MODELS = [
  'llama-3.3-70b-versatile', // 3순위: 1000 RPD, 70B 고품질
  'llama-3.1-8b-instant',    // 4순위: 14,400 RPD, 8B 비상용
];

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
  const groqApiKey = process.env.GROQ_API_KEY;

  if (!geminiApiKey && !groqApiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'API 키가 설정되지 않았습니다.' }),
    };
  }

  // 요청 본문 파싱
  let body: any = {};
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf-8')
      : event.body || '';
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('detect-language: failed to parse body', err);
    body = {};
  }

  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '필수 값(text)이 누락되었습니다.' }),
    };
  }

  let lastError: any = null;
  let lastErrorDetail: any = null;

  const prompt = `Detect the language of the following text.
Return JSON only: {"code": "xx", "confidence": 0.95}
Rules:
- code must be one of: ${SUPPORTED_CODES.join(', ')}
- confidence must be a number between 0 and 1.
Text: ${JSON.stringify(text)}`;

  // 1단계: Gemini 모델 시도
  if (geminiApiKey) {
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    for (const model of GEMINI_MODELS) {
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

        let parsed: any = {};
        try {
          parsed = response.text ? JSON.parse(response.text) : {};
        } catch { /* ignore */ }

        const code = SUPPORTED_CODES.includes((parsed.code as any) ?? '') ? (parsed.code as SupportedCode) : 'en';
        const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, confidence, model, provider: 'gemini' }),
        };
      } catch (error: any) {
        lastError = error;
        lastErrorDetail = error?.message || String(error);
        console.error(`detect-language: Gemini ${model} failed:`, error?.message);

        const isRateLimit = error?.message?.includes('429') ||
          error?.message?.includes('RESOURCE_EXHAUSTED') ||
          error?.status === 429;
        if (isRateLimit) {
          console.log(`Gemini ${model} rate limited, trying next...`);
          continue;
        }
        break;
      }
    }
  }

  // 2단계: Groq 모델 시도 (Gemini 실패 시)
  if (groqApiKey) {
    const groq = new Groq({ apiKey: groqApiKey });
    for (const model of GROQ_MODELS) {
      try {
        const response = await groq.chat.completions.create({
          model,
          messages: [{
            role: 'user',
            content: prompt,
          }],
          temperature: 0.1,
          max_tokens: 100,
        });

        const content = response.choices?.[0]?.message?.content?.trim() || '{}';
        let parsed: any = {};
        try {
          // JSON 추출 시도
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
        } catch { /* ignore */ }

        const code = SUPPORTED_CODES.includes((parsed.code as any) ?? '') ? (parsed.code as SupportedCode) : 'en';
        const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, confidence, model, provider: 'groq' }),
        };
      } catch (error: any) {
        lastError = error;
        lastErrorDetail = error?.message || String(error);
        console.error(`detect-language: Groq ${model} failed:`, error?.message);

        const isRateLimit = error?.message?.includes('429') ||
          error?.message?.includes('rate_limit') ||
          error?.status === 429;
        if (isRateLimit) {
          console.log(`Groq ${model} rate limited, trying next...`);
          continue;
        }
        break;
      }
    }
  }

  return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      error: '언어 감지에 실패했습니다. 모든 모델의 제한량이 소진되었습니다.',
      detail: lastErrorDetail || String(lastError),
    }),
  };
};
