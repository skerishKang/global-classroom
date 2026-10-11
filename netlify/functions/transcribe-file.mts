import { GoogleGenAI } from '@google/genai';

const MODEL = 'gemini-3.5-transcribe';
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav',
  'audio/webm', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/ogg', 'audio/flac',
]);

function json(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function durationSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.replace(/s$/, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (value && typeof value === 'object') {
    const d = value as { seconds?: string | number; nanos?: number };
    const seconds = Number(d.seconds);
    return Number.isFinite(seconds) ? seconds + Number(d.nanos || 0) / 1e9 : null;
  }
  return null;
}

export function extractTranscription(response: any) {
  const segments: Array<{ speaker: string; text: string; start: number | null; end: number | null }> = [];
  for (const candidate of response?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      const annotation = part?.audioTranscription ?? part?.audio_transcription;
      if (!annotation) continue;
      const speaker = String(annotation.speakerLabel || annotation.speaker_label || '미확인');
      const words: any[] = annotation.words || [];
      if (words.length) {
        for (const word of words) {
          const text = String(word.word || '').trim();
          if (!text) continue;
          segments.push({
            speaker: String(word.speakerLabel || word.speaker_label || speaker),
            text,
            start: durationSeconds(word.startOffset ?? word.start_offset),
            end: durationSeconds(word.endOffset ?? word.end_offset),
          });
        }
      } else if (annotation.text) {
        segments.push({ speaker, text: String(annotation.text), start: null, end: null });
      }
    }
  }
  // Return plain text honestly when the model doesn't supply structured annotations.
  const text = typeof response?.text === 'string' && response.text.trim()
    ? response.text
    : segments.map((segment) => segment.text).join(' ');
  return { text, words: segments };
}

export default async (req: Request) => {
  if (req.method !== 'POST') return json(405, { error: 'POST만 지원합니다.' });

  const env = (globalThis as any).Netlify?.env;
  const apiKey = env?.get?.('GEMINI_API_KEY') || env?.get?.('API_KEY') ||
    process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) return json(503, { error: '서버에 Gemini API 키가 설정되지 않았습니다.' });

  const declaredLength = Number(req.headers.get('content-length') || '0');
  if (declaredLength > MAX_FILE_BYTES + 8192) {
    return json(413, { error: '파일 전사는 현재 4MB 이하로 제한됩니다.' });
  }

  let file: File | null = null;
  try {
    const data = await req.formData();
    const candidate = data.get('audio');
    if (candidate instanceof File) file = candidate;
  } catch {
    return json(400, { error: '음성 파일을 읽을 수 없습니다.' });
  }
  if (!file || !file.size || file.size > MAX_FILE_BYTES) {
    return json(400, { error: '4MB 이하의 음성 파일을 첨부해 주세요.' });
  }
  const mimeType = (file.type || '').toLowerCase() || (file.name.toLowerCase().endsWith('.mp3') ? 'audio/mp3' : '');
  if (!ALLOWED_MIME.has(mimeType)) return json(415, { error: '지원하지 않는 오디오 형식입니다.' });

  const client = new GoogleGenAI({ apiKey });
  let uploadedName: string | undefined;
  try {
    const uploaded = await client.files.upload({
      file: file as any,
      config: { mimeType },
    });
    uploadedName = uploaded.name;
    if (!uploaded.uri) throw new Error('Google Files API가 파일 주소를 반환하지 않았습니다.');
    const response = await client.models.generateContent({
      model: MODEL,
      contents: [{ fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType || mimeType } }],
      config: { audioTranscriptionConfig: { diarization: true, wordTimestamp: true } },
    });
    const normalized = extractTranscription(response);
    if (!normalized.text.trim() && !normalized.words.length) {
      return json(502, { error: '모델이 전사 결과를 반환하지 않았습니다.' });
    }
    return json(200, { ...normalized, model: MODEL });
  } catch (error) {
    const e = error as { status?: number; message?: string };
    const status = e.status === 429 ? 429 : e.status === 401 || e.status === 403 ? 503 : 502;
    return json(status, { error: status === 429
      ? 'Google 프로젝트의 사용 한도에 도달했습니다.'
      : status === 503 ? 'Gemini API 키 또는 모델 사용 권한을 확인해 주세요.'
        : '파일 전사에 실패했습니다. Google 모델 지원 여부와 파일 형식을 확인해 주세요.' });
  } finally {
    if (uploadedName) {
      try { await client.files.delete({ name: uploadedName }); } catch { /* temporary uploads expire independently */ }
    }
  }
};

export const config = {
  path: '/api/transcribe-file',
  rateLimit: { windowSize: 60, windowLimit: 2, aggregateBy: ['ip', 'domain'] },
};
