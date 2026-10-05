import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import {
    errorResponse,
    enforceTextLimit,
    jsonResponse,
    readJsonBody,
    safeErrorDetail,
} from './_aiGuards';

// Speed-first model routing, identical in order and reasoning settings to the
// interview translation route in translate.ts (#62). The interviewee reads
// this answer live, so the fastest proven production route goes first and one
// call decides shouldAnswer + answer — no separate classifier round trip.
//
// Latency is not the only reason the answer route mirrors translate.ts: the
// user is already paying for that route during the same utterance, and the
// same free-plan model-specific limits apply, so the fallback behaviour is
// shared rather than reinvented here.
export const ANSWER_PRIMARY_MODEL = 'openai/gpt-oss-20b';

const GROQ_MODELS = [
    { id: ANSWER_PRIMARY_MODEL, reasoningEffort: 'low' as const },  // ~1000 t/s, production
    { id: 'openai/gpt-oss-120b', reasoningEffort: 'low' as const }, // ~500 t/s, production
    { id: 'qwen/qwen3.8-27b', reasoningEffort: 'none' as const },    // strong multilingual
];

// Google-family fallbacks after Groq, same order as translate.ts.
const GOOGLE_MODELS = [
    'gemma-4-26b-a4b-it',
    'gemma-4-31b-it',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
];

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
    /**
     * The language the answer was actually requested in, echoed back by the
     * endpoint. The model never gets to choose it (#62): the answer follows
     * the interviewer's current OUTPUT/translation language.
     */
    language: string;
};

/**
 * `answerLanguage` is the interview OUTPUT language — the language the
 * interviewee is reading translations in — while `sourceLanguage` is only the
 * language the interviewer spoke. The two are deliberately different in the
 * main use case (English question, Korean output, Korean spoken answer), so
 * the prompt states the output language explicitly and forbids mirroring the
 * interviewer's language.
 */
const buildPrompt = (
    question: string,
    recentContext: string,
    answerLanguage: string,
    answerLanguageName: string,
    sourceLanguage: string,
): string => `
You are assisting a job interviewee in real time. The interviewee listens to the interviewer through live transcription and reads suggested answers on screen.

First decide whether the latest interviewer utterance is a technical interview question or request that deserves a suggested answer:
- Imperative technical requests count as questions even without a question mark, e.g. "Explain dependency injection." or "Tell me how garbage collection works."
- Small talk, acknowledgements and filler such as "Okay.", "Thank you.", "Uh-huh." -> shouldAnswer=false and answer="".
- Pure narration with no technical ask -> shouldAnswer=false and answer="".

If you answer:
- Write the answer in ${answerLanguageName} (${answerLanguage}). This is the language the interviewee reads translations in and the language they will speak the answer in. It is NOT the interviewer's language (${sourceLanguage || 'unknown'}), even when the interviewer spoke a different language.
- 3 to 5 sentences of natural, technically accurate spoken answer. No markdown headings, no bullet lists, no essays.
- Never invent personal experience, employers, projects, dates or numbers for the interviewee. If the question asks about the interviewee's own background and the context below does not provide it, give the general shape of a strong answer instead, or set shouldAnswer=false.

Earlier utterances from the same session (oldest first; may be incomplete or empty):
${recentContext || '(none)'}

Latest interviewer utterance:
${question}

Respond with STRICT JSON only — no markdown fences, no commentary:
{"shouldAnswer": true, "answer": "..."}
`.trim();

/**
 * Fail-closed parser: anything that is not a well-formed payload with a
 * non-empty answer becomes "no answer" (#62). The interviewee must never see
 * garbage or a hallucinated answer because the model wrapped its JSON.
 *
 * The reported language is always the requested one. A model-supplied
 * language is ignored on purpose: the endpoint owns the answer-language
 * contract, and trusting the model here is how an English answer ends up in
 * front of a Korean-only reader.
 */
