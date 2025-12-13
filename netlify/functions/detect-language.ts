import { GoogleGenAI, Type } from '@google/genai';

const SUPPORTED_CODES = ['ko','en','ja','zh','vi','es','fr','de','ru','th','id','ar','hi','tl','mn','uz'] as const;
type SupportedCode = (typeof SUPPORTED_CODES)[number];
export const handler = async (event: any) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '허용되지 않은 메서드입니다.' }),
    };
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '서버 환경변수 GEMINI_API_KEY가 설정되지 않았습니다.' }),
    };
  }

  let body: any = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
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

  try {
    const ai = new GoogleGenAI({ apiKey });

    const prompt = `Detect the language of the following text.
Return JSON only.
Rules:
- code must be one of: ${SUPPORTED_CODES.join(', ')}
- confidence must be a number between 0 and 1.
Text: ${JSON.stringify(text)}`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: { parts: [{ text: prompt }] },
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

    const json = JSON.parse(response.text || '{}') as { code?: SupportedCode; confidence?: number };
    const code = SUPPORTED_CODES.includes((json.code as any) ?? '') ? (json.code as SupportedCode) : 'en';
    const confidence = typeof json.confidence === 'number' ? json.confidence : 0;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, confidence }),
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: '언어 감지에 실패했습니다.',
        detail: error?.message || String(error),
      }),
    };
  }
};
