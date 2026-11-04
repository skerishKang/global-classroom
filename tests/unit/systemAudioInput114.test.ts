import { afterEach, describe, expect, test, vi } from 'vitest';
import {
    captureAudioInput,
    describeAudioInputError,
    isSystemAudioInputSupported,
    SystemAudioCanceledError,
    SystemAudioUnavailableError,
    SystemAudioUnsupportedError,
} from '../../utils/inputSource';
import {
    createDefaultSettings,
    normalizeAudioInputMode,
    parseStoredSettings,
} from '../../utils/settingsStorage';

afterEach(() => vi.unstubAllGlobals());

function fakeTrack(kind: 'audio' | 'video') {
    return {
        kind,
        stop: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
}

function fakeStream(tracks: any[]): MediaStream {
    return {
        getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
        getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
        getTracks: () => tracks,
    } as unknown as MediaStream;
}

function stubMediaDevices(overrides: { getUserMedia?: any; getDisplayMedia?: any } = {}) {
    const mediaDevices = {
        getUserMedia: overrides.getUserMedia ?? vi.fn(),
        getDisplayMedia: overrides.getDisplayMedia ?? vi.fn(),
    };
    vi.stubGlobal('navigator', { mediaDevices });
    return mediaDevices;
}

function mixContextHarness() {
    const destination = { stream: {} as MediaStream, disconnect: vi.fn() };
    const gains: any[] = [];
    const sources: any[] = [];
    const context = {
        createMediaStreamDestination: vi.fn(() => destination),
        createMediaStreamSource: vi.fn(() => {
            const source = { connect: vi.fn(), disconnect: vi.fn() };
            sources.push(source);
            return source;
        }),
        createGain: vi.fn(() => {
            const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
            gains.push(gain);
            return gain;
        }),
    } as unknown as AudioContext;
    return { context, destination, gains, sources };
}

describe('#114 input source capture', () => {
    test('mic 모드는 기존 getUserMedia 경로를 그대로 쓰고 화면 공유를 요청하지 않는다', async () => {
        const micTrack = fakeTrack('audio');
        const micStream = fakeStream([micTrack]);
        const devices = stubMediaDevices({ getUserMedia: vi.fn().mockResolvedValue(micStream) });

        const capture = await captureAudioInput('mic', null);

        expect(devices.getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: 1, sampleRate: 16000 } });
        expect(devices.getDisplayMedia).not.toHaveBeenCalled();
        expect(capture.mode).toBe('mic');
        expect(capture.stream).toBe(micStream);

        capture.stop();
        expect(micTrack.stop).toHaveBeenCalledTimes(1);
    });

    test('system 모드는 비디오 트랙을 즉시 멈추고 오디오 트랙에 ended 리스너를 건다', async () => {
        const video = fakeTrack('video');
        const audio = fakeTrack('audio');
        const displayStream = fakeStream([video, audio]);
        const devices = stubMediaDevices({ getDisplayMedia: vi.fn().mockResolvedValue(displayStream) });
        const onSystemTrackEnded = vi.fn();

        const capture = await captureAudioInput('system', null, { onSystemTrackEnded });

        const options = devices.getDisplayMedia.mock.calls[0][0];
        expect(options.video).toBe(true);
        expect(options.audio).toEqual({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
        expect(options.systemAudio).toBe('include');
        expect(options.selfBrowserSurface).toBe('exclude');

        expect(video.stop).toHaveBeenCalledTimes(1);
        expect(audio.stop).not.toHaveBeenCalled();
        expect(audio.addEventListener).toHaveBeenCalledWith('ended', onSystemTrackEnded);
        expect(capture.stream).toBe(displayStream);

        capture.stop();
        expect(audio.stop).toHaveBeenCalledTimes(1);
        expect(audio.removeEventListener).toHaveBeenCalledWith('ended', onSystemTrackEnded);
    });

    test('오디오 트랙이 없으면 안내 문구와 함께 실패하고 비디오는 정리한다', async () => {
        const video = fakeTrack('video');
        stubMediaDevices({ getDisplayMedia: vi.fn().mockResolvedValue(fakeStream([video])) });

        let error: unknown;
        try {
            await captureAudioInput('system', null);
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(SystemAudioUnavailableError);
        expect((error as Error).message).toContain('탭 오디오 공유');
        expect(video.stop).toHaveBeenCalled(); // 즉시 정지 + 실패 시 전체 정리(멱등)
    });

    test('getDisplayMedia가 없는 브라우저는 미지원 오류로 실패한다', async () => {
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });

        expect(isSystemAudioInputSupported()).toBe(false);
        await expect(captureAudioInput('system', null)).rejects.toThrow(SystemAudioUnsupportedError);
    });

    test('getDisplayMedia가 있으면 지원 판정이 참이다', () => {
        stubMediaDevices();
        expect(isSystemAudioInputSupported()).toBe(true);
    });

    test('공유 창을 닫으면 취소 오류로 바뀐다', async () => {
        stubMediaDevices({
            getDisplayMedia: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')),
        });

        await expect(captureAudioInput('system', null)).rejects.toThrow(SystemAudioCanceledError);
    });

    test('both 모드는 마이크(에코 제거 켬)와 시스템 소리(에코 제거 끔)를 믹서로 섞는다', async () => {
        const micTrack = fakeTrack('audio');
        const micStream = fakeStream([micTrack]);
        const video = fakeTrack('video');
        const systemAudio = fakeTrack('audio');
        const displayStream = fakeStream([video, systemAudio]);
        const devices = stubMediaDevices({
            getUserMedia: vi.fn().mockResolvedValue(micStream),
            getDisplayMedia: vi.fn().mockResolvedValue(displayStream),
        });
        const harness = mixContextHarness();

        const capture = await captureAudioInput('both', harness.context);

        expect(devices.getDisplayMedia).toHaveBeenCalledTimes(1);
        expect(devices.getUserMedia).toHaveBeenCalledWith({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
        expect(video.stop).toHaveBeenCalled(); // 즉시 정지 + 해제 시 전체 정리(멱등)
        expect(harness.context.createMediaStreamSource).toHaveBeenCalledTimes(2);
        expect(harness.gains).toHaveLength(2);
        for (const gain of harness.gains) {
            expect(gain.gain.value).toBe(0.5);
            gain.connect.mock.calls.forEach((call: any[]) => expect(call[0]).toBe(harness.destination));
        }
        expect(capture.mode).toBe('both');
        expect(capture.stream).toBe(harness.destination.stream);

        capture.stop();
        expect(harness.sources[0].disconnect).toHaveBeenCalled();
        expect(harness.sources[1].disconnect).toHaveBeenCalled();
        expect(harness.destination.disconnect).toHaveBeenCalled();
        expect(micTrack.stop).toHaveBeenCalledTimes(1);
        expect(systemAudio.stop).toHaveBeenCalledTimes(1);
    });

    test('both 모드에서 마이크 확보가 실패하면 화면 공유 스트림도 정리한다', async () => {
        const video = fakeTrack('video');
        const displayStream = fakeStream([video, fakeTrack('audio')]);
        stubMediaDevices({
            getUserMedia: vi.fn().mockRejectedValue(new Error('mic denied')),
            getDisplayMedia: vi.fn().mockResolvedValue(displayStream),
        });

        await expect(captureAudioInput('both', mixContextHarness().context)).rejects.toThrow('mic denied');
        expect(video.stop).toHaveBeenCalled();
    });

    test('describeAudioInputError는 오류 종류별 안내 문구를 돌려준다', () => {
        expect(describeAudioInputError(new SystemAudioUnavailableError())).toContain('탭 오디오 공유');
        expect(describeAudioInputError(new SystemAudioUnsupportedError())).toContain('Chrome');
        expect(describeAudioInputError(new SystemAudioCanceledError())).toContain('취소');
        expect(describeAudioInputError(new Error('boom'))).toContain('boom');
    });
});

describe('#114 audio input mode setting', () => {
    test('정규화는 허용된 값만 통과시키고 나머지는 마이크로 되돌린다', () => {
        expect(normalizeAudioInputMode('mic')).toBe('mic');
        expect(normalizeAudioInputMode('system')).toBe('system');
        expect(normalizeAudioInputMode('both')).toBe('both');
        expect(normalizeAudioInputMode('bogus')).toBe('mic');
        expect(normalizeAudioInputMode(42)).toBe('mic');
        expect(normalizeAudioInputMode(undefined)).toBe('mic');
    });

    test('기본값과 저장 직렬화는 마이크를 기본으로 유지한다', () => {
        expect(createDefaultSettings().audioInputMode).toBe('mic');
        expect(parseStoredSettings(null).audioInputMode).toBe('mic');
        expect(parseStoredSettings('not-json').audioInputMode).toBe('mic');
        expect(parseStoredSettings(JSON.stringify({ audioInputMode: 'hacked' })).audioInputMode).toBe('mic');
        expect(parseStoredSettings(JSON.stringify({ audioInputMode: 'system' })).audioInputMode).toBe('system');
        expect(parseStoredSettings(JSON.stringify({ audioInputMode: 'both' })).audioInputMode).toBe('both');
    });
});
