import { useCallback, useRef, useState } from 'react';
import { GoogleGenAI } from '@google/genai';
import { arrayBufferToBase64 } from '../utils/audioUtils';
import { startInterviewAudioCapture, type InterviewAudioCapture } from '../utils/interviewAudioCapture';
import {
  InterviewTranslationSessions,
  type TranslationMedia,
  type TranslationSessionRequest,
} from '../utils/interviewTranslationSessions';
import type { TranslationTarget } from '../utils/interviewTranslationRouter';
import {
  LIVE_SESSION_ROTATE_MS,
  LIVE_TRANSCRIBE_MODEL,
  LIVE_VAD_SILENCE_MS,
  TRANSCRIPT_TURN_STALL_MS,
  createTranscriptTurnBuffer,
  resolveRecognitionLanguage,
  shouldCutGroqChunk,
  shouldFlushStalledTurn,
  startSpeechSilenceProbe,
  type SpeechSilenceProbe,
} from '../utils/liveTranscriptTurn';

export type InterviewLiveStatus = 'idle' | 'connecting' | 'live' | 'error';

export type LiveTranslationUpdate = {
  utteranceId: string;
  target: TranslationTarget;
  text: string;
  isFinal: boolean;
};

type UseInterviewLiveOptions = {
  onInterimTranscript: (text: string) => void;
  /** `utteranceId` identifies the finalized source segment this text belongs to. */
  onFinalTranscript: (text: string, utteranceId: string, languageCode?: string) => void;
  /** Fired when a new utterance opens, so live preview can reset for it. */
  onUtteranceStart: (utteranceId: string) => void;
  onLiveTranslation: (update: LiveTranslationUpdate) => void;
  /** Target languages kept in live rotation. Extensible for multi-language routing. */
  translationTargets?: readonly TranslationTarget[];
  glossaryTerms?: string[];
  /**
   * Authoritative source-language detection for the fallback transcribers
   * (browser SpeechRecognition / Groq Whisper), which report no language code.
   * Reuses the same `/api/detect-language` authority as the text path so voice
   * routing shares one source of truth.
   */
  detectLanguage?: (text: string) => Promise<string | undefined>;
  onWarning?: (message: string) => void;
  onFatalError?: (message: string) => void;
  /**
   * Explicit source-language hint for the fallback transcribers. Browser
   * SpeechRecognition has no language identity, so it must never rely on the
   * browser locale alone (#87).
   */
  sourceLanguageHint?: string;
};

