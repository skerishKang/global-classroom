import { base64ToUint8Array, arrayBufferToBase64 } from './audioUtils';

const MAX_TTS_CHARS = 200;

const splitTextForTts = (input: string): string[] => {
    if (input.length <= MAX_TTS_CHARS) return [input];

    const separators = new Set(['.', '!', '?', '。', '！', '？', '\n']);
    const sentences: string[] = [];
    let current = '';
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        current += ch;
        if (separators.has(ch)) {
            const s = current.trim();
            if (s) sentences.push(s);
            current = '';
        }
    }
    if (current.trim()) sentences.push(current.trim());

    const chunks: string[] = [];
    let buf = '';

    const pushHardSplit = (s: string) => {
        for (let i = 0; i < s.length; i += MAX_TTS_CHARS) {
            const part = s.slice(i, i + MAX_TTS_CHARS).trim();
            if (part) chunks.push(part);
        }
    };

    for (const s of sentences) {
        if (!buf) {
            if (s.length <= MAX_TTS_CHARS) {
                buf = s;
            } else {
                pushHardSplit(s);
                buf = '';
            }
            continue;
        }

        const next = `${buf} ${s}`;
        if (next.length <= MAX_TTS_CHARS) {
            buf = next;
            continue;
        }

        chunks.push(buf);
        if (s.length <= MAX_TTS_CHARS) {
            buf = s;
        } else {
            pushHardSplit(s);
            buf = '';
        }
    }

    if (buf) chunks.push(buf);
    return chunks;
};

export const generateTtsBase64 = async (text: string, voiceName: string, model: string): Promise<string | null> => {
    try {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (!normalized) return null;

        const chunks = splitTextForTts(normalized);
        const pcmChunks: Uint8Array[] = [];

        for (const chunk of chunks) {
            const res = await fetch('/api/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: chunk, voiceName, model }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                const errorMessage = (json as any)?.error || 'TTS 요청에 실패했습니다.';
                const detailMessage = (json as any)?.detail;
                throw new Error(detailMessage ? `${errorMessage} (${detailMessage})` : errorMessage);
            }
            const audioBase64 = typeof (json as any).audioBase64 === 'string' ? (json as any).audioBase64 : '';
            if (!audioBase64) {
                throw new Error('TTS 오디오 생성 결과가 비어있습니다.');
            }
            pcmChunks.push(base64ToUint8Array(audioBase64));
        }

        const totalLen = pcmChunks.reduce((sum, x) => sum + x.byteLength, 0);
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const x of pcmChunks) {
            merged.set(x, offset);
            offset += x.byteLength;
        }
        return arrayBufferToBase64(merged.buffer);
    } catch (e) {
        console.error('TTS 생성 실패', e);
        return null;
    }
};
