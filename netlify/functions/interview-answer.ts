import { GoogleGenAI } from '@google/genai';
import {
    errorResponse,
    enforceTextLimit,
    jsonResponse,
    readJsonBody,
    safeErrorDetail,
} from './_aiGuards';

// Text models already in production use elsewhere in this repo (same
// convention as summarize.ts), tried in order. Latency matters for the
// interviewee, so the light default model goes first and ONE call decides
// shouldAnswer + answer + language — no separate classifier round trip (#62).
const ANSWER_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.0-flash'];

// Bounds derived from real usage: a single interviewer utterance plus a few
// earlier turns. The client (utils/interviewAnswer.ts) already bounds its
// payload; these are the server-side enforcement points.
export const MAX_ANSWER_QUESTION_CHARS = 4_000;
export const MAX_ANSWER_CONTEXT_TURNS = 5;
export const MAX_ANSWER_CONTEXT_TURN_CHARS = 600;
export const MAX_ANSWER_CONTEXT_CHARS = 6_000;
export const MAX_ANSWER_CHARS = 4_000;

export type InterviewAnswerPayload = {
    shouldAnswer: boolean;
    answer: string;
    language: string;
};

const buildPrompt = (question: string, recentContext: string): string => `
You are assisting a job interviewee in real time. The interviewee listens to the interviewer through live transcription and reads suggested answers on screen.

First decide whether the latest interviewer utterance is a technical interview question or request that deserves a suggested answer:
- Imperative technical requests count as questions even without a question mark, e.g. "Explain dependency injection." or "Tell me how garbage collection works."
- Small talk, acknowledgements and filler such as "Okay.", "Thank you.", "Uh-huh." -> shouldAnswer=false and answer="".
- Pure narration with no technical ask -> shouldAnswer=false and answer="".

If you answer:
- Reply in the SAME language the interviewer used in the latest utterance. Do not use the translation language shown to the interviewee.
- 3 to 5 sentences of natural, technically accurate spoken answer. No markdown headings, no bullet lists, no essays.
- Never invent personal experience, employers, projects, dates or numbers for the interviewee. If the question asks about the interviewee's own background and the context below does not provide it, give the general shape of a strong answer instead, or set shouldAnswer=false.

Earlier utterances from the same session (oldest first; may be incomplete or empty):
${recentContext || '(none)'}

Latest interviewer utterance:
${question}

Respond with STRICT JSON only — no markdown fences, no commentary:
{"shouldAnswer": true, "answer": "...", "language": "en"}
`.trim();

/**
 * Fail-closed parser: anything that is not a well-formed payload with a
 * non-empty answer becomes "no answer" (#62). The interviewee must never see
 * garbage or a hallucinated answer because the model wrapped its JSON.
 */
export function parseAnswerPayload(raw: string, fallbackLanguage: string): InterviewAnswerPayload {
    const withoutFences = String(raw || '').replace(/```(?:json)?/gi, '').trim();
    const start = withoutFences.indexOf('{');
    const end = withoutFences.lastIndexOf('}');
    if (start === -1 || end <= start) {
        return { shouldAnswer: false, answer: '', language: fallbackLanguage };
    }
    try {
        const parsed = JSON.parse(withoutFences.slice(start, end + 1));
        if (!parsed || typeof parsed !== 'object') {
            return { shouldAnswer: false, answer: '', language: fallbackLanguage };
        }
        const language = typeof parsed.language === 'string' && parsed.language.trim()
            ? parsed.language.trim().slice(0, 32)
            : fallbackLanguage;
        const answer = typeof parsed.answer === 'string' ? parsed.answer.trim().slice(0, MAX_ANSWER_CHARS) : '';
        if (parsed.shouldAnswer !== true || !answer) {
            return { shouldAnswer: false, answer: '', language };
        }
        return { shouldAnswer: true, answer, language };
    } catch {
        return { shouldAnswer: false, answer: '', language: fallbackLanguage };
    }
}

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

    const question = typeof body.text === 'string' ? body.text.trim() : '';
    if (!question) {
        return errorResponse(400, 'text is required');
    }
    const oversize = enforceTextLimit(question, MAX_ANSWER_QUESTION_CHARS, 'text');
    if (oversize) return oversize;

    const sourceLanguage = typeof body.language === 'string' && body.language.trim()
        ? body.language.trim().slice(0, 32)
        : 'en';

    const rawContext = Array.isArray(body.recentContext) ? body.recentContext : [];
    const contextTurns = rawContext
        .filter((turn: unknown): turn is string => typeof turn === 'string' && turn.trim().length > 0)
        .slice(-MAX_ANSWER_CONTEXT_TURNS)
        .map((turn: string) => turn.trim().slice(0, MAX_ANSWER_CONTEXT_TURN_CHARS));
    const recentContext = contextTurns.join('\n---\n').slice(0, MAX_ANSWER_CONTEXT_CHARS);

    const prompt = buildPrompt(question, recentContext);
    const ai = new GoogleGenAI({ apiKey });
    let lastDetail = '';

    for (const model of ANSWER_MODELS) {
        try {
            const response = await ai.models.generateContent({
                model,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
            });
            const raw = response.text?.trim() || '';
            if (!raw) {
                throw new Error(`${model} returned an empty answer payload`);
            }
            const payload = parseAnswerPayload(raw, sourceLanguage);
            // Fail-closed: a malformed provider result is reported as "no
            // answer", never as a hallucinated or partial answer (#62).
            return jsonResponse(200, payload);
        } catch (error) {
            lastDetail = safeErrorDetail(error);
            console.error(`interview-answer: ${model} failed:`, lastDetail);
        }
    }

    return errorResponse(502, '답변 생성에 실패했습니다.', lastDetail ? { detail: lastDetail } : undefined);
};
