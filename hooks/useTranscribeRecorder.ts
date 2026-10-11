import { useCallback, useEffect, useRef, useState } from 'react';
import { GoogleGenAI } from '@google/genai';
import { float32ToInt16, arrayBufferToBase64 } from '../utils/audioUtils';

export type LiveLine = { id: string; text: string; receivedAt: number };
const MODEL = 'gemini-3.5-transcribe-live';
const ROTATE_AFTER_MS = 9 * 60_000 + 20_000;

export function useTranscribeRecorder() {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'recording' | 'error'>('idle');
  const [lines, setLines] = useState<LiveLine[]>([]);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [sessionElapsed, setSessionElapsed] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [sessionCount, setSessionCount] = useState(0);
  const desired = useRef(false);
  const sequence = useRef(0);
  const session = useRef<any>(null);
  const stream = useRef<MediaStream | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const processor = useRef<ScriptProcessorNode | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const totalStarted = useRef(0);
  const sessionStarted = useRef(0);
  const clock = useRef<ReturnType<typeof setInterval> | null>(null);
  const rotate = useRef<ReturnType<typeof setTimeout> | null>(null);

  const releaseSession = useCallback(() => {
    sequence.current++;
    if (rotate.current) clearTimeout(rotate.current);
    rotate.current = null;
    try { session.current?.close?.(); } catch { /* best effort */ }
    session.current = null;
  }, []);

  const connect = useCallback(async () => {
    if (!desired.current) return;
    releaseSession();
    const seq = sequence.current;
    setStatus('connecting');
    try {
      const tokenResponse = await fetch('/api/live-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL }),
      });
      const tokenData = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || !tokenData.token) throw new Error(tokenData.detail || '임시 인증 토큰을 발급하지 못했습니다.');
      if (!desired.current || sequence.current !== seq) return;
      const ai = new GoogleGenAI({ apiKey: tokenData.token, httpOptions: { apiVersion: 'v1alpha' } });
      const live = await ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: ['TEXT'],
          realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 650 } },
          inputAudioTranscription: { languageCodes: [], mode: 'VERBATIM' },
        } as any,
        callbacks: {
          onopen: () => {},
          onmessage: (message: any) => {
            if (!desired.current || sequence.current !== seq) return;
            const content = message?.serverContent;
            const intermediate = content?.interimInputTranscription?.text;
            const final = content?.inputTranscription?.text;
            if (intermediate) setInterim(String(intermediate));
            if (final && String(final).trim()) {
              setLines((prev) => [...prev, { id: `${seq}-${Date.now()}-${prev.length}`, text: String(final).trim(), receivedAt: Date.now() }]);
              setInterim('');
            }
          },
          onerror: () => { if (desired.current && sequence.current === seq) setError('실시간 연결 오류가 발생했습니다. 재연결을 시도해 주세요.'); },
          onclose: () => { if (desired.current && sequence.current === seq) setStatus('error'); },
        },
      } as any);
      if (!desired.current || sequence.current !== seq) {
        live.close?.();
        return;
      }
      session.current = live;
      sessionStarted.current = Date.now();
      setSessionElapsed(0);
      setSessionCount((n) => n + 1);
      setStatus('recording');
      setError('');
      rotate.current = setTimeout(() => { void connect(); }, ROTATE_AFTER_MS);
    } catch (err) {
      if (desired.current && sequence.current === seq) {
        setError(err instanceof Error ? err.message : '실시간 연결에 실패했습니다.');
        setStatus('error');
      }
    }
  }, [releaseSession]);

  const stop = useCallback(() => {
    desired.current = false;
    releaseSession();
    if (clock.current) clearInterval(clock.current);
    clock.current = null;
    try { recorder.current?.stop(); } catch { /* recorder may already be stopped */ }
    recorder.current = null;
    processor.current?.disconnect();
    processor.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (ctx.current) void ctx.current.close().catch(() => {});
    ctx.current = null;
    setInterim('');
    setStatus('idle');
  }, [releaseSession]);

  const start = useCallback(async () => {
    if (desired.current) return;
    desired.current = true;
    setError('');
    setInterim('');
    setLines([]);
    setElapsed(0);
    setSessionElapsed(0);
    setSessionCount(0);
    setRecordedBlob(null);
    chunks.current = [];
    totalStarted.current = Date.now();
    setStatus('connecting');
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!desired.current) { media.getTracks().forEach((t) => t.stop()); return; }
      stream.current = media;
      const mediaType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find((type) => MediaRecorder.isTypeSupported(type));
      const rec = new MediaRecorder(media, mediaType ? { mimeType: mediaType } : undefined);
      recorder.current = rec;
      rec.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data); };
      rec.onstop = () => { if (chunks.current.length) setRecordedBlob(new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' })); };
      rec.start(1000);
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      ctx.current = audioCtx;
      await audioCtx.resume();
      const source = audioCtx.createMediaStreamSource(media);
      const work = audioCtx.createScriptProcessor(2048, 1, 1);
      processor.current = work;
      work.onaudioprocess = (ev) => {
        if (!desired.current || !session.current) return;
        const pcm = float32ToInt16(ev.inputBuffer.getChannelData(0));
        try { session.current.sendRealtimeInput({ media: { data: arrayBufferToBase64(pcm.buffer), mimeType: 'audio/pcm;rate=16000' } }); }
        catch { /* live session owns connection status */ }
      };
      source.connect(work);
      work.connect(audioCtx.destination);
      clock.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - totalStarted.current) / 1000));
        if (sessionStarted.current) setSessionElapsed(Math.floor((Date.now() - sessionStarted.current) / 1000));
      }, 1000);
      await connect();
    } catch (err) {
      setError(err instanceof Error ? err.message : '마이크를 시작할 수 없습니다.');
      stop();
      setStatus('error');
    }
  }, [connect, stop]);

  useEffect(() => () => stop(), [stop]);
  return { start, stop, status, lines, setLines, interim, error, elapsed, sessionElapsed, sessionCount, recordedBlob };
}
