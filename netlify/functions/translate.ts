import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import {
  enforceBodySize,
  enforceTextLimit,
  errorResponse,
  readJsonBody,
  safeErrorDetail,
  MAX_GLOSSARY_ENTRIES,
  MAX_GLOSSARY_TERM_CHARS,
  MAX_LANGUAGE_LABEL_CHARS,
  MAX_TRANSLATE_BODY_BYTES,
  MAX_TRANSLATE_TEXT_CHARS,
} from './_aiGuards';
import {
  TranslationTelemetry,
  classifyProviderError,
  planAttempt,
  type AttemptOutcome,
  type TranslationProvider,
} from './_translationBudget';

type GroqRoute = {
  id: string;
  reasoningEffort: 'low' | 'none';
};

// Speed-first order for interview translation.
// Free-plan limits are model-specific, so exhausting one model can fall through to the next.
const GROQ_MODELS: GroqRoute[] = [
  { id: 'openai/gpt-oss-20b', reasoningEffort: 'low' },   // ~1000 t/s, production
  { id: 'openai/gpt-oss-120b', reasoningEffort: 'low' },  // ~500 t/s, production
  { id: 'qwen/qwen3.8-27b', reasoningEffort: 'none' },     // ~450+ t/s, strong multilingual
];

// Google-family fallbacks after Groq, in the owner-approved order.
// Owner instruction (2026-10-12): the pool is the three Groq routes plus these
// two Gemini Flash-Lite fallbacks; the Gemma 4 entries were removed from it.
const GOOGLE_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
];

/**
 * Run one provider attempt inside a hard wall-clock bound and report what
 * happened.
 *
 * The bound is enforced twice on purpose. The `AbortSignal` is handed to the
 * provider so a stalled request is really cancelled and its socket released
 * instead of finishing in the background after we already answered. The deadline
 * is also raced locally, because a bound that depends on the provider honouring
 * cancellation is not a bound: a client that ignores its signal would otherwise
 * keep the handler waiting past the platform window this change exists to fit in.
 */
async function withDeadline<T>(input: {
  provider: TranslationProvider;
  model: string;
  timeoutMs: number;
  telemetry: TranslationTelemetry;
  run: (signal: AbortSignal) => Promise<T | null>;
}): Promise<{ state: 'ok'; value: T } | { state: 'failed'; outcome: AttemptOutcome }> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(Object.assign(
        new Error(`${input.provider} ${input.model} exceeded its ${input.timeoutMs}ms budget`),
        { name: 'AbortError' },
      ));
    }, input.timeoutMs);
  });

  const startedAt = Date.now();

  try {
    const value = await Promise.race([input.run(controller.signal), deadline]);
    const ms = Date.now() - startedAt;
    if (value === null) {
      input.telemetry.record({ provider: input.provider, model: input.model, ms, outcome: 'empty_response' });
      return { state: 'failed', outcome: 'empty_response' };
    }
    input.telemetry.record({ provider: input.provider, model: input.model, ms, outcome: 'ok' });
    return { state: 'ok', value };
  } catch (error: any) {
    const ms = Date.now() - startedAt;
    // A deadline abort is reported as a timeout, not as a generic abort: the
    // distinction is what tells an operator that the bound fired.
    const outcome: AttemptOutcome = timedOut
      ? 'timeout'
      : classifyProviderError(error);
    input.telemetry.record({ provider: input.provider, model: input.model, ms, outcome });
    console.error(
      `translate: ${input.provider} ${input.model} failed after ${ms}ms `
      + `(${outcome}):`,
      safeErrorDetail(error),
    );
    return { state: 'failed', outcome };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Covers the success path too: a provider promise that resolved late, or is
    // still pending after we lost interest, must not keep running.
    controller.abort();
  }
}

const translationPrompt = (
  text: string,
  from: string,
  to: string,
  glossary: Array<{ source: string; target: string }>,
) => {
  const glossaryBlock = glossary.length
    ? `\nPreferred terminology (apply when relevant, do not invent occurrences):\n${glossary
        .map((entry) => `- ${entry.source} => ${entry.target}`)
        .join('\n')}`
    : '';

  return `Translate the following text from ${from} to ${to}.
Preserve the speaker's meaning, technical terminology, numbers, product names, uncertainty, sentence boundaries, paragraph breaks, and list structure as closely as the target language allows.
Do not summarize, combine separate ideas, omit repetitions, or rewrite the speaker's argument.
Apply the preferred terminology exactly when the matching source term occurs.
Output ONLY the translated text, with no explanation or quotation marks.${glossaryBlock}

Text:
${text}`;
};

