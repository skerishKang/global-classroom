import { redactSecrets } from './_aiGuards';
import { AI_RATE_LIMITS, enforceAiUsageGate } from './_rateLimit';

const STT_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'];
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
// #111: 플랫폼 함수 창(약 10초) 안에서 외부 STT 호출 전체를 묶는다. 오래 걸리는
// 업스트림은 남은 예산만큼만 시도되고, 예산이 끝나면 명확한 504로 끝난다.
const STT_TOTAL_BUDGET_MS = 9_000;
const STT_MIN_ATTEMPT_MS = 1_500;

function json(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function parseAudioDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(audio\/[a-zA-Z0-9.+-]+(?:;[^,]*)?);base64,(.+)$/s);
  if (!match) return null;

  const mimeType = match[1].split(';')[0].toLowerCase();
  const bytes = Buffer.from(match[2], 'base64');

  const extension =
    mimeType.includes('webm') ? 'webm'
      : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a'
        : mimeType.includes('wav') ? 'wav'
          : mimeType.includes('mpeg') || mimeType.includes('mp3') ? 'mp3'
            : 'webm';

  return { mimeType, bytes, extension };
}

export type SttOutcome = 'http_error' | 'empty' | 'timeout' | 'network';

export interface SttAttemptInput {
  apiKey: string;
  model: string;
  audio: { mimeType: string; bytes: Buffer; extension: string };
  language: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export type SttAttemptResult =
  | { ok: 'ok'; text: string }
  | { ok: 'failed'; outcome: SttOutcome; error: string };

/**
 * #111: 한 모델의 외부 STT 호출을 시간 제한 안에 묶는다. AbortSignal을 업스트림에
 * 넘겨 멈춘 요청이 실제로 취소되게 하고, 동시에 로컬 마감과 경주해 신호를 무시하는
 * 구현에도 경계가 유효하도록 한다(_providerBudget.runWithDeadline과 같은 이중 잠금).
 */
export async function runSttAttempt(input: SttAttemptInput): Promise<SttAttemptResult> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(Object.assign(new Error(`STT 시간 제한(${input.timeoutMs}ms)을 초과했습니다.`), { name: 'AbortError' }));
    }, input.timeoutMs);
  });

  const attempt = async (): Promise<string | null> => {
    const doFetch = input.fetchImpl ?? fetch;
    const form = new FormData();
    form.append(
      'file',
      new Blob([input.audio.bytes], { type: input.audio.mimeType }),
      `interview-audio.${input.audio.extension}`
    );
    form.append('model', input.model);
    if (input.language !== 'auto') {
      form.append('language', input.language);
    }
    form.append('response_format', 'json');
    form.append('temperature', '0');

    const response = await doFetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: form,
      signal: controller.signal,
    });

    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(
        new Error(data?.error?.message || data?.error || `Groq STT HTTP ${response.status}`),
        { sttOutcome: 'http_error' },
      );
    }

    const text = typeof data?.text === 'string' ? data.text.trim() : '';
    return text || null;
  };

  try {
    const text = await Promise.race([attempt(), deadline]);
    if (text === null) {
      return { ok: 'failed', outcome: 'empty', error: `${input.model} returned an empty transcript` };
    }
    return { ok: 'ok', text };
  } catch (error: any) {
    if (timedOut) {
      return { ok: 'failed', outcome: 'timeout', error: `STT 시간 제한(${input.timeoutMs}ms)을 초과했습니다.` };
    }
    if (error?.sttOutcome === 'http_error') {
      return { ok: 'failed', outcome: 'http_error', error: redactSecrets(String(error.message || error)) };
    }
    return { ok: 'failed', outcome: 'network', error: redactSecrets(error?.message || String(error)) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // 성공 경로에서도 늦게 도착하는 업스트림이 백그라운드에서 계속 도는 일을 막는다.
    controller.abort();
  }
}

export default async (req: Request) => {
  if (req.method !== 'POST') {
    return json(405, { error: '허용되지 않은 메서드입니다.' });
  }

  // #111/#120: 사용량 보호 — 통합 게이트가 버스트·분당 예산과 함께 공용
  // 맛보기(기기·세션 단위) 누적을 센다. 키가 있는 요청은 맛보기 대상이 아니다.
  const limited = await enforceAiUsageGate(
    { headers: Object.fromEntries(req.headers) } as any,
    AI_RATE_LIMITS.transcribe,
  );
  if (limited) {
    return json(
      limited.statusCode,
      JSON.parse(limited.body),
      limited.headers,
    );
  }

  const startedAt = Date.now();
  const groqApiKey = (globalThis as any).Netlify?.env?.get?.('GROQ_API_KEY') || '';
  if (!groqApiKey) {
    return json(500, { error: 'GROQ_API_KEY가 설정되지 않았습니다.' });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: '요청 본문을 읽을 수 없습니다.' });
  }

  const audioDataUrl = typeof body?.audioDataUrl === 'string' ? body.audioDataUrl : '';
  const language =
    body?.language === 'en'
      ? 'en'
      : body?.language === 'ko'
        ? 'ko'
        : body?.language === 'auto'
          ? 'auto'
          : '';

  if (!language) {
    return json(400, { error: 'language는 ko, en 또는 auto여야 합니다.' });
  }

  const audio = parseAudioDataUrl(audioDataUrl);
  if (!audio) {
    return json(400, { error: '지원되는 오디오 데이터가 필요합니다.' });
  }
  if (!audio.bytes.length) {
    return json(400, { error: '빈 오디오 데이터입니다.' });
  }
  if (audio.bytes.length > MAX_AUDIO_BYTES) {
    return json(413, { error: '오디오가 너무 깁니다. 답변을 짧게 나누어 다시 시도해 주세요.' });
  }

  let lastError = '';
  let lastOutcome: SttOutcome = 'network';

  for (const model of STT_MODELS) {
    // 남은 예산이 한 번의 시도도 못 하면 여기서 명확히 끝낸다(플랫폼 504보다 빠르고).
    const remaining = STT_TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (remaining < STT_MIN_ATTEMPT_MS) {
      lastError = 'STT 시간 예산을 모두 사용했습니다.';
      lastOutcome = 'timeout';
      break;
    }

    const result = await runSttAttempt({ apiKey: groqApiKey, model, audio, language, timeoutMs: remaining });
    if (result.ok === 'ok') {
      return json(200, {
        text: result.text,
        provider: 'groq',
        model,
      });
    }

    lastError = result.error;
    lastOutcome = result.outcome;
    console.error(`transcribe: ${model} failed (${result.outcome}):`, redactSecrets(result.error));
  }

  const status = lastOutcome === 'timeout' ? 504 : 502;
  return json(status, {
    error: '음성 전사에 실패했습니다.',
    detail: redactSecrets(lastError),
    outcome: lastOutcome,
  });
};

export const config = {
  path: '/api/transcribe',
};
