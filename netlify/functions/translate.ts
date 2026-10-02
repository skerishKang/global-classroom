import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';

type GroqRoute = {
  id: string;
  reasoningEffort: 'low' | 'none';
};

// Speed-first order for interview translation.
// Free-plan limits are model-specific, so exhausting one model can fall through to the next.
const GROQ_MODELS: GroqRoute[] = [
  { id: 'openai/gpt-oss-20b', reasoningEffort: 'low' },   // ~1000 t/s, production
  { id: 'openai/gpt-oss-120b', reasoningEffort: 'low' },  // ~500 t/s, production
  { id: 'qwen/qwen3.8-27b', reasoningEffort: 'none' },     // ~450+ t/s, strong multilingual
];

// Google-family fallbacks after Groq.
// Gemma 4 26B A4B is placed first because only ~4B parameters are active per token,
// making it the speed-oriented Gemma 4 choice. Gemini Flash-Lite models are final fallbacks.
const GOOGLE_MODELS = [
  'gemma-4-26b-a4b-it',
  'gemma-4-31b-it',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
];

const translationPrompt = (
  text: string,
  from: string,
  to: string,
  glossary: Array<{ source: string; target: string }>,
) => {
  const glossaryBlock = glossary.length
    ? `\nPreferred terminology (apply when relevant, do not invent occurrences):\n${glossary
        .map((entry) => `- ${entry.source} => ${entry.target}`)
        .join('\n')}`
    : '';

  return `Translate the following text from ${from} to ${to}.
Preserve the speaker's meaning, technical terminology, numbers, product names, uncertainty, sentence boundaries, paragraph breaks, and list structure as closely as the target language allows.
Do not summarize, combine separate ideas, omit repetitions, or rewrite the speaker's argument.
Apply the preferred terminology exactly when the matching source term occurs.
Output ONLY the translated text, with no explanation or quotation marks.${glossaryBlock}

Text:
${text}`;
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
  const groqApiKey = process.env.GROQ_API_KEY;

  if (!geminiApiKey && !groqApiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'API 키가 설정되지 않았습니다.' }),
    };
  }

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
  const glossary = Array.isArray(body.glossary)
    ? body.glossary
        .filter((entry: any) => entry && typeof entry.source === 'string' && typeof entry.target === 'string')
        .map((entry: any) => ({ source: entry.source.trim(), target: entry.target.trim() }))
        .filter((entry: any) => entry.source && entry.target)
        .slice(0, 100)
    : [];

  if (!text.trim() || !from || !to) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '필수 값(text/from/to)이 누락되었습니다.' }),
    };
  }

  const prompt = translationPrompt(text, from, to, glossary);
  let lastError: any = null;
  let lastErrorDetail: any = null;

  // 1) Groq first: lowest latency for the interview path.
  if (groqApiKey) {
    const groq = new Groq({ apiKey: groqApiKey });

    for (const route of GROQ_MODELS) {
      try {
        const request: any = {
          model: route.id,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 2048,
          reasoning_effort: route.reasoningEffort,
        };

        if (route.reasoningEffort !== 'none') {
          request.reasoning_format = 'hidden';
        }

        const response = await groq.chat.completions.create(request);
        const translated = response.choices?.[0]?.message?.content?.trim() || '';

        if (!translated) {
          throw new Error('Groq returned an empty translation.');
        }

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            translated,
            model: route.id,
            provider: 'groq',
          }),
        };
      } catch (error: any) {
        lastError = error;
        lastErrorDetail = error?.message || String(error);
        console.error(`translate: Groq ${route.id} failed:`, error?.message);
        continue;
      }
    }
  }

  // 2) Google-family fallbacks after the Groq pool.
  if (geminiApiKey) {
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });

    for (const model of GOOGLE_MODELS) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [{
            role: 'user',
            parts: [{ text: prompt }],
          }],
        });

        const translated = response.text?.trim() || '';
        if (!translated) {
          throw new Error('Google model returned an empty translation.');
        }

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            translated,
            model,
            provider: 'google',
          }),
        };
      } catch (error: any) {
        lastError = error;
        lastErrorDetail = error?.message || String(error);
        console.error(`translate: Google ${model} failed:`, error?.message);
        continue;
      }
    }
  }

  return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      error: '번역에 실패했습니다. 사용 가능한 번역 모델을 모두 시도했습니다.',
      detail: lastErrorDetail || String(lastError),
    }),
  };
};
