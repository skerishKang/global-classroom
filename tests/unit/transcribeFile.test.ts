import { describe, expect, it } from 'vitest';
import { extractTranscription } from '../../netlify/functions/transcribe-file.mts';

describe('Gemini transcribe response normalization', () => {
  it('preserves actual provider speaker labels and word offsets', () => {
    const result = extractTranscription({
      text: '안녕하세요 반갑습니다',
      candidates: [{ content: { parts: [{ audioTranscription: {
        speakerLabel: 'spk_1',
        words: [
          { word: '안녕하세요', startOffset: '0.25s', endOffset: '0.95s' },
          { word: '반갑습니다', startOffset: '1s', endOffset: '1.8s' },
        ],
      } }] } }],
    });
    expect(result.words).toEqual([
      { speaker: 'spk_1', text: '안녕하세요', start: 0.25, end: 0.95 },
      { speaker: 'spk_1', text: '반갑습니다', start: 1, end: 1.8 },
    ]);
    expect(result.text).toBe('안녕하세요 반갑습니다');
  });

  it('marks missing timestamps and speaker labels as unknown instead of inventing them', () => {
    const result = extractTranscription({
      text: '발화 내용', candidates: [{ content: { parts: [{ audioTranscription: { words: [{ word: '발화' }] } }] } }],
    });
    expect(result.words).toEqual([{ speaker: '미확인', text: '발화', start: null, end: null }]);
  });

  it('keeps a plain transcript when no annotations were returned', () => {
    expect(extractTranscription({ text: '전사문만 있음' })).toEqual({ text: '전사문만 있음', words: [] });
  });
});
