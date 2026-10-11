import { afterEach, describe, expect, test, vi } from 'vitest';
import { startInterviewAudioCapture } from '../../utils/interviewAudioCapture';

afterEach(() => vi.unstubAllGlobals());

function contextHarness(workletSupported: boolean) {
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const mute = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const legacy = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null as any };
  const context = {
    createMediaStreamSource: vi.fn(() => source),
    createGain: vi.fn(() => mute),
    createScriptProcessor: vi.fn(() => legacy),
    destination: {},
    audioWorklet: workletSupported ? { addModule: vi.fn().mockResolvedValue(undefined) } : undefined,
  } as unknown as AudioContext;
  return { source, mute, legacy, context };
}

describe('#87 long-session audio capture', () => {
  test('prefers AudioWorklet, transfers PCM to callback and releases all nodes', async () => {
    const workletPort = { onmessage: null as null | ((event: any) => void), postMessage: vi.fn() };
    const node = { port: workletPort, connect: vi.fn(), disconnect: vi.fn() };
    const ctor = vi.fn().mockImplementation(function () { return node; });
    vi.stubGlobal('AudioWorkletNode', ctor);
    const h = contextHarness(true);
    const onPcm = vi.fn();
    const capture = await startInterviewAudioCapture(h.context, {} as MediaStream, onPcm);
    expect(capture.mode).toBe('worklet');
    expect(h.context.audioWorklet!.addModule).toHaveBeenCalledWith('/worklets/interview-pcm-processor.js');
    expect(ctor).toHaveBeenCalledWith(h.context, 'interview-pcm-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    expect(h.context.createScriptProcessor).not.toHaveBeenCalled();
    const pcm = new Int16Array([123, -456]).buffer;
    workletPort.onmessage!({ data: pcm });
    expect(onPcm).toHaveBeenCalledWith(pcm);
    capture.stop();
    expect(workletPort.onmessage).toBeNull();
    expect(workletPort.postMessage).toHaveBeenCalledWith('stop');
    expect(h.source.disconnect).toHaveBeenCalled();
    expect(node.disconnect).toHaveBeenCalled();
    expect(h.mute.disconnect).toHaveBeenCalled();
  });

  test('legacy fallback works when AudioWorklet is missing', async () => {
    vi.stubGlobal('AudioWorkletNode', undefined);
    const h = contextHarness(false);
    const onPcm = vi.fn();
    const capture = await startInterviewAudioCapture(h.context, {} as MediaStream, onPcm);
    expect(capture.mode).toBe('legacy');
    expect(h.context.createScriptProcessor).toHaveBeenCalledWith(2048, 1, 1);
    h.legacy.onaudioprocess({
      inputBuffer: { getChannelData: () => new Float32Array([0, 0.5, -0.5, 1, -1]) },
    });
    const samples = new Int16Array(onPcm.mock.calls[0][0]);
    expect([...samples]).toEqual([0, 16383, -16384, 32767, -32768]);
    capture.stop();
    expect(h.legacy.onaudioprocess).toBeNull();
    expect(h.source.disconnect).toHaveBeenCalled();
    expect(h.legacy.disconnect).toHaveBeenCalled();
  });

  test('module load failure falls back without aborting microphone', async () => {
    vi.stubGlobal('AudioWorkletNode', vi.fn());
    const h = contextHarness(true);
    vi.mocked(h.context.audioWorklet!.addModule).mockRejectedValueOnce(new Error('offline'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const capture = await startInterviewAudioCapture(h.context, {} as MediaStream, vi.fn());
    expect(capture.mode).toBe('legacy');
    expect(warning).toHaveBeenCalled();
    capture.stop();
    warning.mockRestore();
  });
});
