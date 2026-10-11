import { GoogleGenAI } from '@google/genai';
import { getTranscribeKey, parseTranscribeAccount } from './_transcribeAccounts';
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

  // The new Transcribe page explicitly sends account; older Classroom/Interview
  // callers omit it and retain their original x-user-api-key/default behavior.
  const useTranscribeAccount = model === 'gemini-3.5-transcribe-live' &&
    Object.prototype.hasOwnProperty.call(body, 'account');
  const account = useTranscribeAccount ? parseTranscribeAccount(body.account) : null;
  if (useTranscribeAccount && !account) return errorResponse(400, '계정 선택이 올바르지 않습니다.');
  const userApiKey = event.headers['x-user-api-key'];
  const apiKey = useTranscribeAccount ? getTranscribeKey(account!) :
    (userApiKey || process.env.GEMINI_API_KEY || process.env.API_KEY);
  if (!apiKey) return errorResponse(503, useTranscribeAccount ? '선택한 계정에 API 키가 없습니다.' : 'API 키가 설정되지 않았습니다.');

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
