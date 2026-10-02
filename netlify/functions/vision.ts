import { GoogleGenAI, Type } from '@google/genai';

export const handler = async (event: any) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '허용되지 않은 메서드입니다.' }),
    };
  }

  const userApiKey = event.headers['x-user-api-key'];
  const apiKey = userApiKey || process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'API 키가 설정되지 않았습니다.' }),
    };
  }

  let body: any = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    body = {};
  }

  const base64Image = typeof body.base64Image === 'string' ? body.base64Image : '';
  const langA = typeof body.langA === 'string' ? body.langA : '';
  const langB = typeof body.langB === 'string' ? body.langB : '';
  const model = typeof body.model === 'string' ? body.model : 'gemini-2.0-flash';

  if (!base64Image || !langA || !langB) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '필수 값(base64Image/langA/langB)이 누락되었습니다.' }),
    };
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const prompt = `
Analyze the text in this image.
Rules:
1. If the detected text is in ${langA}, translate it to ${langB}.
2. If the detected text is in ${langB}, translate it to ${langA}.
3. If it's a mix or another language, translate it to ${langA}.
Return the result in JSON format.
`;

    const response = await ai.models.generateContent({
      model,
      contents: {
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
          { text: prompt },
        ],
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            originalText: { type: Type.STRING },
            translatedText: { type: Type.STRING },
          },
          required: ['originalText', 'translatedText'],
        },
      },
    });

    const json = JSON.parse(response.text || '{}');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originalText: json.originalText || '',
        translatedText: json.translatedText || '',
      }),
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: '비전 분석에 실패했습니다.',
        detail: error?.message || String(error),
      }),
    };
  }
};
