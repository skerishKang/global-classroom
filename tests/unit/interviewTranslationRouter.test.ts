import { describe, expect, it } from 'vitest';
import { InterviewTranslationRouter } from '../../utils/interviewTranslationRouter';

const TARGETS = ['en', 'ko'] as const;

function text(chunk: string) {
  return chunk;
}

describe('InterviewTranslationRouter', () => {
  it('routes output to the utterance it was produced for', () => {
    const events: string[] = [];
    const router = new InterviewTranslationRouter((event) => events.push(`${event.kind}:${event.utteranceId}:${event.target}`));

    router.open('u1', 1, TARGETS);
    expect(router.deliver({ utteranceId: 'u1', generation: 1, target: 'en', text: text('T1'), isFinal: false })).toBe(true);
    expect(router.deliver({ utteranceId: 'u1', generation: 1, target: 'en', text: text('T1 final'), isFinal: true })).toBe(true);

    expect(events).toEqual(['preview:u1:en', 'final:u1:en']);
    expect(router.previewText('u1', 'en')).toBe('');
    expect(router.isTargetFinal('u1', 'en')).toBe(true);
  });

  it('drops output from a forgotten utterance', () => {
    const events: string[] = [];
    const router = new InterviewTranslationRouter((event) => events.push(event.kind));

    router.open('u1', 1, TARGETS);
    router.forget('u1');
    expect(router.deliver({ utteranceId: 'u1', generation: 1, target: 'en', text: 'late', isFinal: true })).toBe(false);
    expect(events).toEqual([]);
  });

  it('drops output whose generation no longer matches (stale-generation guard)', () => {
    const events: string[] = [];
    const router = new InterviewTranslationRouter((event) => events.push(event.kind));

    router.open('u1', 1, TARGETS);
    router.open('u2', 2, TARGETS);
    // A session opened for generation 1 must not write into generation 2.
    expect(router.deliver({ utteranceId: 'u2', generation: 1, target: 'en', text: 'stale', isFinal: false })).toBe(false);
    expect(router.deliver({ utteranceId: 'u2', generation: 2, target: 'en', text: 'fresh', isFinal: false })).toBe(true);
    expect(events).toEqual(['preview']);
  });

  it('drops output for a target the utterance never asked for', () => {
    const events: string[] = [];
    const router = new InterviewTranslationRouter((event) => events.push(event.kind));

    router.open('u1', 1, ['en']);
    expect(router.deliver({ utteranceId: 'u1', generation: 1, target: 'ko', text: 'wrong', isFinal: false })).toBe(false);
    expect(events).toEqual([]);
  });

  it('never regresses a target back to preview after its final landed', () => {
    const events: string[] = [];
    const router = new InterviewTranslationRouter((event) => events.push(event.kind));

    router.open('u1', 1, TARGETS);
    router.deliver({ utteranceId: 'u1', generation: 1, target: 'en', text: 'final text', isFinal: true });
    expect(router.deliver({ utteranceId: 'u1', generation: 1, target: 'en', text: 'older preview', isFinal: false })).toBe(false);
    expect(router.deliver({ utteranceId: 'u1', generation: 1, target: 'en', text: 'second final', isFinal: true })).toBe(false);
    expect(events).toEqual(['final']);
  });

  it('closeActive stops routing new audio but keeps the slot writable for late output', () => {
    const events: string[] = [];
    const router = new InterviewTranslationRouter((event) => events.push(event.kind));

    router.open('u1', 1, TARGETS);
    expect(router.closeActive()).toBe('u1');
    expect(router.active).toBeNull();

    router.open('u2', 2, TARGETS);
    expect(router.deliver({ utteranceId: 'u1', generation: 1, target: 'en', text: 'late final', isFinal: true })).toBe(true);
    expect(router.deliver({ utteranceId: 'u2', generation: 2, target: 'en', text: 'u2 preview', isFinal: false })).toBe(true);
    expect(events).toEqual(['final', 'preview']);
  });

  it('invalidate drops every slot so outstanding callbacks become inert', () => {
    const events: string[] = [];
    const router = new InterviewTranslationRouter((event) => events.push(event.kind));

    router.open('u1', 1, TARGETS);
    router.open('u2', 2, TARGETS);
    router.invalidate();

    expect(router.deliver({ utteranceId: 'u1', generation: 1, target: 'en', text: 'x', isFinal: false })).toBe(false);
    expect(router.deliver({ utteranceId: 'u2', generation: 2, target: 'ko', text: 'x', isFinal: true })).toBe(false);
    expect(router.active).toBeNull();
    expect(events).toEqual([]);
  });

  it('an empty final still settles the target without emitting text', () => {
    const events: string[] = [];
    const router = new InterviewTranslationRouter((event) => events.push(event.kind));

    router.open('u1', 1, TARGETS);
    expect(router.deliver({ utteranceId: 'u1', generation: 1, target: 'en', text: '   ', isFinal: true })).toBe(true);
    expect(events).toEqual([]);
    expect(router.isTargetFinal('u1', 'en')).toBe(true);
  });
});