const TRANSCRIBE_MODEL = LIVE_TRANSCRIBE_MODEL;
const TRANSLATE_MODEL = 'gemini-3.5-live-translate-preview';
const DEFAULT_TRANSLATION_TARGETS: readonly TranslationTarget[] = ['en', 'ko'];

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
  onUtteranceStart,
  onLiveTranslation,
  translationTargets = DEFAULT_TRANSLATION_TARGETS,
  glossaryTerms = [],
  detectLanguage,
  onWarning,
  onFatalError,
  sourceLanguageHint,
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
  const captureRef = useRef<InterviewAudioCapture | null>(null);
  const transcribeSessionRef = useRef<any>(null);
  // #87: one Live turn is one row. Chunks merge into an open turn and commit at
  // the turn boundary instead of each chunk creating its own final row.
  const turnBufferRef = useRef(createTranscriptTurnBuffer());
  const transcribeGenerationRef = useRef(0);
  const transcribeRotateTimerRef = useRef<number | null>(null);
  const turnStallTimerRef = useRef<number | null>(null);
  const lastTurnChunkAtRef = useRef(0);
  const groqProbeRef = useRef<SpeechSilenceProbe | null>(null);
  const groqCycleStartedAtRef = useRef(0);
  const observedSourceLanguageRef = useRef<string | undefined>(undefined);
  const translationRef = useRef<InterviewTranslationSessions | null>(null);
  const targetsRef = useRef<readonly TranslationTarget[]>(translationTargets);
  targetsRef.current = translationTargets;

  // Callbacks are read through a ref so the session lifecycle can be created
  // once per start() without being rebuilt when a caller re-renders.
  const handlersRef = useRef({
    onInterimTranscript,
    onFinalTranscript,
    onUtteranceStart,
    onLiveTranslation,
    onWarning,
  });
  handlersRef.current = {
    onInterimTranscript,
    onFinalTranscript,
    onUtteranceStart,
    onLiveTranslation,
    onWarning,
  };

  const detectLanguageRef = useRef(detectLanguage);
  detectLanguageRef.current = detectLanguage;

  const sourceLanguageHintRef = useRef(sourceLanguageHint);
  sourceLanguageHintRef.current = sourceLanguageHint;

  const glossaryTermsRef = useRef(glossaryTerms);
  glossaryTermsRef.current = glossaryTerms;

  /**
   * #87: the Groq fallback cuts a chunk at a real speech pause instead of a
   * fixed clock, so a long sentence is not truncated mid-word. A lightweight RMS
   * probe is the only signal available on a MediaRecorder stream.
   */
  const stopGroqSilenceProbe = useCallback(() => {
    const probe = groqProbeRef.current;
    groqProbeRef.current = null;
    probe?.stop();
  }, []);

  const startGroqSilenceProbe = useCallback((stream: MediaStream) => {
    stopGroqSilenceProbe();
    groqProbeRef.current = startSpeechSilenceProbe(stream);
  }, [stopGroqSilenceProbe]);

  /**
   * Fallback transcribers deliver no language identity, so the finalized
   * transcript goes through the same detector the text path uses. The resolved
   * code feeds `onFinalTranscript`'s languageCode; a failure defers to the
   * caller's heuristic.
   */
  const resolveLanguageCode = useCallback(async (text: string): Promise<string | undefined> => {
    const detector = detectLanguageRef.current;
    if (!detector) return undefined;
    try {
      const code = await detector(text);
      return code || undefined;
    } catch (error) {
      handlersRef.current.onWarning?.(
        `음성 원문 언어 감지에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
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
      window.clearInterval(groqCycleTimerRef.current);
      groqCycleTimerRef.current = null;
    }
    stopGroqSilenceProbe();
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

    if (captureRef.current) {
      try { captureRef.current.stop(); } catch { /* already disconnected */ }
      captureRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (inputContextRef.current) {
      void inputContextRef.current.close().catch(() => {});
      inputContextRef.current = null;
    }

    translationRef.current?.stop();
    translationRef.current = null;

    if (transcribeRotateTimerRef.current) {
      window.clearTimeout(transcribeRotateTimerRef.current);
      transcribeRotateTimerRef.current = null;
    }
    if (turnStallTimerRef.current) {
      window.clearTimeout(turnStallTimerRef.current);
      turnStallTimerRef.current = null;
    }
    // Invalidate the outbound session before closing it so its onclose callback
    // is not mistaken for a real provider failure.
    transcribeGenerationRef.current += 1;
    try {
      transcribeSessionRef.current?.close?.();
    } catch {
      // no-op
    }
    transcribeSessionRef.current = null;
    turnBufferRef.current.reset();

    setTranslatePreviewAvailable(false);
    setBackend('idle');
  }, [stopGroqSilenceProbe]);

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
      startGroqSilenceProbe(stream);
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
          if (transcript) {
            // Same authoritative detection as the browser/browser-free fallbacks.
            const languageCode = await resolveLanguageCode(transcript);
            handlersRef.current.onFinalTranscript(transcript, `groq-${Date.now()}`, languageCode);
          }
        } catch (error) {
          onWarning?.(`Groq Whisper 전사 오류: ${error instanceof Error ? error.message : String(error)}`);
        }

        if (desiredRef.current) {
          window.setTimeout(() => void startGroqFallback(), 100);
        }
      };

      // #87: a fixed 5500ms stop cut speech mid-sentence. Cut at a real pause
      // once a minimum window is captured, with a bounded maximum instead.
      groqCycleStartedAtRef.current = Date.now();
      recorder.start(250);
      groqCycleTimerRef.current = window.setInterval(() => {
        if (groqRecorderRef.current?.state !== 'recording') return;
        const now = Date.now();
        if (
          shouldCutGroqChunk({
            elapsedMs: now - groqCycleStartedAtRef.current,
            silenceMs: groqProbeRef.current?.silenceMs() ?? 0,
          })
        ) {
          groqRecorderRef.current.stop();
        }
      }, 150);
    } catch (error) {
      groqStreamRef.current?.getTracks().forEach((track) => track.stop());
      groqStreamRef.current = null;
      groqActiveRef.current = false;
      setStatus('error');
      const message = error instanceof Error ? error.message : String(error);
      onFatalError?.(`마이크 fallback을 시작하지 못했습니다: ${message}`);
    }
  }, [onFatalError, onWarning, postGroqTranscribe, resolveLanguageCode]);

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
      // #87: an English interview must not be bound to the browser locale.
      // Prefer the explicit hint, then the source language actually observed on
      // this microphone, and only then the browser locale.
      recognition.lang = resolveRecognitionLanguage({
        hint: sourceLanguageHintRef.current,
        observed: observedSourceLanguageRef.current,
        navigatorLanguage: navigator.language,
      });
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
            if (committed) {
              // The browser transcriber has no language identity; resolve it
              // authoritatively before the row's routing is decided.
              const utteranceId = `browser-${Date.now()}`;
              void resolveLanguageCode(committed).then((languageCode) => {
                if (languageCode) observedSourceLanguageRef.current = languageCode;
                handlersRef.current.onFinalTranscript(committed, utteranceId, languageCode);
              });
            }
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
  }, [onInterimTranscript, onWarning, resolveLanguageCode, startGroqFallback]);

  const beginFallback = useCallback((reason: string) => {
    if (!desiredRef.current || fallbackStartedRef.current) return;
    fallbackStartedRef.current = true;
    cleanup();
    onWarning?.(`${reason} 브라우저 전사로 자동 전환합니다.`);
    startBrowserFallback();
  }, [cleanup, onWarning, startBrowserFallback]);

  /**
   * One Live Translate session for one utterance. Each connection takes its own
   * ephemeral token: the token endpoint issues single-use tokens.
   */
  const connectTranslationSession = useCallback(async (request: TranslationSessionRequest) => {
    const token = await fetchLiveToken(TRANSLATE_MODEL);
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });

    const session = await ai.live.connect({
      model: TRANSLATE_MODEL,
      config: {
        responseModalities: ['AUDIO'],
        realtimeInputConfig: {
          automaticActivityDetection: {
            // #87: one shared activity-detection window for both Live paths.
            silenceDurationMs: LIVE_VAD_SILENCE_MS,
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        translationConfig: {
          targetLanguageCode: request.target,
          echoTargetLanguage: false,
        },
      } as any,
      callbacks: {
        onopen: () => {},
        onmessage: (message: any) => {
          const content = message?.serverContent;
          const translatedChunk = content?.outputTranscription?.text;
          // A Live session keeps one conversation history for its whole life, so
          // this session is bound to a single utterance and never reused.
          if (translatedChunk) {
            request.onChunk(
              String(translatedChunk),
              Boolean(content?.turnComplete || content?.generationComplete),
            );
          }
        },
        onerror: (error: any) => request.onError(error?.message || String(error)),
        onclose: () => request.onClose(),
      },
    } as any);

    return {
      sendRealtimeInput: (input: { media?: TranslationMedia; audioStreamEnd?: boolean }) => {
        session.sendRealtimeInput(input as any);
      },
      close: () => {
        try {
          session.close?.();
        } catch {
          // no-op
        }
      },
    };
  }, []);

  /**
   * #87: the Interview microphone owns exactly one Live transcription session.
   * Creating it here (instead of inline in start()) also lets it be rotated
   * before the provider's session limit, so a long interview is not permanently
   * dropped to browser speech recognition.
   */
  const connectTranscribeSession = useCallback(async () => {
    const generation = transcribeGenerationRef.current;
    const isCurrentSession = () =>
      desiredRef.current && generation === transcribeGenerationRef.current;

    /** One final row per turn: the turn boundary and the stall safety net share it. */
    const commitPendingTurn = () => {
      if (turnStallTimerRef.current) {
        window.clearTimeout(turnStallTimerRef.current);
        turnStallTimerRef.current = null;
      }
      const committedTranscript = turnBufferRef.current.finishTurn();
      if (!committedTranscript) return;

      // The authoritative transcript boundary is the translation context
      // boundary: the finished utterance keeps its own session so its
      // translation can never carry an earlier one.
      handlersRef.current.onFinalTranscript(
        committedTranscript,
        translationRef.current?.activeUtteranceId || '',
        observedSourceLanguageRef.current,
      );
      translationRef.current?.rotate();
    };

    const scheduleStallFlush = () => {
      if (turnStallTimerRef.current) window.clearTimeout(turnStallTimerRef.current);
      turnStallTimerRef.current = window.setTimeout(() => {
        turnStallTimerRef.current = null;
        if (!isCurrentSession()) return;
        const sinceLastChunkMs = Date.now() - lastTurnChunkAtRef.current;
        if (
          !shouldFlushStalledTurn({
            hasPending: Boolean(turnBufferRef.current.pending),
            sinceLastChunkMs,
          })
        ) {
          return;
        }
        commitPendingTurn();
      // The timer only checks the predicate below, which owns the threshold, so
      // it is scheduled slightly later than the threshold itself.
      }, TRANSCRIPT_TURN_STALL_MS + 250);
    };

    const token = await fetchLiveToken(TRANSCRIBE_MODEL);
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
    const session = await ai.live.connect({
      model: TRANSCRIBE_MODEL,
      config: {
        responseModalities: ['TEXT'],
        realtimeInputConfig: {
          automaticActivityDetection: {
            // #87: 650ms ended the turn on ordinary 0.7-1.5s thinking pauses.
            silenceDurationMs: LIVE_VAD_SILENCE_MS,
          },
        },
        inputAudioTranscription: {
          languageCodes: [],
          customVocabulary: Array.from(new Set([
            ...CUSTOM_VOCABULARY,
            ...glossaryTermsRef.current,
          ])).slice(0, 100),
          mode: 'VERBATIM',
        },
      } as any,
      callbacks: {
        onopen: () => {},
        onmessage: (message: any) => {
          if (!isCurrentSession()) return;
          const content = message?.serverContent;
          const interim = content?.interimInputTranscription?.text;
          const finalChunk = content?.inputTranscription;
          // Authoritative source-language identity when the transcriber emits it.
          const finalLanguageCode = finalChunk?.languageCode;

          if (finalLanguageCode) observedSourceLanguageRef.current = String(finalLanguageCode);
          if (interim) handlersRef.current.onInterimTranscript(String(interim).trim());
          if (finalChunk?.text) {
            turnBufferRef.current.merge(String(finalChunk.text));
            lastTurnChunkAtRef.current = Date.now();
          }

          // #87: one Live turn is one row. Committing every `inputTranscription`
          // chunk (the previous behaviour) split a single sentence into several
          // partial rows and rotated the Live Translate session mid-sentence.
          const turnFinished = Boolean(
            finalChunk?.finished || content?.turnComplete || content?.generationComplete,
          );
          if (turnFinished) {
            commitPendingTurn();
            return;
          }
          // The boundary has not arrived yet: keep the turn open, but never hold
          // a stalled turn forever (see TRANSCRIPT_TURN_STALL_MS).
          if (turnBufferRef.current.pending) scheduleStallFlush();
        },
        onerror: (error: any) => {
          if (!isCurrentSession()) return;
          const message = error?.message || String(error);
          beginFallback(`Gemini 실시간 전사 오류: ${message}`);
        },
        onclose: (event: any) => {
          if (!isCurrentSession()) return;
          beginFallback(`Gemini 실시간 전사 연결이 종료되었습니다: ${event?.reason || 'connection closed'}`);
        },
      },
    } as any);

    return session;
  }, [beginFallback]);

  const rotateTranscribeSessionRef = useRef<() => void>(() => {});

  const scheduleTranscribeRotation = useCallback(() => {
    if (transcribeRotateTimerRef.current) {
      window.clearTimeout(transcribeRotateTimerRef.current);
    }
    transcribeRotateTimerRef.current = window.setTimeout(() => {
      rotateTranscribeSessionRef.current();
    }, LIVE_SESSION_ROTATE_MS);
  }, []);

  const rotateTranscribeSession = useCallback(async () => {
    if (!desiredRef.current || fallbackStartedRef.current) return;
    const previous = transcribeSessionRef.current;

    // A rotation boundary can land mid-sentence; keep the transcript already
    // captured instead of dropping it together with the outgoing session.
    const pendingBeforeRotation = turnBufferRef.current.finishTurn();
    if (pendingBeforeRotation) {
      handlersRef.current.onFinalTranscript(
        pendingBeforeRotation,
        translationRef.current?.activeUtteranceId || '',
        observedSourceLanguageRef.current,
      );
      translationRef.current?.rotate();
    }

    // Invalidate the outgoing session before it closes so its onclose cannot be
    // mistaken for a real provider failure (#87).
    transcribeGenerationRef.current += 1;
    try {
      const next = await connectTranscribeSession();
      if (!desiredRef.current || fallbackStartedRef.current) {
        try {
          next?.close?.();
        } catch {
          // no-op
        }
        return;
      }
      transcribeSessionRef.current = next;
      scheduleTranscribeRotation();
      try {
        previous?.close?.();
      } catch {
        // no-op
      }
    } catch (error) {
      beginFallback(
        `Gemini 실시간 전사 세션 갱신 실패: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, [beginFallback, connectTranscribeSession, scheduleTranscribeRotation]);

  rotateTranscribeSessionRef.current = () => {
    void rotateTranscribeSession();
  };

  const start = useCallback(async () => {
    if (desiredRef.current) return;
    desiredRef.current = true;
    fallbackStartedRef.current = false;
    setBackend('idle');
    setStatus('connecting');
    cleanup();

    try {
      transcribeSessionRef.current = await connectTranscribeSession();
      if (!desiredRef.current) {
        cleanup();
        return;
      }
      scheduleTranscribeRotation();

      // Translation preview is optional. Failure here must never take down authoritative transcription.
      try {
        const translation = new InterviewTranslationSessions({
          targets: targetsRef.current,
          connect: connectTranslationSession,
          onUtteranceStart: (utteranceId) => handlersRef.current.onUtteranceStart(utteranceId),
          onPreview: (utteranceId, target, text) =>
            handlersRef.current.onLiveTranslation({ utteranceId, target, text, isFinal: false }),
          onFinal: (utteranceId, target, text) =>
            handlersRef.current.onLiveTranslation({ utteranceId, target, text, isFinal: true }),
          onWarning: (message) => handlersRef.current.onWarning?.(message),
        });
        translationRef.current = translation;

        const available = await translation.start();
        if (!available) {
          onWarning?.(
            'Live Translate 미리보기는 사용할 수 없습니다. 최종 번역은 계속 작동합니다.'
          );
        }
        if (!desiredRef.current) {
          cleanup();
          return;
        }
        setTranslatePreviewAvailable(available);
      } catch (error) {
        translationRef.current = null;
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
      if (!desiredRef.current || fallbackStartedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
      const inputContext = new AudioContextCtor({ sampleRate: 16000 });
      inputContextRef.current = inputContext;
      await inputContext.resume();

      // #87: the browser audio thread owns the PCM conversion. React updates,
      // scrolling and synchronous session persistence no longer run inside a
      // ScriptProcessor audio callback. Legacy capture is a browser fallback.
      const capture = await startInterviewAudioCapture(inputContext, stream, (pcm16) => {
        if (!desiredRef.current) return;
        const media: TranslationMedia = {
          data: arrayBufferToBase64(pcm16),
          mimeType: 'audio/pcm;rate=16000',
        };
        try {
          transcribeSessionRef.current?.sendRealtimeInput?.({ media });
        } catch {
          // onerror/onclose own the fatal path.
        }
        translationRef.current?.feedAudio(media);
      });
      if (!desiredRef.current || fallbackStartedRef.current) {
        capture.stop();
        cleanup();
        return;
      }
      captureRef.current = capture;
      if (capture.mode === 'legacy') {
        onWarning?.('이 브라우저는 AudioWorklet을 지원하지 않아 기본 오디오 입력 방식을 사용합니다.');
      }
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
    connectTranscribeSession,
    connectTranslationSession,
    onWarning,
    scheduleTranscribeRotation,
  ]);

  return {
    status,
    backend,
    translatePreviewAvailable,
    start,
    stop,
  };
}
