import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useInterviewLive } from '../hooks/useInterviewLive';

type Direction = 'ko-en' | 'en-ko';

type HistoryItem = {
  id: string;
  direction: Direction;
  source: string;
  translated: string;
  isTranslating: boolean;
  timestamp: number;
};

type InterviewModeProps = {
  onExit: () => void;
};

const INTRO_KO =
  '저는 영어로 기본적인 소통은 가능하지만, 복잡한 기술적인 내용을 영어로 말하면 제 생각의 절반도 정확하게 전달하기 어렵습니다. 그래서 양해해 주신다면 저는 한국어로 답하고, 제가 직접 만든 AI 통역 프로그램으로 실시간 영어 번역을 보여드리겠습니다. 이렇게 하면 제 의견을 정확히 전달할 수 있고, 동시에 제가 어떤 AI 제품을 만드는 사람인지 실제로 보여드릴 수 있습니다.';

const INTRO_EN =
  'I can communicate in English, but for complex technical topics I cannot express the full depth of my thinking as accurately as I can in Korean. So, with your permission, I will answer in Korean and use this AI interpreter that I built to translate my answers into English in real time. This lets me communicate precisely while also giving you a live demonstration of the kind of AI product I build.';

function hasKorean(text: string) {
  return /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text);
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function speak(text: string, language: 'ko-KR' | 'en-US') {
  if (!text.trim() || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = language;
  utterance.rate = 0.96;
  const prefix = language.startsWith('ko') ? 'ko' : 'en';
  const voice = window.speechSynthesis
    .getVoices()
    .find((candidate) => candidate.lang.toLowerCase().startsWith(prefix));
  if (voice) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
}

export default function InterviewMode({ onExit }: InterviewModeProps) {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [livePreviewEn, setLivePreviewEn] = useState('');
  const [livePreviewKo, setLivePreviewKo] = useState('');
  const [latestPreviewTarget, setLatestPreviewTarget] = useState<'en' | 'ko' | null>(null);
  const [micWanted, setMicWanted] = useState(false);
  const [fallbackMode, setFallbackMode] = useState<'none' | 'browser' | 'groq'>('none');
  const [warning, setWarning] = useState('');
  const [error, setError] = useState('');
  const [manualText, setManualText] = useState('');
  const [showIntro, setShowIntro] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const micWantedRef = useRef(false);
  const recognitionRef = useRef<any>(null);
  const browserRestartTimerRef = useRef<number | null>(null);
  const fallbackStarterRef = useRef<(() => void) | null>(null);
  const groqRecorderRef = useRef<MediaRecorder | null>(null);
  const groqStreamRef = useRef<MediaStream | null>(null);
  const groqChunksRef = useRef<Blob[]>([]);

  const postTranslate = useCallback(async (text: string) => {
    const direction: Direction = hasKorean(text) ? 'ko-en' : 'en-ko';
    const response = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        from: direction === 'ko-en'
          ? 'Korean with possible English technical terms'
          : 'English with possible Korean terms',
        to: direction === 'ko-en' ? 'English' : 'Korean',
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data?.translated !== 'string') {
      throw new Error(data?.detail || data?.error || '번역에 실패했습니다.');
    }

    return {
      direction,
      translated: data.translated.trim(),
      model: data?.model,
      provider: data?.provider,
    };
  }, []);

  const translateAndCommit = useCallback(async (source: string) => {
    const text = source.trim();
    if (!text) return;

    const id = crypto.randomUUID();
    const direction: Direction = hasKorean(text) ? 'ko-en' : 'en-ko';

    setHistory((prev) => [
      ...prev,
      {
        id,
        direction,
        source: text,
        translated: '',
        isTranslating: true,
        timestamp: Date.now(),
      },
    ]);

    try {
      const result = await postTranslate(text);
      setHistory((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                direction: result.direction,
                translated: result.translated,
                isTranslating: false,
              }
            : item
        )
      );

      if (autoSpeak && result.translated) {
        speak(result.translated, result.direction === 'ko-en' ? 'en-US' : 'ko-KR');
      }
    } catch (translateError) {
      const message =
        translateError instanceof Error ? translateError.message : String(translateError);
      setError(message);
      setHistory((prev) =>
        prev.map((item) =>
          item.id === id
            ? { ...item, translated: '번역 오류', isTranslating: false }
            : item
        )
      );
    }
  }, [autoSpeak, postTranslate]);

  const onFinalTranscript = useCallback((text: string) => {
    setCurrentTranscript('');
    setError('');
    void translateAndCommit(text);
  }, [translateAndCommit]);

  const live = useInterviewLive({
    onInterimTranscript: (text) => {
      setCurrentTranscript(text);
    },
    onFinalTranscript,
    onLiveTranslation: (target, text) => {
      setLatestPreviewTarget(target);
      if (target === 'en') setLivePreviewEn(text);
      else setLivePreviewKo(text);
    },
    onWarning: (message) => setWarning(message),
    onFatalError: (message) => {
      setWarning(`${message} 브라우저 전사로 자동 전환합니다.`);
      if (micWantedRef.current) {
        window.setTimeout(() => fallbackStarterRef.current?.(), 0);
      }
    },
  });

  const stopBrowserFallback = useCallback(() => {
    if (browserRestartTimerRef.current) {
      window.clearTimeout(browserRestartTimerRef.current);
      browserRestartTimerRef.current = null;
    }
    try {
      recognitionRef.current?.stop?.();
    } catch {
      // no-op
    }
    recognitionRef.current = null;
  }, []);

  const postGroqTranscribe = useCallback(async (blob: Blob) => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('오디오를 읽지 못했습니다.'));
      reader.readAsDataURL(blob);
    });

    const response = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioDataUrl: dataUrl, language: 'auto' }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data?.text !== 'string') {
      throw new Error(data?.detail || data?.error || 'Groq 음성 전사에 실패했습니다.');
    }
    return data.text.trim();
  }, []);

  const startGroqFallback = useCallback(async () => {
    if (!micWantedRef.current || groqRecorderRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('이 브라우저에서는 마이크 녹음을 사용할 수 없습니다.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      groqStreamRef.current = stream;
      groqChunksRef.current = [];

      const preferred = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
      ].find((type) => MediaRecorder.isTypeSupported?.(type));

      const recorder = new MediaRecorder(
        stream,
        preferred ? { mimeType: preferred, audioBitsPerSecond: 32_000 } : undefined
      );
      groqRecorderRef.current = recorder;
      setFallbackMode('groq');
      setWarning('Gemini/브라우저 실시간 전사를 사용할 수 없어 Groq Whisper 녹음 fallback을 사용합니다.');

      recorder.ondataavailable = (event) => {
        if (event.data.size) groqChunksRef.current.push(event.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(groqChunksRef.current, {
          type: recorder.mimeType || preferred || 'audio/webm',
        });
        groqChunksRef.current = [];
        groqRecorderRef.current = null;
        groqStreamRef.current?.getTracks().forEach((track) => track.stop());
        groqStreamRef.current = null;

        if (!blob.size) return;

        try {
          const transcript = await postGroqTranscribe(blob);
          if (transcript) onFinalTranscript(transcript);
        } catch (groqError) {
          setError(groqError instanceof Error ? groqError.message : String(groqError));
        }

        if (micWantedRef.current) {
          window.setTimeout(() => void startGroqFallback(), 100);
        }
      };

      recorder.start(250);
    } catch (groqError) {
      setError(groqError instanceof Error ? groqError.message : String(groqError));
    }
  }, [onFinalTranscript, postGroqTranscribe]);

  const startBrowserFallback = useCallback(() => {
    if (!micWantedRef.current || recognitionRef.current) return;

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      void startGroqFallback();
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'ko-KR';

    let finalized = '';

    recognition.onstart = () => {
      setFallbackMode('browser');
      setWarning('Gemini Live 연결 대신 브라우저 실시간 전사를 사용 중입니다.');
    };

    recognition.onresult = (event: any) => {
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = event.results[index][0]?.transcript || '';
        if (event.results[index].isFinal) {
          finalized += transcript;
          const committed = finalized.trim();
          finalized = '';
          if (committed) onFinalTranscript(committed);
        } else {
          interim += transcript;
        }
      }
      setCurrentTranscript((finalized + interim).trim());
    };

    recognition.onerror = (event: any) => {
      const code = event?.error || 'unknown';
      recognitionRef.current = null;
      if (!micWantedRef.current) return;

      if (['network', 'service-not-allowed', 'language-not-supported'].includes(code)) {
        setWarning(`브라우저 전사 오류(${code}). Groq Whisper로 전환합니다.`);
        void startGroqFallback();
      } else {
        setError(`브라우저 음성 인식 오류: ${code}`);
      }
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      if (!micWantedRef.current || fallbackMode === 'groq') return;
      browserRestartTimerRef.current = window.setTimeout(startBrowserFallback, 150);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      void startGroqFallback();
    }
  }, [fallbackMode, onFinalTranscript, startGroqFallback]);

  fallbackStarterRef.current = startBrowserFallback;

  const stopGroqFallback = useCallback(() => {
    if (groqRecorderRef.current?.state === 'recording') {
      groqRecorderRef.current.stop();
    }
    groqStreamRef.current?.getTracks().forEach((track) => track.stop());
    groqStreamRef.current = null;
  }, []);

  const startMic = useCallback(async () => {
    setError('');
    setWarning('');
    setCurrentTranscript('');
    setLivePreviewEn('');
    setLivePreviewKo('');
    setLatestPreviewTarget(null);
    setMicWanted(true);
    micWantedRef.current = true;
    setFallbackMode('none');

    try {
      await live.start();
    } catch {
      startBrowserFallback();
    }
  }, [live, startBrowserFallback]);

  const stopMic = useCallback(() => {
    setMicWanted(false);
    micWantedRef.current = false;
    live.stop();
    stopBrowserFallback();
    stopGroqFallback();
    setFallbackMode('none');
    setCurrentTranscript('');
  }, [live, stopBrowserFallback, stopGroqFallback]);

  useEffect(() => {
    return () => {
      micWantedRef.current = false;
      live.stop();
      stopBrowserFallback();
      stopGroqFallback();
    };
  }, [live, stopBrowserFallback, stopGroqFallback]);

  useEffect(() => {
    if (!historyRef.current) return;
    historyRef.current.scrollTop = historyRef.current.scrollHeight;
  }, [history, currentTranscript, livePreviewEn, livePreviewKo]);

  const submitManualText = useCallback(() => {
    const text = manualText.trim();
    if (!text) return;
    setManualText('');
    void translateAndCommit(text);
  }, [manualText, translateAndCommit]);

  const livePreview =
    latestPreviewTarget === 'en'
      ? livePreviewEn
      : latestPreviewTarget === 'ko'
        ? livePreviewKo
        : '';

  const statusLabel =
    live.status === 'connecting'
      ? 'Gemini Live 연결 중'
      : live.status === 'live'
        ? 'Gemini 3.5 Transcribe Live'
        : fallbackMode === 'browser'
          ? 'Browser STT fallback'
          : fallbackMode === 'groq'
            ? 'Groq Whisper fallback'
            : '대기 중';

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-gray-50 text-gray-900">
      <header className="shrink-0 border-b border-gray-200 bg-white shadow-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 md:px-6">
          <div>
            <div className="text-xs font-bold text-indigo-600">Global Classroom · Interview</div>
            <h1 className="text-xl font-extrabold tracking-tight md:text-2xl">AI 면접 실시간 통역</h1>
          </div>
          <button
            type="button"
            onClick={onExit}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-50"
          >
            기존 화면
          </button>
        </div>

        <div className="mx-auto max-w-6xl px-4 pb-3 md:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="rounded-full bg-indigo-100 px-3 py-1 font-bold text-indigo-700">✨ 자동 언어 감지</span>
              <span className="font-bold text-gray-500">한국어 ↔ English</span>
              <span className="text-gray-300">|</span>
              <span className={micWanted ? 'font-bold text-emerald-600' : 'font-medium text-gray-500'}>
                {micWanted ? '● 듣는 중' : '○ 마이크 꺼짐'}
              </span>
            </div>
            <div className="text-xs font-semibold text-gray-500">{statusLabel}</div>
          </div>
        </div>
      </header>

      <main ref={historyRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 px-4 py-5 md:px-6">
          <section className="rounded-2xl border border-indigo-100 bg-indigo-50/70 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs font-black uppercase tracking-wide text-indigo-500">Interview opening</div>
                <div className="mt-1 text-sm font-semibold text-gray-700">
                  영어가 부족한 부분은 숨기지 않고, 직접 만든 AI 통역기로 정확하게 전달합니다.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowIntro((value) => !value)}
                className="rounded-xl bg-white px-3 py-2 text-xs font-bold text-indigo-700 shadow-sm ring-1 ring-indigo-100"
              >
                {showIntro ? '안내문 닫기' : '시작 안내문'}
              </button>
            </div>
            {showIntro && (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="rounded-xl bg-white p-3 text-sm leading-6 text-gray-700">{INTRO_KO}</div>
                <div className="rounded-xl bg-white p-3 text-sm leading-6 text-indigo-900">{INTRO_EN}</div>
              </div>
            )}
          </section>

          {(warning || error) && (
            <section className={`rounded-xl border px-4 py-3 text-sm ${
              error
                ? 'border-red-200 bg-red-50 text-red-700'
                : 'border-amber-200 bg-amber-50 text-amber-800'
            }`}>
              {error || warning}
            </section>
          )}

          {history.length === 0 && !currentTranscript && !livePreview && (
            <section className="py-12 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-indigo-100 text-2xl">🎙️</div>
              <h2 className="mt-4 text-lg font-extrabold text-gray-800">마이크를 켜고 자연스럽게 말씀하세요.</h2>
              <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-gray-500">
                원문은 말하는 즉시 실시간 자막으로 보이고, 발화가 확정되면 Groq 번역이 기록됩니다.
                Live Translate가 연결되면 말하는 중 번역 미리보기도 함께 표시됩니다.
              </p>
            </section>
          )}

          {history.map((item) => (
            <article key={item.id} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-black text-gray-400">
                  {item.direction === 'ko-en' ? 'Korean → English' : 'English → Korean'}
                </span>
                <span className="text-xs text-gray-400">{formatTime(item.timestamp)}</span>
              </div>
              <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-4 text-base leading-7 text-gray-800">
                {item.source}
              </div>
              <div className="mt-2 rounded-xl border border-indigo-100 bg-indigo-50/70 p-4">
                {item.isTranslating ? (
                  <div className="flex items-center gap-1 text-sm font-semibold text-indigo-500">
                    <span className="animate-pulse">번역 중...</span>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <p className="whitespace-pre-wrap text-base font-semibold leading-7 text-indigo-950 md:text-lg">
                      {item.translated}
                    </p>
                    {item.translated && item.translated !== '번역 오류' && (
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() =>
                            speak(item.translated, item.direction === 'ko-en' ? 'en-US' : 'ko-KR')
                          }
                          className="rounded-lg border border-indigo-100 bg-white px-2.5 py-2 text-xs font-bold text-indigo-600"
                        >
                          재생
                        </button>
                        <button
                          type="button"
                          onClick={() => void navigator.clipboard.writeText(item.translated)}
                          className="rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs font-bold text-gray-600"
                        >
                          복사
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </article>
          ))}

          {(currentTranscript || livePreview || micWanted) && (
            <section className="rounded-2xl border-2 border-dashed border-indigo-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-black uppercase tracking-wide text-indigo-500">실시간</span>
                <span className="text-xs font-bold text-emerald-600">{micWanted ? '● Listening' : ''}</span>
              </div>
              <div className="mt-3 min-h-20 rounded-xl bg-gray-50 p-4">
                <div className="mb-1 text-[11px] font-black uppercase tracking-wide text-gray-400">원문 자막</div>
                <p className="whitespace-pre-wrap text-lg font-semibold leading-8 text-gray-800">
                  {currentTranscript || '말씀하시면 실시간 원문이 여기에 표시됩니다.'}
                </p>
              </div>
              <div className="mt-2 min-h-20 rounded-xl border border-indigo-100 bg-indigo-50/60 p-4">
                <div className="flex items-center justify-between">
                  <div className="text-[11px] font-black uppercase tracking-wide text-indigo-500">
                    Live Translate 미리보기
                  </div>
                  <div className="text-[11px] font-bold text-gray-400">
                    {live.translatePreviewAvailable ? '실시간 스트림' : '연결 대기 / fallback'}
                  </div>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-lg font-semibold leading-8 text-indigo-950">
                  {livePreview || '말하는 중 번역 미리보기가 가능하면 여기에 나타납니다.'}
                </p>
              </div>
            </section>
          )}

          <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="text-xs font-black uppercase tracking-wide text-gray-400">직접 입력 테스트</div>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <textarea
                value={manualText}
                onChange={(event) => setManualText(event.target.value)}
                placeholder="한국어 또는 영어를 입력하면 반대 언어로 번역합니다."
                className="min-h-20 flex-1 resize-y rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm leading-6 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
              />
              <button
                type="button"
                disabled={!manualText.trim()}
                onClick={submitManualText}
                className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-extrabold text-white disabled:opacity-40"
              >
                번역
              </button>
            </div>
          </section>

          <div className="h-28" />
        </div>
      </main>

      <footer className="shrink-0 border-t border-gray-200 bg-white/95 px-4 py-3 shadow-[0_-8px_30px_rgba(15,23,42,0.08)] backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-xs font-bold text-gray-500">
            <input
              type="checkbox"
              checked={autoSpeak}
              onChange={(event) => setAutoSpeak(event.target.checked)}
              className="h-4 w-4"
            />
            확정 번역 자동 읽기
          </label>

          <button
            type="button"
            disabled={live.status === 'connecting'}
            onClick={() => void (micWanted ? stopMic() : startMic())}
            className={`min-w-44 rounded-full px-6 py-3.5 text-sm font-extrabold shadow-lg transition disabled:opacity-50 ${
              micWanted
                ? 'bg-red-500 text-white hover:bg-red-600'
                : 'bg-indigo-600 text-white hover:bg-indigo-700'
            }`}
          >
            {live.status === 'connecting'
              ? '연결 중...'
              : micWanted
                ? '■ 마이크 끄기'
                : '🎙 마이크 켜기'}
          </button>

          <button
            type="button"
            onClick={() => {
              setHistory([]);
              setCurrentTranscript('');
              setLivePreviewEn('');
              setLivePreviewKo('');
              setLatestPreviewTarget(null);
              setError('');
              setWarning('');
            }}
            className="rounded-xl border border-gray-200 px-3 py-2 text-xs font-bold text-gray-500 hover:bg-gray-50"
          >
            기록 지우기
          </button>
        </div>
      </footer>
    </div>
  );
}
