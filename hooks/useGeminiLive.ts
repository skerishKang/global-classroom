import { useState, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { ConnectionStatus, Language } from '../types';
import { float32ToInt16, arrayBufferToBase64, base64ToUint8Array, decodeAudioData, pcm16Base64ToWavBlob } from '../utils/audioUtils';

interface UseGeminiLiveProps {
    langInput: Language;
    onTranscriptReceived: (text: string, isFinal: boolean) => void;
    onAudioReceived: (base64: string) => void;
    postApi: <T>(endpoint: string, body: any) => Promise<T>;
    settings: { recordOriginalEnabled: boolean };
}

export const GLOBAL_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live';
export const MAX_FALLBACK_PCM_BYTES = 2_500_000;

export function mergeLiveTranscriptChunk(previous: string, incoming: string) {
    if (!incoming) return previous;
    if (!previous) return incoming;
    // Some Live backends emit cumulative hypotheses while others emit deltas.
    // Accept both without duplicating an already-seen prefix/suffix.
    if (incoming.startsWith(previous)) return incoming;
    if (previous.endsWith(incoming)) return previous;
    return previous + incoming;
}

export function buildGlobalTranscribeConfig(languageCode: string) {
    return {
        responseModalities: [Modality.TEXT],
        realtimeInputConfig: {
            automaticActivityDetection: {
                silenceDurationMs: 650,
            },
        },
        inputAudioTranscription: {
            languageCodes: languageCode === 'auto' ? [] : [languageCode],
            mode: 'VERBATIM',
        },
    };
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('오디오를 읽지 못했습니다.'));
        reader.readAsDataURL(blob);
    });
}

