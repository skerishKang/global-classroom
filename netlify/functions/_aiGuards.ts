// Shared request-bound guards for the public AI endpoints (#36).
//
// These helpers bound payload size and model selection BEFORE any provider
// call. They deliberately have no provider dependencies so they can be unit
// tested without network access.
//
// Personal API keys travel through the `x-user-api-key` header (#32 contract):
// do not change that forwarding path, and never log or echo key values.

export type AiJsonResponse = {
  statusCode: number;
  headers: { 'Content-Type': string };
  body: string;
};

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

// --- Payload bounds -------------------------------------------------------
// Limits are derived from the real client payloads:
// - translate/detect: a single conversation turn (same text on the auto path)
// - summary: full conversation join built in App.tsx handleSummarize
// - tts: utils/tts.ts already splits into <=200 char chunks, so 600 is a 3x margin
// - vision: CameraView captures at most 1280px JPEG q0.72 (decoded byte check)
// - live-token: a tiny { model } body
export const MAX_TRANSLATE_TEXT_CHARS = 12_000;
// detect-language receives the identical turn text as translate (auto-detect
// path in useTranslationService), so its bound must not be smaller.
export const MAX_DETECT_TEXT_CHARS = 12_000;
export const MAX_SUMMARY_TEXT_CHARS = 60_000;
export const MAX_TTS_TEXT_CHARS = 600;
export const MAX_VISION_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_LIVE_TOKEN_BODY_BYTES = 2 * 1024;

// --- Model allowlists -----------------------------------------------------
// Only models already used by this repo's clients:
// - tts/vision: constants.ts MODEL_TTS / MODEL_VISION
// - live: MODEL_LIVE plus the interview session models (useInterviewLive.ts)
export const ALLOWED_TTS_MODELS = ['gemini-2.5-flash-preview-tts'] as const;
export const ALLOWED_VISION_MODELS = ['gemini-3.5-flash-lite', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it'] as const;
export const ALLOWED_LIVE_MODELS = [
  'gemini-2.5-flash-native-audio-preview-09-2025', // classroom mic mode (useGeminiLive)
  'gemini-3.5-transcribe-live', // interview STT (useInterviewLive)
  'gemini-3.5-live-translate-preview', // interview translation (useInterviewLive)
] as const;

// --- Secondary provider-facing inputs (#36 follow-up) ---------------------
// translate from/to are language display names (constants.ts SUPPORTED_LANGUAGES.name).
export const MAX_LANGUAGE_LABEL_CHARS = 100;
// vision langA/langB are language codes ('ko', 'en', ... or 'auto').
export const MAX_LANGUAGE_CODE_CHARS = 32;
// Glossary: entry count stays bounded by slicing; oversized kept terms are
// rejected explicitly instead of being silently truncated.
export const MAX_GLOSSARY_ENTRIES = 100;
export const MAX_GLOSSARY_TERM_CHARS = 200;
// tts voiceName: only the voices shipped in constants.ts VOICE_OPTIONS.
export const ALLOWED_TTS_VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'] as const;
// Defense-in-depth request body caps (valid payloads stay well below these).
export const MAX_TRANSLATE_BODY_BYTES = 256 * 1024;
export const MAX_VISION_BODY_BYTES = 5 * 1024 * 1024;

// --- Responses ------------------------------------------------------------
export function errorResponse(
  statusCode: number,
  error: string,
  extra?: Record<string, unknown>,
): AiJsonResponse {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error, ...(extra || {}) }),
  };
}

export function jsonResponse(statusCode: number, payload: Record<string, unknown>): AiJsonResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

// --- Body parsing / size --------------------------------------------------
export function getRawBody(event: any): string {
  if (event?.isBase64Encoded) {
    return Buffer.from(event.body || '', 'base64').toString('utf-8');
  }
  return event?.body || '';
}

export function enforceBodySize(event: any, maxBytes: number): AiJsonResponse | null {
  if (Buffer.byteLength(getRawBody(event), 'utf-8') > maxBytes) {
    return errorResponse(413, `요청 본문이 너무 큽니다. 최대 ${maxBytes} bytes까지 허용됩니다.`);
  }
  return null;
}

/** Parse the Netlify event body. Malformed JSON is an explicit 400 (#36). */
export function readJsonBody(event: any):
  | { ok: true; body: any }
  | { ok: false; response: AiJsonResponse } {
  const raw = getRawBody(event);
  if (!raw) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, response: errorResponse(400, '요청 본문은 JSON 객체여야 합니다.') };
    }
    return { ok: true, body: parsed };
  } catch {
    return { ok: false, response: errorResponse(400, '요청 본문이 올바른 JSON이 아닙니다.') };
  }
}

// --- Text / image bounds --------------------------------------------------
export function enforceTextLimit(text: string, maxChars: number, field: string): AiJsonResponse | null {
  if (text.length > maxChars) {
    return errorResponse(413, `${field} 값이 너무 깁니다. 최대 ${maxChars}자까지 허용됩니다.`);
  }
  return null;
}

export function decodedBase64Bytes(base64: string): number {
  return Buffer.from(base64, 'base64').length;
}

// --- Value guards ---------------------------------------------------------
export function isAllowedString(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

// --- Secret redaction -----------------------------------------------------
/** Strip credential-like substrings so provider errors can be logged/returned safely. */
export function redactSecrets(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z_\-]{10,}/g, '[redacted]')
    .replace(/gsk_[0-9A-Za-z_\-]{10,}/g, '[redacted]')
    .replace(/Bearer\s+[0-9A-Za-z._\-]{8,}/gi, 'Bearer [redacted]');
}

export function safeErrorDetail(error: unknown, maxLength = 300): string {
  const raw =
    error instanceof Error ? error.message
      : typeof error === 'string' ? error
        : error ? String(error) : '';
  return redactSecrets(raw).slice(0, maxLength);
}
