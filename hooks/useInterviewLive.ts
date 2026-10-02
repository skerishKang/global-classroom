import { useCallback, useRef, useState } from 'react';
import { GoogleGenAI } from '@google/genai';
import { arrayBufferToBase64, float32ToInt16 } from '../utils/audioUtils';

export type InterviewLiveStatus = 'idle' | 'connecting' | 'live' | 'error';

type LiveTranslationTarget = 'en' | 'ko';

type UseInterviewLiveOptions = {
  onInterimTranscript: (text: string) => void;
  onFinalTranscript: (text: string) => void;
  onLiveTranslation: (target: LiveTranslationTarget, text: string) => void;
  onWarning?: (message: string) => void;
  onFatalError?: (message: string) => void;
};

const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live';
const TRANSLATE_MODEL = 'gemini-3.5-live-translate-preview';

const CUSTOM_VOCABULARY = [
  'Padiem',
  'Padiem Claw',
  'Control Plane',
  'Cloudflare',
  'Netlify',
  'Neon',
  'Gemini',
  'Groq',
  'GPT-OSS',
  'TypeScript',
  'React',
  'Playwright',
  'WebRTC',
  'Firebase',
  'Google Drive',
  'R2',
  'D1',
  'Kubernetes',
];

function mergeStreamText(previous: string, incoming: string) {
  const next = incoming.trim();
  if (!next) return previous;
  if (!previous) return next;
  if (next.startsWith(previous)) return next;
  if (previous.endsWith(next)) return previous;
  const spacer = /\s$/.test(previous) || /^\s/.test(incoming) ? '' : ' ';
  return `${previous}${spacer}${next}`;
}

async function fetchLiveToken(model: string) {
  const response = await fetch('/api/live-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.token) {
    throw new Error(data?.detail || data?.error || `Live token failed for ${model}`);
  }
  return String(data.token);
}