export function useGeminiLive({ langInput, onTranscriptReceived, onAudioReceived, postApi, settings }: UseGeminiLiveProps) {
    const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
    const [isMicOn, setIsMicOn] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
    const [isRecordingOriginal, setIsRecordingOriginal] = useState(false);

    // Audio Context Refs
    const audioContextRef = useRef<AudioContext | null>(null);
    const inputAudioContextRef = useRef<AudioContext | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const processorRef = useRef<ScriptProcessorNode | null>(null);
    const sessionPromiseRef = useRef<Promise<any> | null>(null);
    const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);

    // Gemini Connection Refs
    const geminiReconnectTimeoutRef = useRef<number | null>(null);
    const geminiReconnectAttemptRef = useRef(0);
    const geminiMicDesiredRef = useRef(false);
    const isGeminiConnectingRef = useRef(false);
    const geminiConnectIdRef = useRef(0);

    // Original Recording Refs
    const originalMediaRecorderRef = useRef<MediaRecorder | null>(null);
    const originalAudioChunksRef = useRef<Blob[]>([]);

    // Transcription + fallback refs
    const currentTurnTranscriptRef = useRef<string>('');
    const currentTurnPcmChunksRef = useRef<Uint8Array[]>([]);
    const currentTurnPcmBytesRef = useRef(0);
    const currentTurnCommittedRef = useRef(false);
    const browserRecognitionRef = useRef<any>(null);
    const browserRestartTimerRef = useRef<number | null>(null);
    const fallbackStreamRef = useRef<MediaStream | null>(null);
    const fallbackRecorderRef = useRef<MediaRecorder | null>(null);
    const fallbackChunksRef = useRef<Blob[]>([]);
    const fallbackCycleTimerRef = useRef<number | null>(null);
    const fallbackActiveRef = useRef(false);

    const cleanupAudio = useCallback(() => {
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

        if (fallbackCycleTimerRef.current) {
            window.clearTimeout(fallbackCycleTimerRef.current);
            fallbackCycleTimerRef.current = null;
        }
        try {
            if (fallbackRecorderRef.current?.state === 'recording') {
                fallbackRecorderRef.current.stop();
            }
        } catch {
            // no-op
        }
        fallbackRecorderRef.current = null;
        fallbackStreamRef.current?.getTracks().forEach(track => track.stop());
        fallbackStreamRef.current = null;
        fallbackChunksRef.current = [];
        fallbackActiveRef.current = false;
        currentTurnPcmChunksRef.current = [];
        currentTurnPcmBytesRef.current = 0;
        currentTurnTranscriptRef.current = '';
        currentTurnCommittedRef.current = false;

        const pendingSession = sessionPromiseRef.current;
        sessionPromiseRef.current = null;
        if (pendingSession) {
            void pendingSession
                .then((session) => session?.close?.())
                .catch(() => { });
        }

        if (currentSourceRef.current) {
            currentSourceRef.current.stop();
            currentSourceRef.current = null;
        }
        if (processorRef.current) {
            processorRef.current.disconnect();
            processorRef.current = null;
        }
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
        if (inputAudioContextRef.current) {
            inputAudioContextRef.current.close().catch(() => { });
            inputAudioContextRef.current = null;
        }
        if (audioContextRef.current) {
            audioContextRef.current.close().catch(() => { });
            audioContextRef.current = null;
        }
        setAnalyser(null);
    }, []);

    const stopOriginalRecording = useCallback(() => {
        if (originalMediaRecorderRef.current && originalMediaRecorderRef.current.state !== 'inactive') {
            originalMediaRecorderRef.current.stop();
            originalMediaRecorderRef.current = null;
        }
        setIsRecordingOriginal(false);
    }, []);

    // 사용자 제스처 시점에 오디오 컨텍스트를 깨워 자동재생 차단을 피함
    const ensureAudioContext = useCallback(async () => {
        if (!audioContextRef.current) {
            audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        }
        const ctx = audioContextRef.current;
        if (ctx.state === 'suspended') {
            try {
                await ctx.resume();
            } catch (e) {
                console.warn('AudioContext resume 실패', e);
            }
        }
    }, []);

    const startOriginalRecording = useCallback((stream: MediaStream) => {
        if (!settings.recordOriginalEnabled) return;
        try {
            const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            originalAudioChunksRef.current = [];
            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) originalAudioChunksRef.current.push(e.data);
            };
            recorder.onstop = () => {
                const blob = new Blob(originalAudioChunksRef.current, { type: 'audio/webm' });
                console.log('Original recording saved. Size:', blob.size);
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `original_session_${Date.now()}.webm`;
                // Optional: a.click() to auto download
            };
            recorder.start();
            originalMediaRecorderRef.current = recorder;
            setIsRecordingOriginal(true);
        } catch (err) {
            console.error('Failed to start original recording:', err);
        }
    }, [settings.recordOriginalEnabled]);

    const resetTurnBuffers = useCallback(() => {
        currentTurnTranscriptRef.current = '';
        currentTurnPcmChunksRef.current = [];
        currentTurnPcmBytesRef.current = 0;
        currentTurnCommittedRef.current = false;
    }, []);

    const postGroqTranscribe = useCallback(async (blob: Blob) => {
        const audioDataUrl = await blobToDataUrl(blob);
        const data = await postApi<{ text?: string }>('transcribe', {
            audioDataUrl,
            language: langInput.code === 'auto' ? 'auto' : langInput.code,
        });
        if (typeof data?.text !== 'string') {
            throw new Error('Groq STT가 전사 텍스트를 반환하지 않았습니다.');
        }
        return data.text.trim();
    }, [langInput.code, postApi]);

    const startGroqFallback = useCallback(async () => {
        if (!geminiMicDesiredRef.current || fallbackActiveRef.current) return;
        fallbackActiveRef.current = true;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                },
            });
            if (!geminiMicDesiredRef.current) {
                stream.getTracks().forEach(track => track.stop());
                fallbackActiveRef.current = false;
                return;
            }

            fallbackStreamRef.current = stream;
            startOriginalRecording(stream);
            const mimeType = [
                'audio/webm;codecs=opus',
                'audio/webm',
                'audio/mp4',
            ].find(type => MediaRecorder.isTypeSupported?.(type));
            const recorder = new MediaRecorder(
                stream,
                mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : { audioBitsPerSecond: 32_000 }
            );
            fallbackRecorderRef.current = recorder;
            fallbackChunksRef.current = [];
            setStatus(ConnectionStatus.CONNECTED);
            setIsMicOn(true);
            setErrorMessage('Gemini 실시간 전사를 사용할 수 없어 Groq STT로 자동 전환했습니다.');

            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) fallbackChunksRef.current.push(event.data);
            };

            recorder.onstop = async () => {
                if (fallbackCycleTimerRef.current) {
                    window.clearTimeout(fallbackCycleTimerRef.current);
                    fallbackCycleTimerRef.current = null;
                }

                const blob = new Blob(fallbackChunksRef.current, {
                    type: recorder.mimeType || mimeType || 'audio/webm',
                });
                fallbackChunksRef.current = [];
                fallbackRecorderRef.current = null;
                fallbackStreamRef.current?.getTracks().forEach(track => track.stop());
                fallbackStreamRef.current = null;
                fallbackActiveRef.current = false;

                if (!geminiMicDesiredRef.current || !blob.size) return;

                try {
                    const transcript = await postGroqTranscribe(blob);
                    if (transcript) onTranscriptReceived(transcript, true);
                } catch (error) {
                    setErrorMessage(`Groq STT 오류: ${error instanceof Error ? error.message : String(error)}`);
                }

                if (geminiMicDesiredRef.current) {
                    window.setTimeout(() => void startGroqFallback(), 100);
                }
            };

            recorder.start(250);
            fallbackCycleTimerRef.current = window.setTimeout(() => {
                if (fallbackRecorderRef.current?.state === 'recording') {
                    fallbackRecorderRef.current.stop();
                }
            }, 5500);
        } catch (error) {
            fallbackStreamRef.current?.getTracks().forEach(track => track.stop());
            fallbackStreamRef.current = null;
            fallbackActiveRef.current = false;
            setStatus(ConnectionStatus.ERROR);
            setIsMicOn(false);
            setErrorMessage(`마이크 fallback을 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
        }
    }, [onTranscriptReceived, postGroqTranscribe, startOriginalRecording]);

    const startBrowserFallback = useCallback(() => {
        if (!geminiMicDesiredRef.current || fallbackActiveRef.current) return;

        const SpeechRecognition =
            (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SpeechRecognition) {
            void startGroqFallback();
            return;
        }

        fallbackActiveRef.current = true;
        const runRecognition = () => {
            if (!geminiMicDesiredRef.current) return;

            const recognition = new SpeechRecognition();
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.lang = langInput.code === 'auto' ? (navigator.language || 'ko-KR') : langInput.code;
            browserRecognitionRef.current = recognition;

            recognition.onstart = () => {
                setStatus(ConnectionStatus.CONNECTED);
                setIsMicOn(true);
                setErrorMessage('Gemini 실시간 전사를 사용할 수 없어 브라우저 STT로 자동 전환했습니다.');
            };

            recognition.onresult = (event: any) => {
                let interim = '';
                for (let index = event.resultIndex; index < event.results.length; index += 1) {
                    const text = event.results[index][0]?.transcript || '';
                    if (event.results[index].isFinal) {
                        const committed = String(text).trim();
                        if (committed) onTranscriptReceived(committed, true);
                    } else {
                        interim += text;
                    }
                }
                if (interim.trim()) onTranscriptReceived(interim.trim(), false);
            };

            recognition.onerror = (event: any) => {
                const code = event?.error || 'unknown';
                browserRecognitionRef.current = null;
                if (!geminiMicDesiredRef.current) return;
                if (['network', 'service-not-allowed', 'language-not-supported'].includes(code)) {
                    recognition.onend = null;
                    try {
                        recognition.stop();
                    } catch {
                        // no-op
                    }
                    fallbackActiveRef.current = false;
                    void startGroqFallback();
                } else {
                    setErrorMessage(`브라우저 음성 인식 오류: ${code}`);
                }
            };

            recognition.onend = () => {
                browserRecognitionRef.current = null;
                if (!geminiMicDesiredRef.current || !fallbackActiveRef.current) return;
                browserRestartTimerRef.current = window.setTimeout(runRecognition, 150);
            };

            try {
                recognition.start();
            } catch {
                browserRecognitionRef.current = null;
                fallbackActiveRef.current = false;
                void startGroqFallback();
            }
        };

        runRecognition();
    }, [langInput.code, onTranscriptReceived, startGroqFallback]);

    const beginFallback = useCallback((reason: string) => {
        if (!geminiMicDesiredRef.current || fallbackActiveRef.current) return;
        // Suppress the Live onclose callback while we deliberately tear down
        // this session, then restore the user's mic intent for the fallback.
        geminiMicDesiredRef.current = false;
        stopOriginalRecording();
        cleanupAudio();
        isGeminiConnectingRef.current = false;
        geminiMicDesiredRef.current = true;
        setErrorMessage(reason);
        startBrowserFallback();
    }, [cleanupAudio, startBrowserFallback, stopOriginalRecording]);

    const recoverTurnWithGroq = useCallback(async () => {
        if (currentTurnPcmBytesRef.current <= 0) {
            beginFallback('Gemini가 받아쓰기 결과를 반환하지 않아 fallback으로 전환합니다.');
            return;
        }

        const total = currentTurnPcmBytesRef.current;
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of currentTurnPcmChunksRef.current) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
        }
        resetTurnBuffers();

        try {
            const base64 = arrayBufferToBase64(merged.buffer);
            const wav = pcm16Base64ToWavBlob(base64, 16000, 1);
            const transcript = await postGroqTranscribe(wav);
            if (transcript) {
                onTranscriptReceived(transcript, true);
                return;
            }
        } catch (error) {
            console.warn('Global voice recovery transcription failed', error);
        }

        beginFallback('Gemini 전사가 비어 있어 브라우저/Groq STT로 자동 전환합니다.');
    }, [beginFallback, onTranscriptReceived, postGroqTranscribe, resetTurnBuffers]);

    const connectToGemini = useCallback(async (opts?: { isRetry?: boolean }) => {
        let connectId = 0;
        const isCurrentAttempt = () => geminiConnectIdRef.current === connectId;

        try {
            const isRetry = opts?.isRetry === true;
            if (!isRetry) {
                setErrorMessage('');
                geminiMicDesiredRef.current = true;
                geminiReconnectAttemptRef.current = 0;
            }

            if (isGeminiConnectingRef.current) return;
            isGeminiConnectingRef.current = true;

            connectId = geminiConnectIdRef.current + 1;
            geminiConnectIdRef.current = connectId;

            if (geminiReconnectTimeoutRef.current) {
                window.clearTimeout(geminiReconnectTimeoutRef.current);
                geminiReconnectTimeoutRef.current = null;
            }

            cleanupAudio();
            setStatus(ConnectionStatus.CONNECTING);

            const tokenData = await postApi<{ token: string }>('live-token', { model: GLOBAL_TRANSCRIBE_MODEL });
            if (!geminiMicDesiredRef.current || !isCurrentAttempt()) {
                if (isCurrentAttempt()) {
                    cleanupAudio();
                    isGeminiConnectingRef.current = false;
                }
                return;
            }

            if (!tokenData?.token) {
                setStatus(ConnectionStatus.ERROR);
                setIsMicOn(false);
                setErrorMessage('토큰 발급 실패');
                geminiMicDesiredRef.current = false;
                if (isCurrentAttempt()) isGeminiConnectingRef.current = false;
                return;
            }

            const ai = (window as any).ai_client || new GoogleGenAI({ apiKey: tokenData.token, apiVersion: 'v1alpha' });
            const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            inputAudioContextRef.current = inputCtx;
            await inputCtx.resume();

            if (!geminiMicDesiredRef.current || !isCurrentAttempt()) {
                cleanupAudio();
                isGeminiConnectingRef.current = false;
                return;
            }

            const analyserNode = inputCtx.createAnalyser();
            analyserNode.fftSize = 256;
            setAnalyser(analyserNode);

            const sessionPromise = (ai as any).live.connect({
                model: GLOBAL_TRANSCRIBE_MODEL,
                config: buildGlobalTranscribeConfig(langInput.code),
                callbacks: {
                    onopen: async () => {
                        if (!geminiMicDesiredRef.current || !isCurrentAttempt()) {
                            try {
                                const session = await sessionPromise;
                                session.close();
                            } catch { }
                            return;
                        }
                        console.log("Gemini Live Connected");
                        // 디버그: 세션 객체 키 출력
                        const session = await sessionPromise;
                        console.log('[DEBUG] Session object keys:', Object.keys(session || {}));
                        console.log('[DEBUG] sendRealtimeInput type:', typeof session?.sendRealtimeInput);
                        setErrorMessage('');
                        geminiReconnectAttemptRef.current = 0;
                        setStatus(ConnectionStatus.CONNECTED);
                        setIsMicOn(true);
                        isGeminiConnectingRef.current = false;

                        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } });
                        streamRef.current = stream;
                        startOriginalRecording(stream);

                        const source = inputCtx.createMediaStreamSource(stream);
                        // 버퍼를 줄여 초기 전송 지연 최소화
                        const processor = inputCtx.createScriptProcessor(1024, 1, 1);
                        processorRef.current = processor;

                        // 세션 예열용 무음 버퍼 전송(초기 한 조각 손실 방지)
                        try {
                            const warmup = new Float32Array(1600); // 100ms @16kHz
                            const pcm16 = float32ToInt16(warmup);
                            session.sendRealtimeInput({
                                media: {
                                    data: arrayBufferToBase64(pcm16.buffer),
                                    mimeType: 'audio/pcm;rate=16000'
                                }
                            });
                        } catch (e) {
                            console.warn('warmup send failed', e);
                        }

                        processor.onaudioprocess = async (e) => {
                            const session = await sessionPromise;
                            // sendRealtimeInput이 Live API의 올바른 메서드
                            if (!session || typeof session.sendRealtimeInput !== 'function') {
                                console.error('Gemini session is not ready or sendRealtimeInput is unavailable');
                                return;
                            }
                            if (geminiMicDesiredRef.current) {
                                try {
                                    const inputData = e.inputBuffer.getChannelData(0);
                                    const pcm16 = float32ToInt16(inputData);
                                    const pcmBytes = new Uint8Array(pcm16.buffer.slice(0));
                                    if (currentTurnPcmBytesRef.current + pcmBytes.byteLength <= MAX_FALLBACK_PCM_BYTES) {
                                        currentTurnPcmChunksRef.current.push(pcmBytes);
                                        currentTurnPcmBytesRef.current += pcmBytes.byteLength;
                                    }
                                    session.sendRealtimeInput({
                                        media: {
                                            data: arrayBufferToBase64(pcm16.buffer),
                                            mimeType: 'audio/pcm;rate=16000'
                                        }
                                    });
                                    if (status !== ConnectionStatus.CONNECTED && isCurrentAttempt()) {
                                        setStatus(ConnectionStatus.CONNECTED);
                                    }
                                } catch (err) {
                                    console.error('Gemini send error:', err);
                                    setErrorMessage('음성 전송 중 오류가 발생했습니다.');
                                    setStatus(ConnectionStatus.ERROR);
                                }
                            }
                        };

                        source.connect(analyserNode);
                        analyserNode.connect(processor);
                        processor.connect(inputCtx.destination);
                    },
                    onmessage: async (msg: any) => {
                        console.log('[DEBUG] Gemini transcription message:', JSON.stringify(msg).slice(0, 500));
                        if (!isCurrentAttempt()) return;

                        const content = msg.serverContent;
                        const interim = content?.interimInputTranscription?.text;
                        const final = content?.inputTranscription;

                        if (interim) {
                            onTranscriptReceived(String(interim).trim(), false);
                        }

                        if (final?.text) {
                            currentTurnTranscriptRef.current = mergeLiveTranscriptChunk(
                                currentTurnTranscriptRef.current,
                                String(final.text),
                            );
                            const transcript = currentTurnTranscriptRef.current.trim();
                            if (transcript) {
                                onTranscriptReceived(transcript, false);
                            }
                        }

                        if (final?.finished && currentTurnTranscriptRef.current.trim() && !currentTurnCommittedRef.current) {
                            currentTurnCommittedRef.current = true;
                            onTranscriptReceived(currentTurnTranscriptRef.current.trim(), true);
                            currentTurnTranscriptRef.current = '';
                            currentTurnPcmChunksRef.current = [];
                            currentTurnPcmBytesRef.current = 0;
                        }

                        if (content?.turnComplete) {
                            if (currentTurnCommittedRef.current) {
                                resetTurnBuffers();
                                return;
                            }
                            if (currentTurnTranscriptRef.current.trim()) {
                                onTranscriptReceived(currentTurnTranscriptRef.current.trim(), true);
                                resetTurnBuffers();
                                return;
                            }

                            // The dedicated transcriber should emit inputTranscription.
                            // If it does not, recover the just-finished utterance from
                            // the bounded PCM buffer instead of silently dropping it.
                            await recoverTurnWithGroq();
                        }
                    },
                    onerror: (err: any) => {
                        console.error('Gemini transcription session error:', err);
                        if (isCurrentAttempt() && geminiMicDesiredRef.current) {
                            beginFallback(
                                `Gemini 실시간 전사 오류로 fallback을 사용합니다: ${err?.message || String(err)}`
                            );
                        }
                    },
                    onclose: (reason: any) => {
                        console.log('Gemini transcription session closed:', reason);
                        if (isCurrentAttempt() && geminiMicDesiredRef.current) {
                            beginFallback(
                                `Gemini 실시간 전사 연결이 종료되어 fallback을 사용합니다: ${reason?.reason || 'connection closed'}`
                            );
                        }
                    }
                },
            });

            sessionPromiseRef.current = sessionPromise;

        } catch (err) {
            console.error('Gemini transcription connection failed:', err);
            if (isCurrentAttempt() && geminiMicDesiredRef.current) {
                isGeminiConnectingRef.current = false;
                beginFallback(
                    `Gemini 실시간 전사를 시작하지 못해 fallback을 사용합니다: ${err instanceof Error ? err.message : String(err)}`
                );
            }
        }
    }, [
        beginFallback,
        cleanupAudio,
        langInput.code,
        onTranscriptReceived,
        postApi,
        recoverTurnWithGroq,
        resetTurnBuffers,
        startOriginalRecording,
    ]);

    const toggleMic = useCallback(() => {
        if (status === ConnectionStatus.CONNECTED || status === ConnectionStatus.CONNECTING) {
            geminiMicDesiredRef.current = false;
            setIsMicOn(false);
            setStatus(ConnectionStatus.DISCONNECTED);
            cleanupAudio();
            stopOriginalRecording();
            if (geminiReconnectTimeoutRef.current) {
                window.clearTimeout(geminiReconnectTimeoutRef.current);
                geminiReconnectTimeoutRef.current = null;
            }
        } else {
            connectToGemini();
        }
    }, [status, cleanupAudio, connectToGemini, stopOriginalRecording]);

    const playPCM = useCallback(async (base64String: string): Promise<void> => {
        return new Promise(async (resolve) => {
            try {
                if (currentSourceRef.current) {
                    currentSourceRef.current.stop();
                    currentSourceRef.current = null;
                }
                if (!audioContextRef.current) {
                    audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
                }
                const ctx = audioContextRef.current;
                if (ctx.state === 'suspended') await ctx.resume();

                const arrayBuffer = base64ToUint8Array(base64String);
                const audioBuffer = await decodeAudioData(arrayBuffer, ctx, 24000);
                const source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(ctx.destination);
                currentSourceRef.current = source;
                source.onended = () => {
                    if (currentSourceRef.current === source) {
                        currentSourceRef.current = null;
                    }
                    resolve();
                };
                source.start();
            } catch (e) {
                console.error("Audio playback error", e);
                resolve();
            }
        });
    }, []);

    const stopPCM = useCallback(() => {
        if (currentSourceRef.current) {
            currentSourceRef.current.stop();
            currentSourceRef.current = null;
        }
    }, []);

    return {
        status,
        isMicOn,
        errorMessage,
        analyser,
        isRecordingOriginal,
        connectToGemini,
        toggleMic,
        cleanupAudio,
        playPCM,
        stopPCM,
        ensureAudioContext,
        setErrorMessage
    };
}