export const handler = async (event: any) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '허용되지 않은 메서드입니다.' }),
    };
  }

  const userApiKey = event.headers['x-user-api-key'];
  const geminiApiKey = userApiKey || process.env.GEMINI_API_KEY || process.env.API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;

  if (!geminiApiKey && !groqApiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'API 키가 설정되지 않았습니다.' }),
    };
  }

  const tooLarge = enforceBodySize(event, MAX_TRANSLATE_BODY_BYTES);
  if (tooLarge) return tooLarge;

  // Malformed JSON is an explicit 400 instead of being silently treated as {} (#36).
  const parsedBody = readJsonBody(event);
  if (parsedBody.ok === false) return parsedBody.response;
  const body = parsedBody.body;

  // NOTE (#36): a caller-provided "model" field is intentionally ignored.
  // Models are selected server-side from the allowlists below.
  const text = typeof body.text === 'string' ? body.text : '';
  const from = typeof body.from === 'string' ? body.from : '';
  const to = typeof body.to === 'string' ? body.to : '';
  const glossary = Array.isArray(body.glossary)
    ? body.glossary
        .filter((entry: any) => entry && typeof entry.source === 'string' && typeof entry.target === 'string')
        .map((entry: any) => ({ source: entry.source.trim(), target: entry.target.trim() }))
        .filter((entry: any) => entry.source && entry.target)
        .slice(0, MAX_GLOSSARY_ENTRIES)
    : [];

  if (!text.trim() || !from || !to) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '필수 값(text/from/to)이 누락되었습니다.' }),
    };
  }

  const langOversize = enforceTextLimit(from, MAX_LANGUAGE_LABEL_CHARS, 'from')
    || enforceTextLimit(to, MAX_LANGUAGE_LABEL_CHARS, 'to');
  if (langOversize) return langOversize;

  const oversizedGlossaryTerm = glossary.find(
    (entry) => entry.source.length > MAX_GLOSSARY_TERM_CHARS || entry.target.length > MAX_GLOSSARY_TERM_CHARS
  );
  if (oversizedGlossaryTerm) {
    return errorResponse(413, `glossary source/target 값이 너무 깁니다. 최대 ${MAX_GLOSSARY_TERM_CHARS}자까지 허용됩니다.`);
  }

  const oversize = enforceTextLimit(text, MAX_TRANSLATE_TEXT_CHARS, 'text');
  if (oversize) return oversize;

  const prompt = translationPrompt(text, from, to, glossary);
  const telemetry = new TranslationTelemetry(() => Date.now());
  let lastDetail = 'unknown';

  const succeed = (translated: string, provider: TranslationProvider, model: string) => {
    console.info(telemetry.summary({ statusCode: 200, provider, model }));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ translated, model, provider }),
    };
  };

  // 1) Groq first: lowest latency for the interview path.
  if (groqApiKey) {
    // maxRetries 0: a retry inside one route would double the latency of a model
    // that already failed, while the next route is a genuine fallback.
    const groq = new Groq({ apiKey: groqApiKey, maxRetries: 0 });

    for (const route of GROQ_MODELS) {
      const plan = planAttempt({
        provider: 'groq',
        elapsedMs: telemetry.elapsedMs,
        googleCandidatesRemaining: geminiApiKey ? GOOGLE_MODELS.length : 0,
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
      };

      if (route.reasoningEffort !== 'none') {
        request.reasoning_format = 'hidden';
      }

      const attempt = await withDeadline({
        provider: 'groq',
        model: route.id,
        timeoutMs: plan.timeoutMs,
        telemetry,
        run: (signal) => groq.chat.completions
          .create(request, { signal, timeout: plan.timeoutMs, maxRetries: 0 })
          // An empty completion is a failure of THIS route, not a success: the
          // caller must never receive a blank translation.
          .then((response) => {
            const translated = response.choices?.[0]?.message?.content?.trim() || '';
            return translated || null;
          }),
      });

      if (attempt.state === 'ok') return succeed(attempt.value, 'groq', route.id);
      lastDetail = attempt.outcome;
    }
  }

  // 2) Google-family fallbacks after the Groq pool.
  if (geminiApiKey) {
    for (const [index, model] of GOOGLE_MODELS.entries()) {
      const plan = planAttempt({
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
      // attempt keeps each candidate inside the time this request can still pay
      // for. attempts:1 disables in-client retry for the same reason as Groq.
      const ai = new GoogleGenAI({
        apiKey: geminiApiKey,
        httpOptions: { timeout: plan.timeoutMs, retryOptions: { attempts: 1 } },
      });

      const attempt = await withDeadline({
        provider: 'google',
        model,
        timeoutMs: plan.timeoutMs,
        telemetry,
        run: (signal) => ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: { abortSignal: signal },
        }).then((response) => response.text?.trim() || null),
      });

      if (attempt.state === 'ok') return succeed(attempt.value, 'google', model);
      lastDetail = attempt.outcome;
    }
  }

  console.info(telemetry.summary({ statusCode: 500, provider: null, model: null }));
  return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      error: '번역에 실패했습니다. 사용 가능한 번역 모델을 모두 시도했습니다.',
      detail: lastDetail,
    }),
  };
};
