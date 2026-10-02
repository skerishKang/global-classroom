import { GoogleGenAI, Modality } from '@google/genai';

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
  } catch (err) {
    console.error('tts: failed to parse body', err);
    body = {};
  }

  const text = typeof body.text === 'string' ? body.text : '';
  const voiceName = typeof body.voiceName === 'string' ? body.voiceName : 'Kore';
  const model = typeof body.model === 'string' ? body.model : 'gemini-2.5-flash-preview-tts';

  if (!text.trim()) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '필수 값(text)이 누락되었습니다.' }),
    };
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
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'TTS 오디오 생성 결과가 비어있습니다.' }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: base64Audio }),
    };
  } catch (error: any) {
    console.error('tts: generation failed', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'TTS 생성에 실패했습니다.',
        detail: error?.message || String(error),
      }),
    };
  }
};
