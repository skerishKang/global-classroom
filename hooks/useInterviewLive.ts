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

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('오디오를 읽지 못했습니다.'));
    reader.readAsDataURL(blob);
  });
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
  const [backend, setBackend] = useState<'idle' | 'gemini' | 'browser' | 'groq'>('idle');
  const desiredRef = useRef(false);
  const fallbackStartedRef = useRef(false);
  const browserRecognitionRef = useRef<any>(null);
  const browserRestartTimerRef = useRef<number | null>(null);
  const groqRecorderRef = useRef<MediaRecorder | null>(null);
  const groqActiveRef = useRef(false);
  const groqStreamRef = useRef<MediaStream | null>(null);
  const groqChunksRef = useRef<Blob[]>([]);
  const groqCycleTimerRef = useRef<number | null>(null);
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
    if (browserRestartTimerRef.current) {
      window.clearTimeout(browserRestartTimerRef.current);
      browserRestartTimerRef.current = null;
    }
    try {
      browserRecognitionRef.current?.stop?.();
    } catch {
      // no-op
    }
    browserRecognitionRef.current = null;

    if (groqCycleTimerRef.current) {
      window.clearTimeout(groqCycleTimerRef.current);
      groqCycleTimerRef.current = null;
    }
    try {
      if (groqRecorderRef.current?.state === 'recording') {
        groqRecorderRef.current.stop();
      }
    } catch {
      // no-op
    }
    groqRecorderRef.current = null;
    groqActiveRef.current = false;
    groqStreamRef.current?.getTracks().forEach((track) => track.stop());
    groqStreamRef.current = null;
    groqChunksRef.current = [];

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
    setBackend('idle');
  }, [closeSession]);

  const stop = useCallback(() => {
    desiredRef.current = false;
    fallbackStartedRef.current = false;
    cleanup();
    setStatus('idle');
  }, [cleanup]);

  const postGroqTranscribe = useCallback(async (blob: Blob) => {
    const audioDataUrl = await blobToDataUrl(blob);
    const response = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioDataUrl, language: 'auto' }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data?.text !== 'string') {
      throw new Error(data?.detail || data?.error || 'Groq 음성 전사에 실패했습니다.');
    }
    return data.text.trim();
  }, []);

  const startGroqFallback = useCallback(async () => {
    if (!desiredRef.current || groqRecorderRef.current || groqActiveRef.current) return;
    groqActiveRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (!desiredRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        groqActiveRef.current = false;
        return;
      }

      groqStreamRef.current = stream;
      groqChunksRef.current = [];
      const mimeType = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
      ].find((type) => MediaRecorder.isTypeSupported?.(type));

      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : { audioBitsPerSecond: 32_000 }
      );
      groqRecorderRef.current = recorder;
      setBackend('groq');
      setStatus('live');
      onWarning?.('Gemini/브라우저 실시간 전사를 사용할 수 없어 Groq Whisper 자동 fallback을 사용합니다.');

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) groqChunksRef.current.push(event.data);
      };

      recorder.onstop = async () => {
        if (groqCycleTimerRef.current) {
          window.clearTimeout(groqCycleTimerRef.current);
          groqCycleTimerRef.current = null;
        }

        const blob = new Blob(groqChunksRef.current, {
          type: recorder.mimeType || mimeType || 'audio/webm',
        });
        groqChunksRef.current = [];
        groqRecorderRef.current = null;
        groqActiveRef.current = false;
        groqStreamRef.current?.getTracks().forEach((track) => track.stop());
        groqStreamRef.current = null;

        if (!desiredRef.current || !blob.size) return;

        try {
          const transcript = await postGroqTranscribe(blob);
          if (transcript) onFinalTranscript(transcript);
        } catch (error) {
          onWarning?.(`Groq Whisper 전사 오류: ${error instanceof Error ? error.message : String(error)}`);
        }

        if (desiredRef.current) {
          window.setTimeout(() => void startGroqFallback(), 100);
        }
      };

      recorder.start(250);
      groqCycleTimerRef.current = window.setTimeout(() => {
        if (groqRecorderRef.current?.state === 'recording') {
          groqRecorderRef.current.stop();
        }
      }, 5500);
    } catch (error) {
      groqStreamRef.current?.getTracks().forEach((track) => track.stop());
      groqStreamRef.current = null;
      groqActiveRef.current = false;
      setStatus('error');
      const message = error instanceof Error ? error.message : String(error);
      onFatalError?.(`마이크 fallback을 시작하지 못했습니다: ${message}`);
    }
  }, [onFatalError, onFinalTranscript, onWarning, postGroqTranscribe]);

  const startBrowserFallback = useCallback(() => {
    if (!desiredRef.current) return;

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      void startGroqFallback();
      return;
    }

    const runRecognition = () => {
      if (!desiredRef.current || groqActiveRef.current) return;

      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || 'ko-KR';
      let finalized = '';

      recognition.onstart = () => {
        setBackend('browser');
        setStatus('live');
        onWarning?.('Gemini Live를 사용할 수 없어 브라우저 실시간 전사를 사용합니다.');
      };

      recognition.onresult = (event: any) => {
        let interim = '';
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const text = event.results[index][0]?.transcript || '';
          if (event.results[index].isFinal) {
            finalized += text;
            const committed = finalized.trim();
            finalized = '';
            if (committed) onFinalTranscript(committed);
          } else {
            interim += text;
          }
        }
        onInterimTranscript((finalized + interim).trim());
      };

      recognition.onerror = (event: any) => {
        const code = event?.error || 'unknown';
        browserRecognitionRef.current = null;
        if (!desiredRef.current) return;

        if (['network', 'service-not-allowed', 'language-not-supported'].includes(code)) {
          onWarning?.(`브라우저 전사 오류(${code}). Groq Whisper로 전환합니다.`);
          void startGroqFallback();
        } else {
          onWarning?.(`브라우저 음성 인식 오류: ${code}`);
        }
      };

      recognition.onend = () => {
        browserRecognitionRef.current = null;
        if (!desiredRef.current || groqActiveRef.current) return;
        browserRestartTimerRef.current = window.setTimeout(runRecognition, 150);
      };

      browserRecognitionRef.current = recognition;
      try {
        recognition.start();
      } catch {
        browserRecognitionRef.current = null;
        void startGroqFallback();
      }
    };

    runRecognition();
  }, [onFinalTranscript, onInterimTranscript, onWarning, startGroqFallback]);

  const beginFallback = useCallback((reason: string) => {
    if (!desiredRef.current || fallbackStartedRef.current) return;
    fallbackStartedRef.current = true;
    cleanup();
    onWarning?.(`${reason} 브라우저 전사로 자동 전환합니다.`);
    startBrowserFallback();
  }, [cleanup, onWarning, startBrowserFallback]);

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
    fallbackStartedRef.current = false;
    setBackend('idle');
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
            beginFallback(`Gemini 실시간 전사 오류: ${message}`);
          },
          onclose: (event: any) => {
            if (!desiredRef.current) return;
            beginFallback(`Gemini 실시간 전사 연결이 종료되었습니다: ${event?.reason || 'connection closed'}`);
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
      setBackend('gemini');
      setStatus('live');
    } catch (error) {
      if (!desiredRef.current) return;
      beginFallback(
        error instanceof Error
          ? `Gemini Live 시작 실패: ${error.message}`
          : `Gemini Live 시작 실패: ${String(error)}`
      );
    }
  }, [
    beginFallback,
    cleanup,
    connectTranslationSession,
    onFinalTranscript,
    onInterimTranscript,
    onWarning,
  ]);

  return {
    status,
    backend,
    translatePreviewAvailable,
    start,
    stop,
  };
}
