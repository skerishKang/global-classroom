import React, { useCallback, useMemo, useRef, useState } from 'react';

type Direction = 'ko-en' | 'en-ko';

type HistoryItem = {
  id: string;
  direction: Direction;
  source: string;
  translated: string;
  timestamp: number;
};

type InterviewModeProps = {
  onExit: () => void;
};

const INTRO_KO =
  '저는 영어로 기본적인 소통은 가능하지만, 복잡한 기술적인 내용을 영어로 말하면 제 생각의 절반도 정확하게 전달하기 어렵습니다. 그래서 양해해 주신다면 저는 한국어로 답하고, 제가 직접 만든 AI 통역 프로그램으로 실시간 영어 번역을 보여드리겠습니다. 이렇게 하면 제 의견을 정확히 전달할 수 있고, 동시에 제가 어떤 AI 제품을 만드는 사람인지 실제로 보여드릴 수 있습니다.';

const INTRO_EN =
  'I can communicate in English, but for complex technical topics I cannot express the full depth of my thinking as accurately as I can in Korean. So, with your permission, I will answer in Korean and use this AI interpreter that I built to translate my answers into English in real time. This lets me communicate precisely while also giving you a live demonstration of the kind of AI product I build.';

const MAX_SERVER_AUDIO_BYTES = 3 * 1024 * 1024;
const SERVER_RECORDING_MAX_MS = 120_000;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('오디오를 읽지 못했습니다.'));
    reader.readAsDataURL(blob);
  });
}

function getPreferredAudioMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function InterviewMode({ onExit }: InterviewModeProps) {
  const [koreanAnswer, setKoreanAnswer] = useState('');
  const [englishAnswer, setEnglishAnswer] = useState('');
  const [englishQuestion, setEnglishQuestion] = useState('');
  const [koreanQuestion, setKoreanQuestion] = useState('');
  const [isAnswerTranslating, setIsAnswerTranslating] = useState(false);
  const [isQuestionTranslating, setIsQuestionTranslating] = useState(false);
  const [listening, setListening] = useState<Direction | null>(null);
  const [speechError, setSpeechError] = useState('');
  const [apiError, setApiError] = useState('');
  const [showSpotlight, setShowSpotlight] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [listeningBackend, setListeningBackend] = useState<'browser' | 'groq' | null>(null);
  const [isServerTranscribing, setIsServerTranscribing] = useState(false);
  const recognitionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingDirectionRef = useRef<Direction | null>(null);
  const serverRecordingTimeoutRef = useRef<number | null>(null);

  const speechRecognitionSupported = useMemo(
    () => Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition),
    []
  );

  const postTranslate = useCallback(async (text: string, from: string, to: string) => {
    const response = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, from, to }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.detail || data?.error || 'Translation failed.');
    }
    if (typeof data?.translated !== 'string' || !data.translated.trim()) {
      throw new Error('The translation response was empty.');
    }
    return data.translated.trim();
  }, []);

  const postTranscribe = useCallback(async (blob: Blob, language: 'ko' | 'en') => {
    if (blob.size > MAX_SERVER_AUDIO_BYTES) {
      throw new Error('음성이 너무 깁니다. 답변을 짧게 나누어 다시 시도해 주세요.');
    }

    const audioDataUrl = await blobToDataUrl(blob);
    const response = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioDataUrl, language }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.detail || data?.error || '음성 전사에 실패했습니다.');
    }
    if (typeof data?.text !== 'string' || !data.text.trim()) {
      throw new Error('음성 전사 결과가 비어 있습니다.');
    }
    return data.text.trim();
  }, []);

  const speakEnglish = useCallback((text: string) => {
    if (!text.trim() || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 0.95;
    const voices = window.speechSynthesis.getVoices();
    const englishVoice = voices.find((voice) => voice.lang.toLowerCase().startsWith('en'));
    if (englishVoice) utterance.voice = englishVoice;
    window.speechSynthesis.speak(utterance);
  }, []);

  const copyText = useCallback(async (text: string) => {
    if (!text.trim()) return;
    await navigator.clipboard.writeText(text);
  }, []);

  const addHistory = useCallback((direction: Direction, source: string, translated: string) => {
    setHistory((prev) => [
      {
        id: crypto.randomUUID(),
        direction,
        source,
        translated,
        timestamp: Date.now(),
      },
      ...prev,
    ].slice(0, 20));
  }, []);

  const translateAnswer = useCallback(async (overrideText?: string) => {
    const source = (overrideText ?? koreanAnswer).trim();
    if (!source || isAnswerTranslating) return;
    setIsAnswerTranslating(true);
    setApiError('');
    try {
      const translated = await postTranslate(source, 'Korean', 'English');
      setEnglishAnswer(translated);
      addHistory('ko-en', source, translated);
      if (autoSpeak) speakEnglish(translated);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAnswerTranslating(false);
    }
  }, [koreanAnswer, isAnswerTranslating, postTranslate, addHistory, autoSpeak, speakEnglish]);

  const translateQuestion = useCallback(async (overrideText?: string) => {
    const source = (overrideText ?? englishQuestion).trim();
    if (!source || isQuestionTranslating) return;
    setIsQuestionTranslating(true);
    setApiError('');
    try {
      const translated = await postTranslate(source, 'English', 'Korean');
      setKoreanQuestion(translated);
      addHistory('en-ko', source, translated);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsQuestionTranslating(false);
    }
  }, [englishQuestion, isQuestionTranslating, postTranslate, addHistory]);

  const stopMediaStream = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }, []);

  const finishTranscript = useCallback((direction: Direction, text: string) => {
    if (direction === 'ko-en') {
      setKoreanAnswer(text);
      void translateAnswer(text);
    } else {
      setEnglishQuestion(text);
      void translateQuestion(text);
    }
  }, [translateAnswer, translateQuestion]);

  const startServerListening = useCallback(async (direction: Direction) => {
    setSpeechError('');
    setApiError('');

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setSpeechError('이 브라우저에서는 마이크 녹음을 사용할 수 없습니다. 텍스트로 입력해 주세요.');
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
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      recordingDirectionRef.current = direction;

      const mimeType = getPreferredAudioMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : { audioBitsPerSecond: 32_000 }
      );
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      recorder.onerror = () => {
        setSpeechError('서버 음성 전사용 녹음 중 오류가 발생했습니다.');
      };

      recorder.onstop = async () => {
        if (serverRecordingTimeoutRef.current) {
          window.clearTimeout(serverRecordingTimeoutRef.current);
          serverRecordingTimeoutRef.current = null;
        }

        const activeDirection = recordingDirectionRef.current || direction;
        recordingDirectionRef.current = null;
        mediaRecorderRef.current = null;
        setListening(null);
        setListeningBackend(null);
        stopMediaStream();

        const blob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || mimeType || 'audio/webm',
        });
        audioChunksRef.current = [];

        if (!blob.size) {
          setSpeechError('녹음된 음성이 없습니다. 다시 시도해 주세요.');
          return;
        }

        setIsServerTranscribing(true);
        try {
          const text = await postTranscribe(blob, activeDirection === 'ko-en' ? 'ko' : 'en');
          finishTranscript(activeDirection, text);
        } catch (error) {
          setSpeechError(error instanceof Error ? error.message : String(error));
        } finally {
          setIsServerTranscribing(false);
        }
      };

      recorder.start(250);
      setListening(direction);
      setListeningBackend('groq');

      serverRecordingTimeoutRef.current = window.setTimeout(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      }, SERVER_RECORDING_MAX_MS);
    } catch (error) {
      stopMediaStream();
      setListening(null);
      setListeningBackend(null);
      setSpeechError(
        error instanceof Error
          ? `마이크를 사용할 수 없습니다: ${error.message}`
          : '마이크를 사용할 수 없습니다.'
      );
    }
  }, [finishTranscript, postTranscribe, stopMediaStream]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // no-op
      }
      return;
    }

    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const startListening = useCallback((direction: Direction) => {
    setSpeechError('');
    setApiError('');
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      void startServerListening(direction);
      return;
    }

    stopListening();

    const recognition = new SpeechRecognition();
    recognition.lang = direction === 'ko-en' ? 'ko-KR' : 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;

    let finalText = '';
    let latestText = '';

    recognition.onstart = () => {
      setListening(direction);
      setListeningBackend('browser');
    };

    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0]?.transcript || '';
        if (event.results[i].isFinal) finalText += transcript;
        else interim += transcript;
      }
      latestText = (finalText + interim).trim();
      if (direction === 'ko-en') setKoreanAnswer(latestText);
      else setEnglishQuestion(latestText);
    };

    recognition.onerror = (event: any) => {
      const code = event?.error || 'unknown';
      const shouldUseServerFallback = [
        'network',
        'service-not-allowed',
        'language-not-supported',
      ].includes(code);

      if (shouldUseServerFallback && recognitionRef.current === recognition) {
        recognitionRef.current = null;
        try {
          recognition.abort();
        } catch {
          // no-op
        }
        setListening(null);
        setListeningBackend(null);
        void startServerListening(direction);
        return;
      }

      recognitionRef.current = null;
      setListening(null);
      setListeningBackend(null);
      setSpeechError(`음성 인식 오류: ${code}`);
    };

    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      setListening(null);
      setListeningBackend(null);
      const text = (finalText || latestText).trim();
      if (!text) return;
      finishTranscript(direction, text);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [finishTranscript, startServerListening, stopListening]);

  const loadIntro = useCallback(() => {
    setKoreanAnswer(INTRO_KO);
    setEnglishAnswer(INTRO_EN);
    setApiError('');
  }, []);

  const clearAnswer = useCallback(() => {
    setKoreanAnswer('');
    setEnglishAnswer('');
    setApiError('');
    window.speechSynthesis?.cancel();
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="border-b border-white/10 bg-slate-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 md:px-8">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.25em] text-sky-300">Global Classroom</div>
            <h1 className="mt-1 text-xl font-bold md:text-2xl">AI Interview Interpreter</h1>
          </div>
          <button
            type="button"
            onClick={onExit}
            className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-white/10"
          >
            기존 화면
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 md:px-8">
        <section className="rounded-3xl border border-sky-400/20 bg-gradient-to-br from-sky-500/15 to-indigo-500/10 p-5 md:p-7">
          <div className="max-w-4xl">
            <p className="text-sm font-semibold text-sky-300">Interview opening</p>
            <h2 className="mt-2 text-2xl font-bold leading-tight md:text-3xl">
              한국어로 생각을 정확히 말하고, 제가 만든 AI 통역기로 영어로 전달합니다.
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-300 md:text-base">
              영어 실력을 숨기기 위한 도구가 아니라, 기술적인 생각을 손실 없이 전달하면서 제가 만든 AI 제품을 실제 면접에서 직접 보여주기 위한 모드입니다.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={loadIntro}
                className="rounded-xl bg-sky-400 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-sky-300"
              >
                시작 안내문 불러오기
              </button>
              <button
                type="button"
                onClick={() => speakEnglish(englishAnswer || INTRO_EN)}
                className="rounded-xl border border-white/15 px-4 py-2.5 text-sm font-semibold hover:bg-white/10"
              >
                영어로 읽기
              </button>
            </div>
          </div>
        </section>

        {(apiError || speechError) && (
          <section className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            {apiError || speechError}
          </section>
        )}

        <section className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-5 md:p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">My answer</p>
                <h3 className="mt-1 text-xl font-bold">한국어로 답변</h3>
              </div>
              <button
                type="button"
                disabled={isServerTranscribing}
                onClick={() => listening === 'ko-en' ? stopListening() : startListening('ko-en')}
                className={`rounded-xl px-4 py-2.5 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50 ${
                  listening === 'ko-en' ? 'bg-rose-400 text-slate-950' : 'bg-white text-slate-950'
                }`}
              >
                {isServerTranscribing && recordingDirectionRef.current === 'ko-en'
                  ? 'Groq 전사 중…'
                  : listening === 'ko-en'
                    ? listeningBackend === 'groq' ? '서버 녹음 중지' : '듣기 중지'
                    : '한국어 말하기'}
              </button>
            </div>

            <textarea
              value={koreanAnswer}
              onChange={(event) => setKoreanAnswer(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void translateAnswer();
                }
              }}
              placeholder="여기에 한국어로 답하거나 마이크 버튼을 누르세요."
              className="mt-4 min-h-52 w-full resize-y rounded-2xl border border-white/10 bg-slate-900/80 p-4 text-lg leading-8 text-white outline-none placeholder:text-slate-500 focus:border-sky-400/60"
            />

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!koreanAnswer.trim() || isAnswerTranslating}
                onClick={() => void translateAnswer()}
                className="rounded-xl bg-sky-400 px-5 py-3 text-sm font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isAnswerTranslating ? '영어로 번역 중…' : '영어로 전달'}
              </button>
              <button
                type="button"
                onClick={clearAnswer}
                className="rounded-xl border border-white/15 px-4 py-3 text-sm font-semibold hover:bg-white/10"
              >
                새 답변
              </button>
              <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={autoSpeak}
                  onChange={(event) => setAutoSpeak(event.target.checked)}
                  className="h-4 w-4"
                />
                번역 후 자동 읽기
              </label>
            </div>

            <p className="mt-3 text-xs text-slate-400">
              {speechRecognitionSupported
                ? '브라우저 음성 전사를 우선 사용하며, 지원 오류가 나면 Groq Whisper로 자동 전환합니다.'
                : '이 브라우저는 내장 음성 전사가 없어 Groq Whisper로 자동 전환합니다.'}
            </p>
            {listeningBackend === 'groq' && (
              <p className="mt-1 text-xs font-semibold text-amber-300">
                Groq Whisper fallback으로 녹음 중입니다. 말을 마친 뒤 버튼을 다시 눌러 주세요.
              </p>
            )}
          </div>

          <div className="rounded-3xl border border-sky-400/20 bg-sky-400/[0.06] p-5 md:p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-sky-300">For the interviewer</p>
                <h3 className="mt-1 text-xl font-bold">English answer</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowSpotlight(true)}
                disabled={!englishAnswer.trim()}
                className="rounded-xl border border-sky-300/30 px-4 py-2.5 text-sm font-semibold text-sky-100 disabled:opacity-40"
              >
                크게 보여주기
              </button>
            </div>

            <div className="mt-4 min-h-52 rounded-2xl border border-white/10 bg-slate-950/70 p-5">
              <p className="whitespace-pre-wrap text-xl font-medium leading-9 text-white md:text-2xl">
                {englishAnswer || 'Your English translation will appear here.'}
              </p>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => speakEnglish(englishAnswer)}
                disabled={!englishAnswer.trim()}
                className="rounded-xl bg-white px-4 py-3 text-sm font-bold text-slate-950 disabled:opacity-40"
              >
                영어 음성 재생
              </button>
              <button
                type="button"
                onClick={() => void copyText(englishAnswer)}
                disabled={!englishAnswer.trim()}
                className="rounded-xl border border-white/15 px-4 py-3 text-sm font-semibold disabled:opacity-40"
              >
                영어 복사
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-5 md:p-6">
          <div className="mb-4">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">Understand the interviewer</p>
            <h3 className="mt-1 text-xl font-bold">영어 질문 → 한국어 확인</h3>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <textarea
                value={englishQuestion}
                onChange={(event) => setEnglishQuestion(event.target.value)}
                placeholder="면접관의 영어 질문을 붙여넣거나 영어 음성 인식을 사용하세요."
                className="min-h-36 w-full resize-y rounded-2xl border border-white/10 bg-slate-900/80 p-4 text-base leading-7 text-white outline-none placeholder:text-slate-500"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={isServerTranscribing}
                  onClick={() => listening === 'en-ko' ? stopListening() : startListening('en-ko')}
                  className="rounded-xl border border-white/15 px-4 py-2.5 text-sm font-semibold hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isServerTranscribing && recordingDirectionRef.current === 'en-ko'
                    ? 'Groq 전사 중…'
                    : listening === 'en-ko'
                      ? listeningBackend === 'groq' ? '서버 녹음 중지' : '듣기 중지'
                      : '영어 질문 듣기'}
                </button>
                <button
                  type="button"
                  disabled={!englishQuestion.trim() || isQuestionTranslating}
                  onClick={() => void translateQuestion()}
                  className="rounded-xl bg-indigo-300 px-4 py-2.5 text-sm font-bold text-slate-950 disabled:opacity-40"
                >
                  {isQuestionTranslating ? '번역 중…' : '한국어로 이해'}
                </button>
              </div>
            </div>
            <div className="min-h-36 rounded-2xl border border-white/10 bg-slate-950/70 p-4">
              <p className="whitespace-pre-wrap text-lg leading-8 text-slate-100">
                {koreanQuestion || '질문의 한국어 번역이 여기에 표시됩니다.'}
              </p>
            </div>
          </div>
        </section>

        {history.length > 0 && (
          <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-5 md:p-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold">Interview history</h3>
              <button
                type="button"
                onClick={() => setHistory([])}
                className="text-sm font-semibold text-slate-400 hover:text-white"
              >
                기록 지우기
              </button>
            </div>
            <div className="mt-4 space-y-3">
              {history.map((item) => (
                <div key={item.id} className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                  <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
                    <span>{item.direction === 'ko-en' ? 'Korean → English' : 'English → Korean'}</span>
                    <span>{formatTime(item.timestamp)}</span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-400">{item.source}</p>
                  <p className="mt-2 text-base font-medium leading-7 text-white">{item.translated}</p>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      {showSpotlight && (
        <div className="fixed inset-0 z-50 flex flex-col bg-slate-950 p-6 md:p-12">
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold uppercase tracking-[0.22em] text-sky-300">AI Interview Interpreter</div>
            <button
              type="button"
              onClick={() => setShowSpotlight(false)}
              className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold"
            >
              닫기
            </button>
          </div>
          <div className="flex flex-1 items-center justify-center">
            <p className="max-w-6xl whitespace-pre-wrap text-center text-3xl font-semibold leading-relaxed text-white md:text-5xl">
              {englishAnswer}
            </p>
          </div>
          <div className="flex justify-center gap-2">
            <button
              type="button"
              onClick={() => speakEnglish(englishAnswer)}
              className="rounded-xl bg-white px-5 py-3 text-sm font-bold text-slate-950"
            >
              Speak English
            </button>
            <button
              type="button"
              onClick={() => void copyText(englishAnswer)}
              className="rounded-xl border border-white/15 px-5 py-3 text-sm font-semibold"
            >
              Copy
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
