import { GoogleGenAI, Type } from '@google/genai';
import {
    decodedBase64Bytes,
    errorResponse,
    isAllowedModel,
    readJsonBody,
    safeErrorDetail,
    ALLOWED_VISION_MODELS,
    MAX_VISION_IMAGE_BYTES,
} from './_aiGuards';

const DEFAULT_VISION_MODEL = 'gemini-2.0-flash';

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

  const parsedBody = readJsonBody(event);
  if (parsedBody.ok === false) return parsedBody.response;
  const body = parsedBody.body;

  const base64Image = typeof body.base64Image === 'string' ? body.base64Image : '';
  const langA = typeof body.langA === 'string' ? body.langA : '';
  const langB = typeof body.langB === 'string' ? body.langB : '';
  const model = body.model === undefined ? DEFAULT_VISION_MODEL : body.model;

  if (!base64Image || !langA || !langB) {
    return errorResponse(400, '필수 값(base64Image/langA/langB)이 누락되었습니다.');
  }

  if (!isAllowedModel(model, ALLOWED_VISION_MODELS)) {
    return errorResponse(400, '지원하지 않는 모델입니다.');
  }

  // Bound on decoded bytes, not on the encoded string length (#36).
  if (decodedBase64Bytes(base64Image) > MAX_VISION_IMAGE_BYTES) {
    const maxMb = MAX_VISION_IMAGE_BYTES / (1024 * 1024);
    return errorResponse(413, `이미지가 너무 큽니다. 최대 ${maxMb}MB까지 허용됩니다.`);
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
  } catch (error) {
    const detail = safeErrorDetail(error);
    console.error('vision: analysis failed', detail);
    return errorResponse(500, '비전 분석에 실패했습니다.', { detail });
  }
};
