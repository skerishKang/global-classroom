import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import {
    errorResponse,
    enforceTextLimit,
    jsonResponse,
    readJsonBody,
} from './_aiGuards';
import {
    ProviderTelemetry,
    createProviderBudget,
    runWithDeadline,
    type AttemptOutcome,
    type ProviderName,
    type SkipReason,
} from './_providerBudget';

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
// Owner instruction (2026-10-12): same pool as translation - the three Groq
// routes plus these two Gemini Flash-Lite fallbacks, with the Gemma 4 entries removed.
const GOOGLE_MODELS = [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
];

// --- Latency budget (#84 follow-up: the same ceiling the answer route lacked) --
//
// Measured on Production before this change: three normal requests answered in
// 1.42s, 1.64s and 2.62s from the first Groq route. 6s per Groq candidate is
// ~2.3x that observed worst case, and it is the largest cap that still lets all
// three Groq routes plus one reserved Google attempt fit inside the total. A 7s
// cap would have pushed the third candidate out of the schedule entirely, which
// removes approved fallback rather than bounding latency.
export const ANSWER_TOTAL_BUDGET_MS = 24_000;
export const ANSWER_GROQ_MODEL_TIMEOUT_MS = 6_000;
export const ANSWER_GOOGLE_MODEL_TIMEOUT_MS = 10_000;
export const ANSWER_GOOGLE_RESERVE_MS = ANSWER_GOOGLE_MODEL_TIMEOUT_MS;
export const ANSWER_MIN_USEFUL_ATTEMPT_MS = 1_200;

const answerBudget = createProviderBudget({
    totalBudgetMs: ANSWER_TOTAL_BUDGET_MS,
    groqModelTimeoutMs: ANSWER_GROQ_MODEL_TIMEOUT_MS,
    googleModelTimeoutMs: ANSWER_GOOGLE_MODEL_TIMEOUT_MS,
    googleReserveMs: ANSWER_GOOGLE_RESERVE_MS,
    minUsefulAttemptMs: ANSWER_MIN_USEFUL_ATTEMPT_MS,
});

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
     * the finalized transcript/source language (#70).
     */
    language: string;
};

/**
 * `answerLanguage` is the finalized transcript/source language (#70),
 * independent of the current translation target. The client separately
 * translates the suggested answer into the selected output language.
 */
