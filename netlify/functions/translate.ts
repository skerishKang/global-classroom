import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';

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
    console.error('translate: failed to parse body', err);
    body = {};
  }

  const text = typeof body.text === 'string' ? body.text : '';
  const from = typeof body.from === 'string' ? body.from : '';
  const to = typeof body.to === 'string' ? body.to : '';

  if (!text.trim() || !from || !to) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '필수 값(text/from/to)이 누락되었습니다.' }),
    };
  }

  let lastError: any = null;
  let lastErrorDetail: any = null;

  // 1단계: Gemini 모델 시도
  if (geminiApiKey) {
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    for (const model of GEMINI_MODELS) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [{
            role: 'user',
            parts: [{
              text: `Translate the following text from ${from} to ${to}.\nOutput ONLY the translated text, no explanations.\nText: "${text}"`,
            }],
          }],
        });

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            translated: response.text?.trim() || '',
            model,
            provider: 'gemini',
          }),
        };
      } catch (error: any) {
        lastError = error;
        lastErrorDetail = error?.message || String(error);
        console.error(`translate: Gemini ${model} failed:`, error?.message);

        // Rate limit인 경우에만 다음 모델로
        const isRateLimit = error?.message?.includes('429') ||
          error?.message?.includes('RESOURCE_EXHAUSTED') ||
          error?.status === 429;
        if (isRateLimit) {
          console.log(`Gemini ${model} rate limited, trying next...`);
          continue;
        }
        // 다른 에러는 즉시 다음 단계로
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
            content: `Translate the following text from ${from} to ${to}.\nOutput ONLY the translated text, no explanations.\nText: "${text}"`,
          }],
          temperature: 0.3,
          max_tokens: 2048,
        });

        const translated = response.choices?.[0]?.message?.content?.trim() || '';

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            translated,
            model,
            provider: 'groq',
          }),
        };
      } catch (error: any) {
        lastError = error;
        lastErrorDetail = error?.message || String(error);
        console.error(`translate: Groq ${model} failed:`, error?.message);

        // Rate limit인 경우 다음 모델로
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
      error: '번역에 실패했습니다. 모든 모델의 제한량이 소진되었습니다.',
      detail: lastErrorDetail || String(lastError),
    }),
  };
};
