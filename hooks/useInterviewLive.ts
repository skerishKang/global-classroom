import { useCallback, useRef, useState } from 'react';
import { GoogleGenAI } from '@google/genai';
import { arrayBufferToBase64, float32ToInt16 } from '../utils/audioUtils';
import { InterviewTranslationLifecycle } from '../utils/interviewTranslationLifecycle';

export type InterviewLiveStatus = 'idle' | 'connecting' | 'live' | 'error';

type LiveTranslationTarget = 'en' | 'ko';

type UseInterviewLiveOptions = {
  onInterimTranscript: (text: string) => void;
  onFinalTranscript: (text: string, translationGeneration?: number) => void;
  onLiveTranslation: (target: LiveTranslationTarget, text: string, isFinal: boolean, generation: number) => void;
  glossaryTerms?: string[];
  onWarning?: (message: string) => void;
  onFatalError?: (message: string) => void;
};

const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live';
const TRANSLATE_MODEL = 'gemini-3.5-live-translate-preview';
const TRANSLATION_TARGETS: readonly LiveTranslationTarget[] = ['en', 'ko'];

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
  if (!incoming || !incoming.trim()) return previous;
  if (!previous) return incoming.trimStart();

  const previousTrimmed = previous.trimEnd();
  const incomingTrimmed = incoming.trimStart();

  // Some Live transcription events are cumulative revisions.
  if (incomingTrimmed.startsWith(previousTrimmed)) return incomingTrimmed;
  if (previousTrimmed.endsWith(incomingTrimmed)) return previous;

  // Preserve whitespace supplied by the stream. Only synthesize a boundary
  // when the server omitted one between two obvious word-like chunks.
  if (/\s$/.test(previous) || /^\s/.test(incoming)) return previous + incoming;
  const needsBoundary =
    /[A-Za-z0-9가-힣]$/.test(previous) &&
    /^[A-Za-z0-9가-힣]/.test(incoming);
  return `${previous}${needsBoundary ? ' ' : ''}${incoming}`;
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
  glossaryTerms = [],
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
  const translationLifecycleRef = useRef(
    new InterviewTranslationLifecycle<LiveTranslationTarget>(TRANSLATION_TARGETS)
  );
  const retiringTranslationTimersRef = useRef<number[]>([]);
  const retiringTranslationSessionsRef = useRef<Set<any>>(new Set());

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
    transcribeSessionRef.current = null;
    translationLifecycleRef.current.closeAll();
    translationLifecycleRef.current = new InterviewTranslationLifecycle<LiveTranslationTarget>(TRANSLATION_TARGETS);
    for (const session of retiringTranslationSessionsRef.current) {
      closeSession(session);
    }
    retiringTranslationSessionsRef.current.clear();
    for (const timer of retiringTranslationTimersRef.current) {
      window.clearTimeout(timer);
    }
    retiringTranslationTimersRef.current = [];
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
    generation: number,
  ) => {
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
    let preview = '';
    let session: any = null;

    session = await ai.live.connect({
      model: TRANSLATE_MODEL,
      config: {
        responseModalities: ['AUDIO'],
        realtimeInputConfig: {
          automaticActivityDetection: {
            silenceDurationMs: 650,
          },
        },
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
            preview = mergeStreamText(preview, translatedChunk);
            // A retired generation may still drain its final response, but it
            // must never replace the live preview for the next utterance.
            if (translationLifecycleRef.current.isActive(targetLanguageCode, generation)) {
              onLiveTranslation(targetLanguageCode, preview, false, generation);
            }
          }

          if (content?.turnComplete || content?.generationComplete) {
            if (preview.trim()) {
              // Final output is generation-tagged so App can map delayed
              // completions to the exact source row that created them.
              onLiveTranslation(targetLanguageCode, preview, true, generation);
            }
            preview = '';

            if (!translationLifecycleRef.current.isActive(targetLanguageCode, generation)) {
              closeSession(session);
            }
          }
        },
        onerror: (error: any) => {
          if (translationLifecycleRef.current.isActive(targetLanguageCode, generation)) {
            onWarning?.(
              `실시간 ${targetLanguageCode === 'en' ? '영어' : '한국어'} 번역 미리보기 연결 오류: ${error?.message || error}`
            );
          }
        },
        onclose: () => {},
      },
    } as any);

    return session;
  }, [closeSession, onLiveTranslation, onWarning]);

  const provisionTranslationGeneration = useCallback(async (
    generation: number,
    mode: 'active' | 'standby',
  ) => {
    const lifecycle = translationLifecycleRef.current;
    const targets = TRANSLATION_TARGETS.filter((target) =>
      mode === 'active'
        ? !lifecycle.hasActive(target, generation)
        : !lifecycle.hasStandby(target, generation)
    );

    if (!targets.length) return true;

    const created = await Promise.allSettled(targets.map(async (target) => {
      const token = await fetchLiveToken(TRANSLATE_MODEL);
      const session = await connectTranslationSession(token, target, generation);
      return { target, session };
    }));

    let allInstalled = true;
    for (const result of created) {
      if (result.status === 'rejected') {
        allInstalled = false;
        continue;
      }

      const { target, session } = result.value;
      if (!desiredRef.current || translationLifecycleRef.current !== lifecycle) {
        closeSession(session);
        allInstalled = false;
        continue;
      }

      const installed = mode === 'active'
        ? lifecycle.installActive(target, generation, session)
        : lifecycle.installStandby(target, generation, session);
      if (!installed) {
        closeSession(session);
        allInstalled = false;
      }
    }

    return allInstalled && TRANSLATION_TARGETS.every((target) =>
      mode === 'active'
        ? lifecycle.hasActive(target, generation)
        : lifecycle.hasStandby(target, generation)
    );
  }, [closeSession, connectTranslationSession]);

  const rotateTranslationGeneration = useCallback((completedGeneration: number) => {
    const lifecycle = translationLifecycleRef.current;
    if (lifecycle.currentGeneration() !== completedGeneration) return;

    // Swap to already-connected standby sessions before draining the old
    // generation. New microphone frames therefore cannot enter the previous
    // utterance's translation context.
    const rotation = lifecycle.rotate();

    for (const slot of rotation.retiring) {
      retiringTranslationSessionsRef.current.add(slot.session);
      try {
        slot.session.sendRealtimeInput?.({ audioStreamEnd: true });
      } catch {
        closeSession(slot.session);
        retiringTranslationSessionsRef.current.delete(slot.session);
        continue;
      }

      const timer = window.setTimeout(() => {
        closeSession(slot.session);
        retiringTranslationSessionsRef.current.delete(slot.session);
      }, 2500);
      retiringTranslationTimersRef.current.push(timer);
    }

    const prepareNext = async () => {
      let activeReady = rotation.missingTargets.length === 0;
      if (!activeReady) {
        setTranslatePreviewAvailable(false);
        activeReady = await provisionTranslationGeneration(rotation.activeGeneration, 'active');
      }

      if (
        !desiredRef.current ||
        translationLifecycleRef.current !== lifecycle ||
        lifecycle.currentGeneration() !== rotation.activeGeneration
      ) {
        return;
      }

      setTranslatePreviewAvailable(activeReady);
      if (activeReady) {
        // Keep one fresh, audio-free generation connected so the next
        // authoritative transcript boundary can swap synchronously.
        void provisionTranslationGeneration(rotation.activeGeneration + 1, 'standby');
      }
    };

    void prepareNext();
  }, [closeSession, provisionTranslationGeneration]);

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

      const transcribeAi = new GoogleGenAI({ apiKey: transcribeToken, httpOptions: { apiVersion: 'v1alpha' } });
      const transcribeSession = await transcribeAi.live.connect({
        model: TRANSCRIBE_MODEL,
        config: {
          responseModalities: ['TEXT'],
          realtimeInputConfig: {
            automaticActivityDetection: {
              silenceDurationMs: 650,
            },
          },
          inputAudioTranscription: {
            languageCodes: [],
            customVocabulary: Array.from(new Set([
              ...CUSTOM_VOCABULARY,
              ...glossaryTerms,
            ])).slice(0, 100),
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
              const committedTranscript = String(finalText).trim();
              if (committedTranscript) {
                const completedGeneration = translationLifecycleRef.current.currentGeneration();
                // The transcript is authoritative for the source-row boundary. Commit the
                // row with the generation that received this utterance, then synchronously
                // rotate microphone routing to a fresh translation context.
                onFinalTranscript(committedTranscript, completedGeneration);
                rotateTranslationGeneration(completedGeneration);
              }
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

      // Translation preview is optional. Each active generation receives audio for
      // exactly one authoritative transcript segment. A standby generation is kept
      // connected but audio-free so the next boundary can switch immediately.
      try {
        const generation = translationLifecycleRef.current.currentGeneration();
        const activeReady = await provisionTranslationGeneration(generation, 'active');
        setTranslatePreviewAvailable(activeReady);
        if (activeReady && desiredRef.current) {
          void provisionTranslationGeneration(generation + 1, 'standby');
        }
      } catch (error) {
        setTranslatePreviewAvailable(false);
        onWarning?.(
          `Live Translate 미리보기는 사용할 수 없습니다. 전사는 계속 작동합니다: ${error instanceof Error ? error.message : String(error)}`
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

        translationLifecycleRef.current.sendMedia(media);
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
    glossaryTerms,
    onFinalTranscript,
    onInterimTranscript,
    onWarning,
    provisionTranslationGeneration,
    rotateTranslationGeneration,
  ]);

  return {
    status,
    backend,
    translatePreviewAvailable,
    start,
    stop,
  };
}
