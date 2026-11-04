import { AudioInputMode } from '../types';
import { createLiveMixStream } from './audioMixer';

/**
 * 통역 입력 소스 캡처 (#114).
 *
 * 마이크 경로는 기존 동작(getUserMedia)을 그대로 두고, "이 컴퓨터 소리"는
 * getDisplayMedia의 오디오 트랙만 사용한다(비디오 트랙은 즉시 정지).
 * "둘 다"는 마이크(에코 제거 켬)와 화면 공유 오디오(에코 제거 끔)를 Web Audio로
 * 합쳐 한 스트림으로 돌려준다. 샘플레이트 변환은 기존 16 kHz 입력 컨텍스트 경로를
 * 그대로 재사용한다.
 */

export class SystemAudioUnsupportedError extends Error {
    constructor() {
        super('이 브라우저는 화면 공유 오디오를 지원하지 않습니다. Chrome이나 Edge에서 사용해 주세요.');
        this.name = 'SystemAudioUnsupportedError';
    }
}

export class SystemAudioUnavailableError extends Error {
    constructor() {
        super('공유 창에서 "탭 오디오 공유" 또는 "시스템 오디오 공유"를 켜 주세요.');
        this.name = 'SystemAudioUnavailableError';
    }
}

/** 사용자가 공유 선택 창을 닫았거나 권한을 거부한 경우. */
export class SystemAudioCanceledError extends Error {
    constructor() {
        super('화면 공유를 취소했습니다.');
        this.name = 'SystemAudioCanceledError';
    }
}

/** 이 브라우저가 화면 공유 오디오(getDisplayMedia)를 지원하는지 판정한다. */
export function isSystemAudioInputSupported(): boolean {
    const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
    return !!devices && typeof devices.getDisplayMedia === 'function';
}

export interface CaptureAudioInputOptions {
    /** 화면 공유 오디오 트랙이 끊겼을 때(사용자가 공유를 중지했을 때) 알린다. */
    onSystemTrackEnded?: () => void;
}

export interface CapturedAudioInput {
    mode: AudioInputMode;
    /** 기존 16 kHz 파이프라인에 그대로 넣는 스트림. */
    stream: MediaStream;
    /** 모든 트랙·노드·리스너를 정리한다. */
    stop: () => void;
}

/** Chrome/Edge 전용 옵션. 미지원 브라우저는 무시한다. */
interface DisplayAudioRequestOptions {
    video: boolean;
    audio: MediaTrackConstraints;
    systemAudio?: 'include' | 'exclude';
    selfBrowserSurface?: 'include' | 'exclude';
}

async function requestSystemAudioStream(): Promise<MediaStream> {
    if (!isSystemAudioInputSupported()) {
        throw new SystemAudioUnsupportedError();
    }
    try {
        return await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            },
            systemAudio: 'include',
            selfBrowserSurface: 'exclude',
        } as unknown as DisplayMediaStreamOptions);
    } catch (error) {
        const name = (error as DOMException | null)?.name;
        if (name === 'NotAllowedError' || name === 'AbortError') {
            throw new SystemAudioCanceledError();
        }
        throw error;
    }
}

export async function captureAudioInput(
    mode: AudioInputMode,
    mixContext: AudioContext | null,
    options: CaptureAudioInputOptions = {},
): Promise<CapturedAudioInput> {
    if (mode === 'mic') {
        // 기존 마이크 경로와 동일한 제약을 유지한다.
        const micStream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, sampleRate: 16000 },
        });
        return {
            mode,
            stream: micStream,
            stop: () => micStream.getTracks().forEach((track) => track.stop()),
        };
    }

    const systemStream = await requestSystemAudioStream();
    const systemAudioTrack = systemStream.getAudioTracks()[0] ?? null;

    // 비디오 트랙은 즉시 멈춘다. 오디오만 사용한다.
    systemStream.getVideoTracks().forEach((track) => track.stop());

    if (!systemAudioTrack) {
        systemStream.getTracks().forEach((track) => track.stop());
        throw new SystemAudioUnavailableError();
    }

    const onSystemTrackEnded = options.onSystemTrackEnded ?? null;
    if (onSystemTrackEnded) {
        systemAudioTrack.addEventListener('ended', onSystemTrackEnded);
    }

    const releaseSystemStream = () => {
        if (onSystemTrackEnded) {
            systemAudioTrack.removeEventListener('ended', onSystemTrackEnded);
        }
        systemStream.getTracks().forEach((track) => track.stop());
    };

    if (mode === 'system') {
        return {
            mode,
            stream: systemStream,
            stop: releaseSystemStream,
        };
    }

    // 'both': 마이크(에코 제거 켬) + 시스템 소리(에코 제거 끔)를 섞는다.
    let micStream: MediaStream;
    try {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
    } catch (micError) {
        releaseSystemStream();
        throw micError;
    }

    if (!mixContext) {
        micStream.getTracks().forEach((track) => track.stop());
        releaseSystemStream();
        throw new Error('믹싱에 사용할 오디오 컨텍스트가 없습니다.');
    }

    const mix = createLiveMixStream(mixContext, [micStream, systemStream]);
    return {
        mode,
        stream: mix.stream,
        stop: () => {
            mix.disconnect();
            micStream.getTracks().forEach((track) => track.stop());
            releaseSystemStream();
        },
    };
}

/** 캡처 실패를 사용자 안내 문구로 바꾼다. */
export function describeAudioInputError(error: unknown): string {
    if (
        error instanceof SystemAudioUnavailableError ||
        error instanceof SystemAudioUnsupportedError ||
        error instanceof SystemAudioCanceledError
    ) {
        return error.message;
    }
    return `입력을 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
}
