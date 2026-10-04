import { GoogleGenAI } from '@google/genai';
import {
    enforceBodySize,
    errorResponse,
    isAllowedString,
    readJsonBody,
    safeErrorDetail,
    ALLOWED_LIVE_MODELS,
    MAX_LIVE_TOKEN_BODY_BYTES,
} from './_aiGuards';

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

  const tooLarge = enforceBodySize(event, MAX_LIVE_TOKEN_BODY_BYTES);
  if (tooLarge) return tooLarge;

  const parsedBody = readJsonBody(event);
  if (parsedBody.ok === false) return parsedBody.response;
  const body = parsedBody.body;

  // Only models this repo's clients actually use may receive a token (#36).
  const model = body.model;
  if (!isAllowedString(model, ALLOWED_LIVE_MODELS)) {
    return errorResponse(400, '지원하지 않는 모델입니다.');
  }

  try {
    const client = new GoogleGenAI({ apiKey });

    const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const newSessionExpireTime = new Date(Date.now() + 1 * 60 * 1000).toISOString();

    const token = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime,
        newSessionExpireTime,
        httpOptions: { apiVersion: 'v1alpha' },
        // Bind the ephemeral token to the allowlisted model so the
        // client cannot open a Live session with any other model (#36).
        liveConnectConstraints: { model },
      },
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.name, expireTime }),
    };
  } catch (error) {
    const detail = safeErrorDetail(error);
    console.error('live-token: token creation failed', detail);
    return errorResponse(500, '임시 토큰 발급에 실패했습니다.', { detail });
  }
};
