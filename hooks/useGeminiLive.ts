import { useState, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { ConnectionStatus, Language, ConversationItem } from '../types';
import { MODEL_LIVE } from '../constants';
import { createPcmBlob, float32ToInt16, arrayBufferToBase64, base64ToUint8Array, decodeAudioData } from '../utils/audioUtils';

interface UseGeminiLiveProps {
    langInput: Language;
    onTranscriptReceived: (text: string, isFinal: boolean) => void;
    onAudioReceived: (base64: string) => void;
    postApi: <T>(endpoint: string, body: any) => Promise<T>;
    settings: { recordOriginalEnabled: boolean };
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

    const cleanupAudio = useCallback(() => {
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

            const tokenData = await postApi<{ token: string }>('live-token', { model: MODEL_LIVE });
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
            const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
            inputAudioContextRef.current = inputCtx;
            audioContextRef.current = audioCtx;
            await inputCtx.resume();
            await audioCtx.resume();

            if (!geminiMicDesiredRef.current || !isCurrentAttempt()) {
                cleanupAudio();
                isGeminiConnectingRef.current = false;
                return;
            }

            const analyserNode = audioCtx.createAnalyser();
            analyserNode.fftSize = 256;
            setAnalyser(analyserNode);

            const instruction = `You are a helpful assistant acting as a transcriber. Your task is to listen to the user speaking in ${langInput.name}.`;

            const sessionPromise = (ai as any).live.connect({
                model: MODEL_LIVE,
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } },
                    },
                    systemInstruction: instruction,
                    inputAudioTranscription: {},
                },
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
                        setErrorMessage('');
                        geminiReconnectAttemptRef.current = 0;
                        setStatus(ConnectionStatus.CONNECTED);
                        setIsMicOn(true);
                        isGeminiConnectingRef.current = false;

                        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } });
                        streamRef.current = stream;
                        startOriginalRecording(stream);

                        const source = inputCtx.createMediaStreamSource(stream);
                        const processor = inputCtx.createScriptProcessor(4096, 1, 1);
                        processorRef.current = processor;

                        processor.onaudioprocess = async (e) => {
                            const session = await sessionPromise;
                            if (session && geminiMicDesiredRef.current) {
                                const inputData = e.inputBuffer.getChannelData(0);
                                const pcm16 = float32ToInt16(inputData);
                                session.send({
                                    realtimeInput: {
                                        mediaChunks: [{
                                            data: arrayBufferToBase64(pcm16.buffer),
                                            mimeType: 'audio/pcm;rate=16000'
                                        }]
                                    }
                                });
                            }
                        };

                        source.connect(processor);
                        processor.connect(inputCtx.destination);
                    },
                    onmessage: async (msg: any) => {
                        if (!isCurrentAttempt()) return;
                        if (msg.serverContent?.modelTurn?.parts) {
                            for (const part of msg.serverContent.modelTurn.parts) {
                                if (part.inlineData) {
                                    onAudioReceived(part.inlineData.data);
                                    await playPCM(part.inlineData.data);
                                }
                            }
                        }
                        if (msg.serverContent?.interruption) {
                            // Handle interruption if needed
                        }
                        if (msg.serverContent?.turnComplete) {
                            // Handle turn complete if needed
                        }
                    },
                    ontranscript: (t: any) => {
                        if (!isCurrentAttempt()) return;
                        onTranscriptReceived(t.text, t.isFinal);
                    },
                    onerror: (err: any) => {
                        console.error('Gemini Session Error:', err);
                        if (isCurrentAttempt()) {
                            setStatus(ConnectionStatus.ERROR);
                            setIsMicOn(false);
                            cleanupAudio();
                        }
                    },
                    onclose: (reason: any) => {
                        console.log('Gemini Session Closed:', reason);
                        if (isCurrentAttempt() && geminiMicDesiredRef.current) {
                            // Schedule reconnect
                            const attempt = geminiReconnectAttemptRef.current;
                            if (attempt < 3) {
                                const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
                                geminiReconnectAttemptRef.current++;
                                setTimeout(() => connectToGemini({ isRetry: true }), delay);
                            }
                        }
                    }
                },
            });

            sessionPromiseRef.current = sessionPromise;

        } catch (err) {
            console.error('Gemini connection failed:', err);
            if (isCurrentAttempt()) {
                setStatus(ConnectionStatus.ERROR);
                setIsMicOn(false);
                setErrorMessage(err instanceof Error ? err.message : String(err));
                isGeminiConnectingRef.current = false;
                cleanupAudio();
            }
        }
    }, [langInput, onTranscriptReceived, onAudioReceived, postApi, cleanupAudio, startOriginalRecording]);

    const toggleMic = useCallback(() => {
        if (status === ConnectionStatus.CONNECTED) {
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
        setErrorMessage,
        analyser,
        isRecordingOriginal,
        connectToGemini,
        toggleMic,
        cleanupAudio,
        playPCM,
        stopPCM
    };
}
