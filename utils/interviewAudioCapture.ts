/** AudioWorklet captures mic audio on the render thread, avoiding main-thread
 * ScriptProcessor callbacks during long React histories and localStorage saves. */
export type InterviewAudioCapture = {
  mode: 'worklet' | 'legacy';
  stop: () => void;
};

export async function startInterviewAudioCapture(
  context: AudioContext,
  stream: MediaStream,
  onPcm: (buffer: ArrayBuffer) => void,
): Promise<InterviewAudioCapture> {
  if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    try {
      await context.audioWorklet.addModule('/worklets/interview-pcm-processor.js');
      const source = context.createMediaStreamSource(stream);
      const processor = new AudioWorkletNode(context, 'interview-pcm-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      });
      const mute = context.createGain();
      mute.gain.value = 0;
      processor.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (event.data instanceof ArrayBuffer) onPcm(event.data);
      };
      source.connect(processor);
      processor.connect(mute);
      mute.connect(context.destination);
      return {
        mode: 'worklet',
        stop: () => {
          processor.port.onmessage = null;
          processor.port.postMessage('stop');
          source.disconnect();
          processor.disconnect();
          mute.disconnect();
        },
      };
    } catch (error) {
      console.warn('AudioWorklet unavailable, using legacy capture:', error);
    }
  }

  const source = context.createMediaStreamSource(stream);
  const legacy = context.createScriptProcessor(2048, 1, 1);
  const mute = context.createGain();
  mute.gain.value = 0;
  legacy.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const v = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    onPcm(pcm.buffer);
  };
  source.connect(legacy);
  legacy.connect(mute);
  mute.connect(context.destination);
  return {
    mode: 'legacy',
    stop: () => {
      legacy.onaudioprocess = null;
      source.disconnect();
      legacy.disconnect();
      mute.disconnect();
    },
  };
}