export function useInterviewLive({
  onInterimTranscript,
  onFinalTranscript,
  onLiveTranslation,
  onWarning,
  onFatalError,
}: UseInterviewLiveOptions) {
  const [status, setStatus] = useState<InterviewLiveStatus>('idle');
  const [translatePreviewAvailable, setTranslatePreviewAvailable] = useState(false);
  const desiredRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const transcribeSessionRef = useRef<any>(null);
  const translateEnSessionRef = useRef<any>(null);
  const translateKoSessionRef = useRef<any>(null);
  const enPreviewRef = useRef('');
  const koPreviewRef = useRef('');

  const closeSession = useCallback((session: any) => {
    try {
      session?.close?.();
    } catch {
      // no-op
    }
  }, []);

  const cleanup = useCallback(() => {
    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch {
        // no-op
      }
      processorRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (inputContextRef.current) {
      void inputContextRef.current.close().catch(() => {});
      inputContextRef.current = null;
    }

    closeSession(transcribeSessionRef.current);
    closeSession(translateEnSessionRef.current);
    closeSession(translateKoSessionRef.current);
    transcribeSessionRef.current = null;
    translateEnSessionRef.current = null;
    translateKoSessionRef.current = null;
    enPreviewRef.current = '';
    koPreviewRef.current = '';
    setTranslatePreviewAvailable(false);
  }, [closeSession]);

  const stop = useCallback(() => {
    desiredRef.current = false;
    cleanup();
    setStatus('idle');
  }, [cleanup]);

  const connectTranslationSession = useCallback(async (
    token: string,
    targetLanguageCode: LiveTranslationTarget,
  ) => {
    const ai = new GoogleGenAI({ apiKey: token, apiVersion: 'v1beta' });
    const ref = targetLanguageCode === 'en' ? enPreviewRef : koPreviewRef;

    const session = await ai.live.connect({
      model: TRANSLATE_MODEL,
      config: {
        responseModalities: ['AUDIO'],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        translationConfig: {
          targetLanguageCode,
          echoTargetLanguage: false,
        },
      } as any,
      callbacks: {
        onopen: () => {},
        onmessage: (message: any) => {
          const content = message?.serverContent;
          const translatedChunk = content?.outputTranscription?.text;
          if (translatedChunk) {
            ref.current = mergeStreamText(ref.current, translatedChunk);
            onLiveTranslation(targetLanguageCode, ref.current);
          }
          if (content?.turnComplete || content?.generationComplete) {
            ref.current = '';
          }
        },
        onerror: (error: any) => {
          onWarning?.(
            `실시간 ${targetLanguageCode === 'en' ? '영어' : '한국어'} 번역 미리보기 연결 오류: ${error?.message || error}`
          );
        },
        onclose: () => {},
      },
    } as any);

    return session;
  }, [onLiveTranslation, onWarning]);

  const start = useCallback(async () => {
    if (desiredRef.current) return;
    desiredRef.current = true;
    setStatus('connecting');
    cleanup();

    try {
      const transcribeToken = await fetchLiveToken(TRANSCRIBE_MODEL);
      if (!desiredRef.current) return;

      const transcribeAi = new GoogleGenAI({ apiKey: transcribeToken, apiVersion: 'v1beta' });
      const transcribeSession = await transcribeAi.live.connect({
        model: TRANSCRIBE_MODEL,
        config: {
          responseModalities: ['TEXT'],
          inputAudioTranscription: {
            languageCodes: [],
            customVocabulary: CUSTOM_VOCABULARY,
            mode: 'VERBATIM',
          },
        } as any,
        callbacks: {
          onopen: () => {},
          onmessage: (message: any) => {
            const content = message?.serverContent;
            const interim = content?.interimInputTranscription?.text;
            const finalText = content?.inputTranscription?.text;

            if (interim) {
              onInterimTranscript(String(interim).trim());
            }
            if (finalText) {
              onFinalTranscript(String(finalText).trim());
            }
          },
          onerror: (error: any) => {
            if (!desiredRef.current) return;
            const message = error?.message || String(error);
            setStatus('error');
            onFatalError?.(`Gemini 실시간 전사 오류: ${message}`);
          },
          onclose: (event: any) => {
            if (!desiredRef.current) return;
            setStatus('error');
            onFatalError?.(`Gemini 실시간 전사 연결이 종료되었습니다: ${event?.reason || 'connection closed'}`);
          },
        },
      } as any);
      transcribeSessionRef.current = transcribeSession;

      // Translation preview is optional. Failure here must never take down authoritative transcription.
      try {
        const [enToken, koToken] = await Promise.all([
          fetchLiveToken(TRANSLATE_MODEL),
          fetchLiveToken(TRANSLATE_MODEL),
        ]);
        if (desiredRef.current) {
          const [enSession, koSession] = await Promise.all([
            connectTranslationSession(enToken, 'en'),
            connectTranslationSession(koToken, 'ko'),
          ]);
          translateEnSessionRef.current = enSession;
          translateKoSessionRef.current = koSession;
          setTranslatePreviewAvailable(true);
        }
      } catch (error) {
        setTranslatePreviewAvailable(false);
        onWarning?.(
          `Live Translate 미리보기는 사용할 수 없습니다. 최종 번역은 계속 작동합니다: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      if (!desiredRef.current) {
        cleanup();
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
      const inputContext = new AudioContextCtor({ sampleRate: 16000 });
      inputContextRef.current = inputContext;
      await inputContext.resume();

      const source = inputContext.createMediaStreamSource(stream);
      const processor = inputContext.createScriptProcessor(1024, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (event) => {
        if (!desiredRef.current) return;
        const floatData = event.inputBuffer.getChannelData(0);
        const pcm16 = float32ToInt16(floatData);
        const media = {
          data: arrayBufferToBase64(pcm16.buffer),
          mimeType: 'audio/pcm;rate=16000',
        };

        try {
          transcribeSessionRef.current?.sendRealtimeInput?.({ media });
        } catch {
          // onerror/onclose own the fatal path
        }

        for (const session of [translateEnSessionRef.current, translateKoSessionRef.current]) {
          try {
            session?.sendRealtimeInput?.({ media });
          } catch {
            // Translation preview is best effort.
          }
        }
      };

      source.connect(processor);
      processor.connect(inputContext.destination);
      setStatus('live');
    } catch (error) {
      cleanup();
      if (!desiredRef.current) return;
      desiredRef.current = false;
      setStatus('error');
      onFatalError?.(
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }, [
    cleanup,
    connectTranslationSession,
    onFatalError,
    onFinalTranscript,
    onInterimTranscript,
    onWarning,
  ]);

  return {
    status,
    translatePreviewAvailable,
    start,
    stop,
  };
}
