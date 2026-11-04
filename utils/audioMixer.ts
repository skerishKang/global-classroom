/**
 * Utility to merge multiple audio blobs into a single audio file.
 */

/**
 * Merges multiple WebM/Ogg/WAV blobs into a single WAV blob using Web Audio API.
 * Note: Browser MediaRecorder usually produces WebM or Ogg. 
 * For simplicity and broad compatibility, this mixer decodes them and creates a single PCM WAV.
 */
export async function mergeAudioBlobs(blobs: Blob[]): Promise<Blob> {
    if (blobs.length === 0) {
        throw new Error('No audio blobs to merge');
    }

    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();

    // Decode all blobs into AudioBuffers
    const audioBuffers: AudioBuffer[] = await Promise.all(
        blobs.map(async (blob) => {
            const arrayBuffer = await blob.arrayBuffer();
            return await audioCtx.decodeAudioData(arrayBuffer);
        })
    );

    // Calculate total length
    const totalLength = audioBuffers.reduce((acc, buf) => acc + buf.length, 0);
    const numberOfChannels = audioBuffers[0].numberOfChannels;
    const sampleRate = audioBuffers[0].sampleRate;

    // Create a new buffer for the merged audio
    const mergedBuffer = audioCtx.createBuffer(numberOfChannels, totalLength, sampleRate);

    // Copy data from each buffer into the merged buffer
    let offset = 0;
    for (const buffer of audioBuffers) {
        for (let channel = 0; channel < numberOfChannels; channel++) {
            mergedBuffer.getChannelData(channel).set(buffer.getChannelData(channel), offset);
        }
        offset += buffer.length;
    }

    // Convert merged AudioBuffer to WAV Blob
    return audioBufferToWav(mergedBuffer);
}

/**
 * Encodes AudioBuffer into a WAV formatted Blob.
 */
function audioBufferToWav(buffer: AudioBuffer): Blob {
    const numberOfChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;

    let result: Int16Array;

    if (numberOfChannels === 2) {
        result = interleave(buffer.getChannelData(0), buffer.getChannelData(1));
    } else {
        result = floatTo16BitPCM(buffer.getChannelData(0));
    }

    const header = new ArrayBuffer(44);
    const view = new DataView(header);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + result.length * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numberOfChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numberOfChannels * 2, true);
    view.setUint16(32, numberOfChannels * 2, true);
    view.setUint16(34, bitDepth, true);
    writeString(view, 36, 'data');
    view.setUint32(40, result.length * 2, true);

    const container = new Uint8Array(header.byteLength + result.byteLength);
    container.set(new Uint8Array(header), 0);
    container.set(new Uint8Array(result.buffer), header.byteLength);

    return new Blob([container], { type: 'audio/wav' });
}

function interleave(inputL: Float32Array, inputR: Float32Array): Int16Array {
    const length = inputL.length + inputR.length;
    const result = new Int16Array(length);

    let index = 0;
    let inputIndex = 0;

    while (index < length) {
        result[index++] = Math.max(-1, Math.min(1, inputL[inputIndex])) * 0x7FFF;
        result[index++] = Math.max(-1, Math.min(1, inputR[inputIndex])) * 0x7FFF;
        inputIndex++;
    }
    return result;
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
    const result = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        result[i] = Math.max(-1, Math.min(1, input[i])) * 0x7FFF;
    }
    return result;
}

function writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

/**
 * Realtime input mixer (#114): sums live input streams (mic + screen-share
 * audio) into one stream so a single 16 kHz mono transcription pipeline can
 * consume them all. Per-source gain 0.5 keeps a two-source sum from clipping.
 *
 * `sourceLevels`(#116)는 소스별 RMS 샘플러를 돌려준다. 각 소스에 AnalyserNode를
 * 병렬로 태워 게인 이전의 원래 음량을 본다 — 턴 단위 화자 표시(나/상대)가 쓴다.
 */
export interface LiveMixHandle {
    stream: MediaStream;
    /** 소스 순서와 같은 인덱스의 RMS(0..1) 샘플러. */
    sourceLevels: Array<() => number>;
    disconnect: () => void;
}

export function createLiveMixStream(context: AudioContext, streams: MediaStream[]): LiveMixHandle {
    const destination = context.createMediaStreamDestination();
    const sources: MediaStreamAudioSourceNode[] = [];
    const gains: GainNode[] = [];
    const analysers: AnalyserNode[] = [];

    for (const stream of streams) {
        const source = context.createMediaStreamSource(stream);
        const gain = context.createGain();
        gain.gain.value = 0.5;
        // 'explicit' 모노 강제: 스테레오 시스템 오디오도 모노로 내려 합산한다.
        gain.channelCount = 1;
        gain.channelCountMode = 'explicit';
        source.connect(gain);
        gain.connect(destination);

        // 게인 이전 원 신호를 태워 소스별 음량을 잰다.
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        analysers.push(analyser);

        sources.push(source);
        gains.push(gain);
    }

    const levelBuffer = new Float32Array(512);
    const sourceLevels = analysers.map((analyser) => () => {
        analyser.getFloatTimeDomainData(levelBuffer);
        let sum = 0;
        for (let i = 0; i < levelBuffer.length; i += 1) {
            sum += levelBuffer[i] * levelBuffer[i];
        }
        return Math.sqrt(sum / levelBuffer.length);
    });

    return {
        stream: destination.stream,
        sourceLevels,
        disconnect: () => {
            sources.forEach((source) => source.disconnect());
            gains.forEach((gain) => gain.disconnect());
            analysers.forEach((analyser) => analyser.disconnect());
            destination.disconnect();
        },
    };
}
