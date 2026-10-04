import { GoogleGenAI, Modality } from '@google/genai';
import {
    enforceTextLimit,
    errorResponse,
    isAllowedString,
    readJsonBody,
    safeErrorDetail,
    ALLOWED_TTS_MODELS,
    ALLOWED_TTS_VOICES,
    MAX_TTS_TEXT_CHARS,
} from './_aiGuards';

const DEFAULT_TTS_MODEL = 'gemini-2.5-flash-preview-tts';

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

  const text = typeof body.text === 'string' ? body.text : '';
  const voiceName = typeof body.voiceName === 'string' ? body.voiceName : 'Kore';
  const model = body.model === undefined ? DEFAULT_TTS_MODEL : body.model;

  if (!text.trim()) {
    return errorResponse(400, '필수 값(text)이 누락되었습니다.');
  }

  const oversize = enforceTextLimit(text, MAX_TTS_TEXT_CHARS, 'text');
  if (oversize) return oversize;

  if (!isAllowedString(model, ALLOWED_TTS_MODELS)) {
    return errorResponse(400, '지원하지 않는 모델입니다.');
  }

  if (!isAllowedString(voiceName, ALLOWED_TTS_VOICES)) {
    return errorResponse(400, '지원하지 않는 음성입니다.');
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64Audio) {
      return errorResponse(500, 'TTS 오디오 생성 결과가 비어있습니다.');
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: base64Audio }),
    };
  } catch (error) {
    const detail = safeErrorDetail(error);
    console.error('tts: generation failed', detail);
    return errorResponse(500, 'TTS 생성에 실패했습니다.', { detail });
  }
};