export function parseAnswerPayload(raw: string, answerLanguage: string): InterviewAnswerPayload {
    const withoutFences = String(raw || '').replace(/```(?:json)?/gi, '').trim();
    const start = withoutFences.indexOf('{');
    const end = withoutFences.lastIndexOf('}');
    if (start === -1 || end <= start) {
        return { shouldAnswer: false, answer: '', language: answerLanguage };
    }
    try {
        const parsed = JSON.parse(withoutFences.slice(start, end + 1));
        if (!parsed || typeof parsed !== 'object') {
            return { shouldAnswer: false, answer: '', language: answerLanguage };
        }
        const answer = typeof parsed.answer === 'string' ? parsed.answer.trim().slice(0, MAX_ANSWER_CHARS) : '';
        if (parsed.shouldAnswer !== true || !answer) {
            return { shouldAnswer: false, answer: '', language: answerLanguage };
        }
        return { shouldAnswer: true, answer, language: answerLanguage };
    } catch {
        return { shouldAnswer: false, answer: '', language: answerLanguage };
    }
}

export const handler = async (event: any) => {
    if (event.httpMethod !== 'POST') {
        return errorResponse(405, '허용되지 않은 메서드입니다.');
    }

    // Same key resolution as translate.ts: a personal key supplies Google
    // credentials, Groq runs on the server-side key (#32 forwarding contract).
    const userApiKey = event.headers['x-user-api-key'];
    const googleApiKey = userApiKey || process.env.GEMINI_API_KEY || process.env.API_KEY;
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!googleApiKey && !groqApiKey) {
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

    // The answer language is the interview OUTPUT language the client already
    // resolved for this utterance (#62). Only the base code is stored; a
    // region tag from a transcriber must not leak into the answer language.
    const answerLanguage = (typeof body.answerLanguage === 'string' ? body.answerLanguage : '')
        .trim()
        .toLowerCase()
        .replace(/_/g, '-')
        .split('-')[0]
        .slice(0, 32) || 'en';
    const answerLanguageName = (typeof body.answerLanguageName === 'string' ? body.answerLanguageName : '')
        .trim()
        .slice(0, 100) || answerLanguage;
    const sourceLanguage = (typeof body.sourceLanguage === 'string' ? body.sourceLanguage : '')
        .trim()
        .toLowerCase()
        .replace(/_/g, '-')
        .split('-')[0]
        .slice(0, 32);

    const rawContext = Array.isArray(body.recentContext) ? body.recentContext : [];
    const contextTurns = rawContext
        .filter((turn: unknown): turn is string => typeof turn === 'string' && turn.trim().length > 0)
        .slice(-MAX_ANSWER_CONTEXT_TURNS)
        .map((turn: string) => turn.trim().slice(0, MAX_ANSWER_CONTEXT_TURN_CHARS));
    const recentContext = contextTurns.join('\n---\n').slice(0, MAX_ANSWER_CONTEXT_CHARS);

    const prompt = buildPrompt(question, recentContext, answerLanguage, answerLanguageName, sourceLanguage);
    let lastDetail = '';

    const buildResult = (raw: string) => {
        if (!raw.trim()) throw new Error('empty answer payload');
        // Fail-closed: a malformed provider result is reported as "no
        // answer", never as a hallucinated or partial answer (#62).
        return parseAnswerPayload(raw, answerLanguage);
    };

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
                    response_format: { type: 'json_object' },
                };
                if (route.reasoningEffort !== 'none') {
                    request.reasoning_format = 'hidden';
                }
                const response = await groq.chat.completions.create(request);
                return jsonResponse(200, buildResult(response.choices?.[0]?.message?.content?.trim() || ''));
            } catch (error) {
                lastDetail = safeErrorDetail(error);
                console.error(`interview-answer: Groq ${route.id} failed:`, lastDetail);
            }
        }
    }

    // 2) Google-family fallbacks after the Groq pool.
    if (googleApiKey) {
        const ai = new GoogleGenAI({ apiKey: googleApiKey });
        for (const model of GOOGLE_MODELS) {
            try {
                const response = await ai.models.generateContent({
                    model,
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                });
                return jsonResponse(200, buildResult(response.text?.trim() || ''));
            } catch (error) {
                lastDetail = safeErrorDetail(error);
                console.error(`interview-answer: Google ${model} failed:`, lastDetail);
            }
        }
    }

    return errorResponse(502, '답변 생성에 실패했습니다.', lastDetail ? { detail: lastDetail } : undefined);
};