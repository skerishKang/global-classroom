import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GLOBAL_TRANSCRIBE_MODEL,
  MAX_FALLBACK_PCM_BYTES,
  buildGlobalTranscribeConfig,
} from '../../hooks/useGeminiLive';

describe('#58 Global Classroom voice transcription contract', () => {
  test('uses the dedicated Gemini 3.5 live transcription model', () => {
    expect(GLOBAL_TRANSCRIBE_MODEL).toBe('gemini-3.5-transcribe-live');
  });

  test('auto language uses text-only live transcription with automatic language detection', () => {
    expect(buildGlobalTranscribeConfig('auto')).toEqual({
      responseModalities: ['TEXT'],
      realtimeInputConfig: {
        automaticActivityDetection: {
          silenceDurationMs: 650,
        },
      },
      inputAudioTranscription: {
        languageCodes: [],
        mode: 'VERBATIM',
      },
    });
  });

  test('an explicit source language is passed as a transcription hint', () => {
    expect(buildGlobalTranscribeConfig('en').inputAudioTranscription.languageCodes).toEqual(['en']);
    expect(buildGlobalTranscribeConfig('ko').inputAudioTranscription.languageCodes).toEqual(['ko']);
  });

  test('bounded PCM recovery stays below the 3 MiB transcribe endpoint limit', () => {
    expect(MAX_FALLBACK_PCM_BYTES).toBeGreaterThan(0);
    expect(MAX_FALLBACK_PCM_BYTES).toBeLessThan(3 * 1024 * 1024);
  });

  test('live-empty and connection-failure paths have Browser/Groq fallbacks', () => {
    const source = readFileSync(join(process.cwd(), 'hooks/useGeminiLive.ts'), 'utf8');
    expect(source).toContain('recoverTurnWithGroq');
    expect(source).toContain('SpeechRecognition');
    expect(source).toContain('startGroqFallback');
    expect(source).toContain("postApi<{ text?: string }>('transcribe'");
    expect(source).not.toContain('model: MODEL_LIVE');
    expect(source).not.toContain('responseModalities: [Modality.AUDIO]');
  });
});
