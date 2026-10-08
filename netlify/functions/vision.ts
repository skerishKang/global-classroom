import { GoogleGenAI, Type } from '@google/genai';
import Groq from 'groq-sdk';
import {
  decodedBase64Bytes, enforceBodySize, enforceTextLimit, errorResponse,
  isAllowedString, readJsonBody, safeErrorDetail, ALLOWED_VISION_MODELS,
  MAX_LANGUAGE_CODE_CHARS, MAX_VISION_IMAGE_BYTES, MAX_VISION_BODY_BYTES,
} from './_aiGuards';

export const VISION_MODEL_ORDER = [
  'gemini-3.5-flash-lite', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it',
] as const;

export function parseVisionResult(raw: string): { originalText: string; translatedText: string } | null {
  const stripped = String(raw || '').replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(stripped.slice(start, end + 1));
    if (typeof data.originalText !== 'string') return null;
    return {
      originalText: data.originalText.trim().slice(0, 12_000),
      translatedText: typeof data.translatedText === 'string' ? data.translatedText.trim().slice(0, 12_000) : '',
    };
  } catch { return null; }
}

export const handler = async (event: any) => {
  if (event.httpMethod !== 'POST') return errorResponse(405, 'Method not allowed');
  const oversized = enforceBodySize(event, MAX_VISION_BODY_BYTES);
  if (oversized) return oversized;
  const payload = readJsonBody(event);
  if (payload.ok === false) return payload.response;

  const { base64Image, langA, langB } = payload.body;
  const extractOnly = payload.body.extractOnly === true;
  const preferred = payload.body.model === undefined ? VISION_MODEL_ORDER[0] : payload.body.model;
  if (typeof base64Image !== 'string' || !base64Image ||
      typeof langA !== 'string' || !langA || typeof langB !== 'string' || !langB) {
    return errorResponse(400, 'base64Image/langA/langB are required');
  }
  const badLang = enforceTextLimit(langA, MAX_LANGUAGE_CODE_CHARS, 'langA')
    || enforceTextLimit(langB, MAX_LANGUAGE_CODE_CHARS, 'langB');
  if (badLang) return badLang;
  if (!isAllowedString(preferred, ALLOWED_VISION_MODELS)) {
    return errorResponse(400, 'Unsupported vision model');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Image) || base64Image.length % 4 !== 0) {
    return errorResponse(400, 'Invalid base64 JPEG data');
  }
  if (decodedBase64Bytes(base64Image) > MAX_VISION_IMAGE_BYTES) {
    return errorResponse(413, 'Image exceeds 3MB decoded limit');
  }
  // All UI sources are converted into a bounded JPEG before POST.
  const bytes = Buffer.from(base64Image, 'base64');
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return errorResponse(400, 'Expected JPEG image');
  }
  const key = event.headers?.['x-user-api-key'] || process.env.GEMINI_API_KEY || process.env.API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  if (!key && !groqKey) return errorResponse(500, 'Vision API keys are not configured');

  const prompt = extractOnly
    ? `Read this screenshot/photo as an interview prompt. Transcribe ALL legible on-screen text in natural reading order, preserving questions, code, formulas, units and important labels. If there is no text but a meaningful graph or diagram, describe precisely what it shows (do not invent an unseen question). If nothing readable or meaningful appears, return empty originalText. Reply ONLY with valid JSON: {"originalText":"...","translatedText":""}.`
    : `Analyze the text in this image. If text is in ${langA}, translate it into ${langB}; if in ${langB}, translate it into ${langA}; otherwise translate it into ${langA}. Preserve the original faithfully. Reply ONLY with valid JSON: {"originalText":"...","translatedText":"..."}.`;

  const order = [preferred, ...VISION_MODEL_ORDER.filter((model) => model !== preferred)];
  let lastError = '';
  for (const model of key ? order : []) {
    try {
      // A stalled model must not prevent the next image-capable fallback.
      // The Google SDK requires a request timeout of at least 10 seconds.
      const ai = new GoogleGenAI({
        apiKey: key,
        httpOptions: { timeout: 10_000, retryOptions: { attempts: 1 } },
      });
      const result = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [
          { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
          { text: prompt },
        ] }],
        ...(model.startsWith('gemini-') ? { config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              originalText: { type: Type.STRING },
              translatedText: { type: Type.STRING },
            },
            required: ['originalText', 'translatedText'],
          },
        } } : {}),
      });
      const parsed = parseVisionResult(result.text || '');
      if (!parsed) throw new Error('Invalid vision JSON');
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      };
    } catch (error) {
      lastError = safeErrorDetail(error);
      console.error('Vision provider failed:', model, lastError);
    }
  }
  // The already-connected Groq Qwen3.8 model supports image data URIs and
  // JSON mode; use it only after all configured Google vision models fail.
  if (groqKey) {
    try {
      const groq = new Groq({ apiKey: groqKey });
      const response = await groq.chat.completions.create({
        model: 'qwen/qwen3.8-27b',
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64Image } },
        ] }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_completion_tokens: 1400,
      } as any);
      const parsed = parseVisionResult(response.choices?.[0]?.message?.content || '');
      if (!parsed) throw new Error('Invalid Groq vision JSON');
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      };
    } catch (error) {
      lastError = safeErrorDetail(error);
      console.error('Vision Groq fallback failed:', lastError);
    }
  }
  return errorResponse(502, '이미지 분석이 실패했습니다.', lastError ? { detail: lastError } : undefined);
};
