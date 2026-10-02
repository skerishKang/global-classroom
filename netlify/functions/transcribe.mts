const STT_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'];
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function estimateBase64Bytes(dataUrl: string) {
  const comma = dataUrl.indexOf(',');
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor((payload.length * 3) / 4);
}

export default async (req: Request) => {
  if (req.method !== 'POST') {
    return json(405, { error: '허용되지 않은 메서드입니다.' });
  }

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
  const language = body?.language === 'en' ? 'en' : body?.language === 'ko' ? 'ko' : '';

  if (!audioDataUrl.startsWith('data:audio/') || !audioDataUrl.includes(';base64,')) {
    return json(400, { error: '지원되는 오디오 데이터가 필요합니다.' });
  }
  if (!language) {
    return json(400, { error: 'language는 ko 또는 en이어야 합니다.' });
  }
  if (estimateBase64Bytes(audioDataUrl) > MAX_AUDIO_BYTES) {
    return json(413, { error: '오디오가 너무 깁니다. 답변을 짧게 나누어 다시 시도해 주세요.' });
  }

  let lastError = '';

  for (const model of STT_MODELS) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${groqApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          url: audioDataUrl,
          language,
          response_format: 'json',
          temperature: 0,
        }),
      });

      const data: any = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastError = data?.error?.message || data?.error || `Groq STT HTTP ${response.status}`;
        console.error(`transcribe: ${model} failed:`, lastError);
        continue;
      }

      const text = typeof data?.text === 'string' ? data.text.trim() : '';
      if (!text) {
        lastError = `${model} returned an empty transcript`;
        continue;
      }

      return json(200, {
        text,
        provider: 'groq',
        model,
      });
    } catch (error: any) {
      lastError = error?.message || String(error);
      console.error(`transcribe: ${model} failed:`, lastError);
    }
  }

  return json(502, {
    error: '음성 전사에 실패했습니다.',
    detail: lastError,
  });
};

export const config = {
  path: '/api/transcribe',
};