const buildPrompt = (
    question: string,
    recentContext: string,
    answerLanguage: string,
    answerLanguageName: string,
    sourceLanguage: string,
): string => `
You are assisting a job interviewee in real time. The interviewee listens to the interviewer through live transcription and reads suggested answers on screen.

Decide whether this latest utterance merits a useful suggested *spoken response* for the interviewee:
- Set shouldAnswer=true for any substantive interview question or request, regardless of topic (technical, personal strengths, hiring, motivation, self-introduction, teamwork, behavioral, situational, clarification).
- Questions and requests need not contain a question mark: "Explain dependency injection.", "Tell me about yourself." also require responses.
- When the speaker makes a substantive statement rather than asking a question (e.g., explains a certification program, discusses an approach or offers feedback), set shouldAnswer=true and suggest a short, relevant conversational reaction: acknowledge their point, add a thoughtful observation or opinion supported by what was said, or suggest a natural next question. Do not turn informational narration into an unrelated job-interview answer.
- Only skip empty content, isolated greetings, acknowledgements and filler ("Okay.", "Thank you.", "Uh-huh.") that do not call for a substantive response. A short *meaningful* question still requires an answer.
- Never claim a speaker asked something they did not ask. Use the recent context only to maintain relevance.

If you respond, your answer is a LIVE SPOKEN INTERVIEW CUE, NOT a textbook or essay:
- Write in ${answerLanguageName} (${answerLanguage}), the finalized transcript/source language (${sourceLanguage || 'unknown'}). The client separately translates it into the selected target language.
- Answer as the interviewee speaking naturally out loud, in first person where appropriate. Sound conversational, confident, and clear; use everyday words and natural contractions in English (e.g. "I'd", "I think", "I'd check"). Avoid a formal lecture tone, repeated definitions, academic exposition, and unnecessary qualifiers.
- For a direct question, give the main answer FIRST in 2 SHORT sentences (a third only if essential). Aim for 25–55 English words, never more than roughly 70; use an equivalently brief spoken length in other languages. For technical comparisons, say when you'd choose the option and its key trade-off or risk; mention at most one practical check. Keep essential technical accuracy.
- For substantive statements, give 1–2 short conversational sentences (about 15–35 English words or equivalent): a relevant reaction, simple opinion or natural follow-up, not an elaborate mini-essay.
- The user must be able to read this aloud comfortably in roughly 10–20 seconds. If an answer feels like a paragraph from a paper, shorten it before returning the JSON. No markdown headings, lists, essay-style setup, or long enumerations.
- Never invent personal experiences, employers, projects, dates, credentials or numbers for the interviewee. When biographical details are unknown, give an adaptable answer without pretending to know their background. Do not omit a personal question solely because their background is unknown.
- Style example for "When would you prefer isotonic regression over Platt scaling, and what's the overfitting risk?": "I'd use isotonic regression when I have plenty of validation data and need a more flexible fit. But it can overfit on small or noisy datasets, so I'd check it on a separate holdout set."

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

    // The answer language is the transcript/source language the client already
    // resolved for this utterance (#70). Only the base code is stored; a
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
    const telemetry = new ProviderTelemetry('interview-answer', () => Date.now());
    let lastDetail: AttemptOutcome | SkipReason = 'unknown';

    // A blank provider payload is a failed candidate, never a success. Anything
    // else goes through the fail-closed parser, which turns malformed or
    // no-answer output into `shouldAnswer: false` — the existing #62 contract,
    // preserved unchanged: the interviewee sees no suggestion, not garbage.
    const toPayload = (raw: string) => (raw.trim() ? parseAnswerPayload(raw, answerLanguage) : null);

    const serve = (payload: InterviewAnswerPayload, provider: ProviderName, model: string) => {
        console.info(telemetry.summary({ statusCode: 200, provider, model }));
        return jsonResponse(200, payload);
    };

    // 1) Groq first: lowest latency for the interview path.
    if (groqApiKey) {
        // maxRetries 0: retrying inside one route doubles the latency of a model
        // that already failed, while the next route is a genuine fallback.
        const groq = new Groq({ apiKey: groqApiKey, maxRetries: 0 });

        for (const route of GROQ_MODELS) {
            const plan = answerBudget.planAttempt({
                provider: 'groq',
                elapsedMs: telemetry.elapsedMs,
                googleCandidatesRemaining: googleApiKey ? GOOGLE_MODELS.length : 0,
            });
            if (plan.state === 'skip') {
                telemetry.skipped('groq', route.id, plan.reason);
                lastDetail = plan.reason;
                break;
            }

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

            const attempt = await runWithDeadline({
                label: 'interview-answer',
                provider: 'groq',
                model: route.id,
                timeoutMs: plan.timeoutMs,
                telemetry,
                run: (signal) => groq.chat.completions
                    .create(request, { signal, timeout: plan.timeoutMs, maxRetries: 0 })
                    .then((response) => toPayload(response.choices?.[0]?.message?.content?.trim() || '')),
            });

            if (attempt.state === 'ok') return serve(attempt.value, 'groq', route.id);
            lastDetail = attempt.outcome;
        }
    }

    // 2) Google-family fallbacks after the Groq pool.
    if (googleApiKey) {
        for (const [index, model] of GOOGLE_MODELS.entries()) {
            const plan = answerBudget.planAttempt({
                provider: 'google',
                elapsedMs: telemetry.elapsedMs,
                googleCandidatesRemaining: GOOGLE_MODELS.length - index,
            });
            if (plan.state === 'skip') {
                telemetry.skipped('google', model, plan.reason);
                lastDetail = plan.reason;
                break;
            }

            // The Google client takes its bound at construction, so one client per
            // attempt keeps each candidate inside the time this request can still
            // pay for. attempts:1 disables in-client retry for the same reason.
            const ai = new GoogleGenAI({
                apiKey: googleApiKey,
                httpOptions: { timeout: plan.timeoutMs, retryOptions: { attempts: 1 } },
            });

            const attempt = await runWithDeadline({
                label: 'interview-answer',
                provider: 'google',
                model,
                timeoutMs: plan.timeoutMs,
                telemetry,
                run: (signal) => ai.models.generateContent({
                    model,
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    config: { abortSignal: signal },
                }).then((response) => toPayload(response.text?.trim() || '')),
            });

            if (attempt.state === 'ok') return serve(attempt.value, 'google', model);
            lastDetail = attempt.outcome;
        }
    }

    console.info(telemetry.summary({ statusCode: 502, provider: null, model: null }));
    return errorResponse(502, '답변 생성에 실패했습니다.', { detail: lastDetail });
};