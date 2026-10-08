import { GoogleGenAI } from '@google/genai';
import {
    errorResponse,
    enforceTextLimit,
    jsonResponse,
    readJsonBody,
    safeErrorDetail,
    MAX_SUMMARY_TEXT_CHARS,
} from './_aiGuards';

// History summaries use the owner's chosen Gemma order (#76).
const SUMMARY_MODELS = ['gemma-4-31b-it', 'gemma-4-26b-a4b-it'];

export const handler = async (event: any) => {
    if (event.httpMethod !== 'POST') {
        return errorResponse(405, '허용되지 않은 메서드입니다.');
    }

    const userApiKey = event.headers['x-user-api-key'];
    const apiKey = userApiKey || process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
        return errorResponse(500, 'API 키가 설정되지 않았습니다.');
    }

    const parsedBody = readJsonBody(event);
    if (parsedBody.ok === false) return parsedBody.response;
    const body = parsedBody.body;

    const historyText = typeof body.history === 'string' ? body.history : '';
    const lang = typeof body.lang === 'string' ? body.lang : 'ko';

    if (!historyText) {
        return errorResponse(400, 'History text is required');
    }

    const oversize = enforceTextLimit(historyText, MAX_SUMMARY_TEXT_CHARS, 'history');
    if (oversize) return oversize;

    const prompt = `
      Please analyze and summarize the following conversation.
      Provide the result in the language: ${lang === 'ko' ? 'Korean' : 'English'}.
      
      Format your response exactly as follows:
      ## 📝 Summary
      (3 bullet points summarizing the main content)
      
      ## 💡 Key Topics
      (List of important terms or topics mentioned)
      
      Conversation:
      ${historyText}
    `;

    let lastDetail = '';

    for (const model of SUMMARY_MODELS) {
        try {
            const ai = new GoogleGenAI({
                apiKey,
                httpOptions: { timeout: model === 'gemma-4-31b-it' ? 8_000 : 9_000, retryOptions: { attempts: 1 } },
            });
            // Current SDK API (@google/genai 2.x). The legacy Gemini 1.x
            // model-factory call shape is intentionally gone (#36).
            const response = await ai.models.generateContent({
                model,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
            });

            const resultText = response.text?.trim() || '';
            if (!resultText) {
                throw new Error(`${model} returned an empty summary`);
            }

            return jsonResponse(200, { summary: resultText });
        } catch (error) {
            lastDetail = safeErrorDetail(error);
            console.error(`summarize: ${model} failed:`, lastDetail);
        }
    }

    return errorResponse(502, '요약에 실패했습니다.', lastDetail ? { detail: lastDetail } : undefined);
};

