import { describe, expect, it } from 'vitest';
import {
  InterviewTranslationSessions,
  type TranslationMedia,
  type TranslationSessionHandle,
  type TranslationSessionRequest,
} from '../../utils/interviewTranslationSessions';

const TARGETS = ['en', 'ko'] as const;

function encodeAudio(value: string): TranslationMedia {
  return {
    data: Buffer.from(value, 'utf8').toString('base64'),
    mimeType: 'audio/pcm;rate=16000',
  };
}

function decodeAudio(media: TranslationMedia): string {
  return Buffer.from(media.data, 'base64').toString('utf8');
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Mock of the Live Translate service. A Live session keeps one conversation
 * history for its whole life and translates everything it has heard, so the
 * output of a session that spans several utterances necessarily contains the
 * earlier ones. The mock reproduces exactly that: its "translation" is
 * `T[<every audio chunk this connection ever received>]`.
 *
 * That makes the production defect observable from the outside: reusing one
 * session across utterances bleeds utterance 1 into utterance 2's output, while
 * a session per utterance cannot.
 */
class MockTranslateConnection {
  context = '';
  closed = false;
  audioStreamEnds = 0;
  /** Real servers can take a while to finalise after audioStreamEnd. */
  autoFinalizeOnStreamEnd = true;
  handle: TranslationSessionHandle;

  constructor(
    readonly request: TranslationSessionRequest,
    private readonly server: MockLiveTranslateServer,
  ) {
    this.handle = {
      sendRealtimeInput: (input) => {
        if (input.media) this.context += decodeAudio(input.media);
        if (input.audioStreamEnd) {
          this.audioStreamEnds += 1;
          if (this.autoFinalizeOnStreamEnd) this.finalizeTurn();
        }
      },
      close: () => {
        this.closed = true;
      },
    };
    this.server.connections.push(this);
  }

  /** The "model" output for this session: everything it has heard so far. */
  translation(): string {
    return `T[${this.context}]`;
  }

  finalizeTurn(): void {
    this.request.onChunk(this.translation(), true);
  }
}

class MockLiveTranslateServer {
  readonly connections: MockTranslateConnection[] = [];
  connectCount = 0;

  connect = (request: TranslationSessionRequest): Promise<TranslationSessionHandle> => {
    this.connectCount += 1;
    return Promise.resolve(new MockTranslateConnection(request, this).handle);
  };

  /**
   * The session that heard the given audio, regardless of whether it has since
   * been closed — retired sessions must stay addressable for stale tests.
   */
  sessionThatHeard(text: string, target?: string): MockTranslateConnection {
    const connection = this.connections
      .filter((entry) => entry.context.includes(text))
      .filter((entry) => !target || entry.request.target === target)
      .pop();
    if (!connection) throw new Error(`no session heard "${text}"${target ? ` for ${target}` : ''}`);
    return connection;
  }

  /** The nth connection opened for a target, in creation order. */
  sessionFor(target: string, nth = 0): MockTranslateConnection {
    const connection = this.connections
      .filter((entry) => entry.request.target === target)[nth];
    if (!connection) throw new Error(`no session #${nth} for ${target}`);
    return connection;
  }
}

type Harness = {
  server: MockLiveTranslateServer;
  coordinator: InterviewTranslationSessions;
  started: string[];
  previews: Array<{ utteranceId: string; target: string; text: string }>;
  finals: Array<{ utteranceId: string; target: string; text: string }>;
};

async function makeCoordinator(
  overrides: Partial<ConstructorParameters<typeof InterviewTranslationSessions>[0]> = {},
): Promise<Harness> {
  const server = new MockLiveTranslateServer();
  const harness: Harness = {
    server,
    coordinator: null as unknown as InterviewTranslationSessions,
    started: [],
    previews: [],
    finals: [],
  };

  harness.coordinator = new InterviewTranslationSessions({
    targets: TARGETS,
    connect: server.connect,
    onUtteranceStart: (utteranceId) => harness.started.push(utteranceId),
    onPreview: (utteranceId, target, text) => harness.previews.push({ utteranceId, target, text }),
    onFinal: (utteranceId, target, text) => harness.finals.push({ utteranceId, target, text }),
    drainTimeoutMs: 20,
    forgetAfterMs: 60_000,
    ...overrides,
  });

  await harness.coordinator.start();
  await flush();
  return harness;
}

/**
 * One utterance, the way the production hook runs it: audio goes to the active
 * sessions, the session streams a partial translation, then the transcript
 * final closes the context boundary.
 */
async function speak(harness: Harness, utteranceText: string): Promise<string> {
  harness.coordinator.feedAudio(encodeAudio(utteranceText));

  const connection = harness.server.sessionThatHeard(utteranceText);
  connection.request.onChunk(connection.translation(), false);
  await flush();

  const finished = harness.coordinator.rotate();
  await flush();
  return finished ?? '';
}

function finalFor(harness: Harness, utteranceId: string, target: string): string {
  return harness.finals
    .filter((entry) => entry.utteranceId === utteranceId && entry.target === target)
    .map((entry) => entry.text)
    .join(' | ');
}

describe('InterviewTranslationSessions', () => {
  it('keeps each utterance translation free of every earlier utterance', async () => {
    const harness = await makeCoordinator();

    const u1 = await speak(harness, 'Apple is red.');
    const u2 = await speak(harness, 'Kubernetes runs containers.');
    const u3 = await speak(harness, 'Neon stores data.');

    expect(finalFor(harness, u1, 'en')).toBe('T[Apple is red.]');
    expect(finalFor(harness, u2, 'en')).toBe('T[Kubernetes runs containers.]');
    expect(finalFor(harness, u3, 'en')).toBe('T[Neon stores data.]');

    // The defect under test: utterance N's translation containing utterance N-1.
    expect(finalFor(harness, u2, 'en')).not.toContain('Apple');
    expect(finalFor(harness, u3, 'en')).not.toContain('Apple');
    expect(finalFor(harness, u3, 'en')).not.toContain('Kubernetes');
  });

  it('emits a live preview for the open utterance that never repeats an earlier one', async () => {
    const harness = await makeCoordinator();

    await speak(harness, 'Apple is red.');
    const u2 = await speak(harness, 'Kubernetes runs containers.');

    const previews = harness.previews.filter((entry) => entry.utteranceId === u2);
    expect(previews.length).toBeGreaterThan(0);
    for (const preview of previews) {
      expect(preview.text).not.toContain('Apple');
    }
  });

  it('prewarms a standby session per target and promotes it on rotation', async () => {
    const harness = await makeCoordinator({ prewarm: true });

    // 2 active + 2 standby.
    expect(harness.server.connectCount).toBe(TARGETS.length * 2);

    await speak(harness, 'Apple is red.');

    // The promoted standby carried the next utterance, and one new standby per
    // target was opened for the utterance after that.
    expect(harness.server.connectCount).toBe(TARGETS.length * 2 + TARGETS.length);
  });

  it('still isolates utterances when prewarm is disabled', async () => {
    const harness = await makeCoordinator({ prewarm: false });

    expect(harness.server.connectCount).toBe(TARGETS.length);
    const u1 = await speak(harness, 'Apple is red.');
    const u2 = await speak(harness, 'Kubernetes runs containers.');

    expect(finalFor(harness, u1, 'en')).toBe('T[Apple is red.]');
    expect(finalFor(harness, u2, 'en')).toBe('T[Kubernetes runs containers.]');
    expect(finalFor(harness, u2, 'en')).not.toContain('Apple');
  });

  it('maps a delayed completion to its own row after later utterances exist', async () => {
    const harness = await makeCoordinator();

    // Utterance 1's session is slow to finalise, so its translation has not
    // landed when the transcript boundary already opened utterance 2.
    const slowSession = harness.server.sessionFor('en');
    slowSession.autoFinalizeOnStreamEnd = false;

    const u1 = await speak(harness, 'Apple is red.');
    expect(finalFor(harness, u1, 'en')).toBe('');

    const u2 = await speak(harness, 'Kubernetes runs containers.');
    slowSession.request.onChunk('T[Apple is red.] (late)', true);
    await flush();

    expect(finalFor(harness, u1, 'en')).toContain('(late)');
    expect(finalFor(harness, u2, 'en')).not.toContain('late');
    expect(finalFor(harness, u2, 'en')).not.toContain('Apple');
  });

  it('lets a retired session finish its own utterance but never a newer one', async () => {
    const harness = await makeCoordinator();

    const u1 = await speak(harness, 'Apple is red.');
    const u2 = await speak(harness, 'Kubernetes runs containers.');

    const retired = harness.server.sessionThatHeard('Apple is red.', 'en');
    const eventsBefore = harness.finals.length;
    retired.finalizeTurn();
    await flush();

    const newFinals = harness.finals.slice(eventsBefore);
    expect(newFinals.every((entry) => entry.utteranceId === u1)).toBe(true);
    expect(newFinals.every((entry) => entry.utteranceId !== u2)).toBe(true);
  });

  it('makes every outstanding callback inert after mic stop', async () => {
    const harness = await makeCoordinator();

    const u1 = await speak(harness, 'Apple is red.');
    harness.coordinator.stop();
    await flush();

    const eventsBefore = harness.previews.length + harness.finals.length;
    harness.server.sessionThatHeard('Apple is red.', 'en').request.onChunk('after stop', true);
    await flush();

    expect(harness.previews.length + harness.finals.length).toBe(eventsBefore);
    expect(finalFor(harness, u1, 'en')).not.toContain('after stop');
  });

  it('forgets a finished utterance after the bounded window', async () => {
    const harness = await makeCoordinator({ forgetAfterMs: 10 });

    const u1 = await speak(harness, 'Apple is red.');
    expect(finalFor(harness, u1, 'en')).toBe('T[Apple is red.]');

    await new Promise((resolve) => setTimeout(resolve, 60));
    const retired = harness.server.sessionThatHeard('Apple is red.', 'en');
    retired.request.onChunk('T[Apple is red.] (too late)', true);
    await flush();

    expect(finalFor(harness, u1, 'en')).not.toContain('too late');
  });

  it('starts a clean translation context after mic stop and restart', async () => {
    const first = await makeCoordinator();
    const u1 = await speak(first, 'Apple is red.');
    first.coordinator.stop();

    const second = await makeCoordinator();
    expect(second.started).toHaveLength(1);
    expect(second.started[0]).not.toBe(u1);

    const u2 = await speak(second, 'Kubernetes runs containers.');
    expect(finalFor(second, u2, 'en')).toBe('T[Kubernetes runs containers.]');
    expect(finalFor(second, u2, 'en')).not.toContain('Apple');
  });

  it('routes rapid utterances 1/2/3 without mixing them', async () => {
    const harness = await makeCoordinator();

    const u1 = await speak(harness, 'One.');
    const u2 = await speak(harness, 'Two.');
    const u3 = await speak(harness, 'Three.');

    expect(finalFor(harness, u1, 'en')).toBe('T[One.]');
    expect(finalFor(harness, u2, 'en')).toBe('T[Two.]');
    expect(finalFor(harness, u3, 'en')).toBe('T[Three.]');
    expect(finalFor(harness, u3, 'en')).not.toContain('One');
    expect(finalFor(harness, u3, 'en')).not.toContain('Two');
  });

  it('keeps both target languages isolated per utterance', async () => {
    const harness = await makeCoordinator();

    const u1 = await speak(harness, 'Apple is red.');
    const u2 = await speak(harness, '사과는 빨갛습니다.');

    expect(finalFor(harness, u1, 'ko')).toBe('T[Apple is red.]');
    expect(finalFor(harness, u2, 'ko')).toBe('T[사과는 빨갛습니다.]');
    expect(finalFor(harness, u2, 'ko')).not.toContain('Apple');
  });

  it('keeps attribution when the spoken language switches between utterances', async () => {
    const harness = await makeCoordinator();

    const u1 = await speak(harness, 'Apple is red.');
    const u2 = await speak(harness, '사과는 빨갛습니다.');

    // Both targets hear every utterance; neither may leak the other's content.
    expect(finalFor(harness, u1, 'en')).not.toContain('사과');
    expect(finalFor(harness, u2, 'en')).not.toContain('Apple');
    expect(finalFor(harness, u2, 'ko')).not.toContain('Apple');
  });

  it('clears pending state so nothing is routed or delivered after stop', async () => {
    const harness = await makeCoordinator();
    await speak(harness, 'Apple is red.');

    harness.coordinator.stop();
    const eventsBefore = harness.previews.length + harness.finals.length;

    // Audio and boundaries after stop are inert: no session is open to hear them.
    harness.coordinator.feedAudio(encodeAudio('Ghost utterance.'));
    harness.coordinator.rotate();
    await flush();

    expect(harness.previews.length + harness.finals.length).toBe(eventsBefore);
  });

  it('never rewrites the source transcript text', async () => {
    const harness = await makeCoordinator();

    const source = 'Apple is red.';
    const u1 = await speak(harness, source);

    // Every emitted translation is the mock model's rendering of what the
    // session heard; the coordinator has no path that mutates source text.
    const finals = harness.finals.filter((entry) => entry.utteranceId === u1);
    expect(finals.length).toBeGreaterThan(0);
    for (const entry of finals) {
      expect(entry.text).toBe(`T[${source}]`);
      expect(entry.text).not.toBe(source);
    }
  });
});
