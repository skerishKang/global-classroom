import { describe, expect, test } from 'vitest';
import type { ConversationSession } from '../../types';
import {
  sessionPreviewTitle, needsSessionMetadata, makeSessionMetadataInput,
  normalizeSessionMetadata, MAX_SESSION_METADATA_CHARS,
} from '../../utils/sessionMetadata';
import { parseSessionMetadata, SESSION_METADATA_MODELS } from '../../netlify/functions/session-metadata';

const item = (index: number, original: string) => ({
  id: String(index), original, translated: '', isTranslating: false, timestamp: index,
});
const session = (items: ReturnType<typeof item>[], title = '새 대화', summary?: string): ConversationSession => ({
  id: 'old', createdAt: 1, updatedAt: 2, title, summary, items,
});

describe('#76 saved-session title and summary contracts', () => {
  test('Gemma 31B is first, 26B A4B is only the fallback', () => {
    expect(SESSION_METADATA_MODELS).toEqual(['gemma-4-31b-it', 'gemma-4-26b-a4b-it', 'gemini-2.5-flash-lite']);
  });
  test('all nonempty unsummarized sessions are eligible, including prior saved records', () => {
    expect(needsSessionMetadata(session([item(1, 'Mercor certification details')]))).toBe(true);
    expect(needsSessionMetadata(session([item(1, '  ') ]))).toBe(false);
    expect(needsSessionMetadata(session([item(1, 'conversation')], 'title', 'Already indexed'))).toBe(false);
  });
  test('placeholder never masks a meaningful provisional transcript title', () => {
    expect(sessionPreviewTitle(session([item(1, 'What are your strengths?')]))).toBe('What are your strengths?');
    expect(sessionPreviewTitle(session([item(1, '')]))).toBe('새 대화');
    expect(sessionPreviewTitle(session([item(1, 'questions')], 'AI-indexed title'))).toBe('AI-indexed title');
  });
  test('long transcripts remain bounded and preserve first and last turns', () => {
    const turns = Array.from({ length: 310 }, (_, index) => item(index, `Turn-${index} ` + 'context '.repeat(90)));
    const input = makeSessionMetadataInput(turns);
    expect(input.length).toBeLessThanOrEqual(MAX_SESSION_METADATA_CHARS);
    expect(input).toContain('Turn-0');
    expect(input).toContain('Turn-309');
    expect(turns).toHaveLength(310);
  });
  test('requires both meaningful title and summary, clips oversized model strings', () => {
    expect(normalizeSessionMetadata({ title: ' ', summary: 'details' })).toBeNull();
    expect(normalizeSessionMetadata({ title: '새 대화', summary: 'details' })).toBeNull();
    expect(normalizeSessionMetadata({ title: '  interview   topic ', summary: ' summary   text ' }))
      .toEqual({ title: 'interview topic', summary: 'summary text' });
  });
  test('parses strict JSON and safe fenced JSON, rejects malformed output', () => {
    expect(parseSessionMetadata('{"title":"Tech interview","summary":"Discussed Kotlin."}'))
      .toEqual({ title: 'Tech interview', summary: 'Discussed Kotlin.' });
    expect(parseSessionMetadata('some text')).toBeNull();
    expect(parseSessionMetadata('{"title":"Only title"}')).toBeNull();
  });
});
