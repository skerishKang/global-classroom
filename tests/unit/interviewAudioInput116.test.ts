import { afterEach, describe, expect, test, vi } from 'vitest';
import { captureAudioInput } from '../../utils/inputSource';
import { createSpeakerMeter } from '../../utils/speakerMeter';

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

/** 분석기마다 지정한 진폭의 정현파 대신 상수를 채우는 믹싱 컨텍스트(#116 화자 미터 검증용). */
function meterContextHarness(analyserAmplitudes: number[]) {
    const destination = { stream: {} as MediaStream, disconnect: vi.fn() };
    const sources: any[] = [];
    let analyserIndex = 0;
    const context = {
        createMediaStreamDestination: vi.fn(() => destination),
        createMediaStreamSource: vi.fn(() => {
            const source = { connect: vi.fn(), disconnect: vi.fn() };
            sources.push(source);
            return source;
        }),
        createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
        createAnalyser: vi.fn(() => {
            const value = analyserAmplitudes[analyserIndex] ?? 0;
            analyserIndex += 1;
            return {
                fftSize: 512,
                connect: vi.fn(),
                disconnect: vi.fn(),
                getFloatTimeDomainData: (buffer: Float32Array) => {
                    buffer.fill(value);
                },
            };
        }),
    } as unknown as AudioContext;
    return { context, destination, sources };
}

const INTERVIEW_MIC: MediaTrackConstraints = {
    channelCount: 1,
    sampleRate: 16000,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
};

describe('#116 interview mic constraints are preserved', () => {
    test('mic 모드에서 micConstraints 오버라이드가 그대로 getUserMedia에 간다', async () => {
        const micTrack = fakeTrack('audio');
        const devices = stubMediaDevices({ getUserMedia: vi.fn().mockResolvedValue(fakeStream([micTrack])) });

        const capture = await captureAudioInput('mic', null, { micConstraints: INTERVIEW_MIC });

        expect(devices.getUserMedia).toHaveBeenCalledWith({ audio: INTERVIEW_MIC });
        expect(devices.getDisplayMedia).not.toHaveBeenCalled();
        expect(capture.sourceLevels).toBeUndefined();
        capture.stop();
        expect(micTrack.stop).toHaveBeenCalledTimes(1);
    });

    test('오버라이드가 없으면 #114의 기본 제약을 유지한다', async () => {
        const devices = stubMediaDevices({ getUserMedia: vi.fn().mockResolvedValue(fakeStream([fakeTrack('audio')])) });

        await captureAudioInput('mic', null);

        expect(devices.getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: 1, sampleRate: 16000 } });
    });

    test('both 모드의 마이크쪽에도 micConstraints 오버라이드가 적용된다', async () => {
        const devices = stubMediaDevices({
            getUserMedia: vi.fn().mockResolvedValue(fakeStream([fakeTrack('audio')])),
            getDisplayMedia: vi.fn().mockResolvedValue(fakeStream([fakeTrack('video'), fakeTrack('audio')])),
        });
        const harness = meterContextHarness([0, 0]);

        const capture = await captureAudioInput('both', harness.context, { micConstraints: INTERVIEW_MIC });

        expect(devices.getUserMedia).toHaveBeenCalledWith({ audio: INTERVIEW_MIC });
        capture.stop();
    });

    test('오버라이드가 없는 both 모드 마이크는 #115의 기본 제약을 유지한다', async () => {
        const devices = stubMediaDevices({
            getUserMedia: vi.fn().mockResolvedValue(fakeStream([fakeTrack('audio')])),
            getDisplayMedia: vi.fn().mockResolvedValue(fakeStream([fakeTrack('video'), fakeTrack('audio')])),
        });
        const harness = meterContextHarness([0, 0]);

        await captureAudioInput('both', harness.context);

        expect(devices.getUserMedia).toHaveBeenCalledWith({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
    });
});

describe('#116 per-source level samplers', () => {
    test('both 모드만 sourceLevels를 돌려주고 순서는 [마이크, 시스템]이다', async () => {
        stubMediaDevices({
            getUserMedia: vi.fn().mockResolvedValue(fakeStream([fakeTrack('audio')])),
            getDisplayMedia: vi.fn().mockResolvedValue(fakeStream([fakeTrack('video'), fakeTrack('audio')])),
        });
        const harness = meterContextHarness([0, 0.4]);

        const capture = await captureAudioInput('both', harness.context);

        expect(capture.sourceLevels).toHaveLength(2);
        const [meLevel, counterpartLevel] = capture.sourceLevels!;
        expect(meLevel()).toBe(0);
        expect(counterpartLevel()).toBeCloseTo(0.4, 5);
        capture.stop();
    });

    test('system 모드는 믹서가 없어 sourceLevels가 없다', async () => {
        stubMediaDevices({
            getDisplayMedia: vi.fn().mockResolvedValue(fakeStream([fakeTrack('video'), fakeTrack('audio')])),
        });

        const capture = await captureAudioInput('system', meterContextHarness([0]).context);

        expect(capture.sourceLevels).toBeUndefined();
        capture.stop();
    });
});

describe('#116 speaker meter', () => {
    test('양쪽 모두 무음이면 판정하지 않는다', () => {
        const meter = createSpeakerMeter({ me: () => 0, counterpart: () => 0 });
        meter.sample();
        meter.sample();
        expect(meter.dominant()).toBeUndefined();
    });

    test('상대(시스템) 음량이 지배하면 counterpart다', () => {
        const meter = createSpeakerMeter({ me: () => 0.05, counterpart: () => 0.4 });
        meter.sample();
        meter.sample();
        expect(meter.dominant()).toBe('counterpart');
    });

    test('내(마이크) 음량이 지배하면 me다', () => {
        const meter = createSpeakerMeter({ me: () => 0.4, counterpart: () => 0.05 });
        meter.sample();
        meter.sample();
        expect(meter.dominant()).toBe('me');
    });

    test('비슷하면 판정하지 않는다(애매 표시 생략)', () => {
        const meter = createSpeakerMeter({ me: () => 0.2, counterpart: () => 0.2 });
        meter.sample();
        meter.sample();
        expect(meter.dominant()).toBeUndefined();
    });

    test('dominant 후 reset하면 다음 턴을 새로 판정한다', () => {
        let meRms = 0;
        let counterpartRms = 0.4;
        const meter = createSpeakerMeter({ me: () => meRms, counterpart: () => counterpartRms });
        meter.sample();
        meter.sample();
        expect(meter.dominant()).toBe('counterpart');

        counterpartRms = 0;
        meRms = 0.4;
        meter.reset();
        meter.sample();
        expect(meter.dominant()).toBe('me');
    });
});
