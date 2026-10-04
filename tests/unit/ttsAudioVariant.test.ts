import { describe, expect, test } from 'vitest';
import {
    buildAudioCacheKey,
    buildAudioProvenance,
    canReuseItemAudio,
    hashTtsText,
    resolveTtsVariant,
    type TtsVariantSource,
} from '../../utils/ttsAudioVariant';

const ID = 'row-1';
const VOICE = 'Kore';
const MODEL = 'gemini-2.5-flash-preview-tts';

type Item = TtsVariantSource & { audioBase64?: string };

const itemWithAudio = (provenance: string, audioBase64 = 'audio-bytes'): Item => ({
    translated: '',
    activeTarget: '',
    audioBase64,
    audioProvenance: provenance,
});

// Simulates the state of one row across user actions: the stored audio plus
// the variant currently displayed (item.translated + item.activeTarget).
const rowState = (translated: string, activeTarget: string, stored?: { provenance: string }): Item => ({
    translated,
    activeTarget,
    ...(stored ? { audioBase64: 'audio-bytes', audioProvenance: stored.provenance } : {}),
});

const request = (translated: string, activeTarget: string) => ({ translated, activeTarget });

describe('tts audio variant identity (#34)', () => {
  test('hash is stable for the same text and distinct for different text', () => {
    expect(hashTtsText('Hello')).toBe(hashTtsText('Hello'));
    // Whitespace is normalized exactly like the player normalizes before speaking.
    expect(hashTtsText('Hello   world\n')).toBe(hashTtsText('Hello world'));
    expect(hashTtsText('Hello')).not.toBe(hashTtsText('Hello there'));
    expect(hashTtsText('Hello')).not.toBe(hashTtsText('Xin chào'));
    expect(hashTtsText('')).toBe(hashTtsText('  '));
  });

  test('variant resolves the active target and the requested spoken text', () => {
    const variant = resolveTtsVariant(rowState('Xin chào', 'vi'), 'Xin chào');
    expect(variant).toEqual({ target: 'vi', text: 'Xin chào', textHash: hashTtsText('Xin chào') });

    // Single-translation (normal Global Classroom) rows have no active target.
    const normal = resolveTtsVariant(rowState('안녕하세요', ''), '안녕하세요');
    expect(normal.target).toBe('');

    // The item only supplies the target; the requested text wins over a stale copy.
    const stale = resolveTtsVariant(rowState('old text', 'en'), 'new text');
    expect(stale.text).toBe('new text');
    expect(stale.target).toBe('en');
  });

  test('cache key binds target, text hash, voice and model', () => {
    const base = resolveTtsVariant(request('Hello', 'en'), 'Hello');
    const key = buildAudioCacheKey(ID, base, VOICE, MODEL);
    expect(key).toBe(`${ID}:en:${hashTtsText('Hello')}:${VOICE}:${MODEL}`);
    expect(buildAudioProvenance(base, VOICE, MODEL)).toBe(`en:${hashTtsText('Hello')}:${VOICE}:${MODEL}`);

    expect(buildAudioCacheKey(ID, resolveTtsVariant(request('Hello', 'vi'), 'Hello'), VOICE, MODEL)).not.toBe(key);
    expect(buildAudioCacheKey(ID, resolveTtsVariant(request('Hello there', 'en'), 'Hello there'), VOICE, MODEL)).not.toBe(key);
    expect(buildAudioCacheKey(ID, base, 'Puck', MODEL)).not.toBe(key);
    expect(buildAudioCacheKey(ID, base, VOICE, 'other-tts-model')).not.toBe(key);
    expect(buildAudioCacheKey('row-2', base, VOICE, MODEL)).not.toBe(key);
  });

  test('scenario 1+4: EN audio never replays after switching to VI or after retranslation', () => {
    // EN audio was generated for "Hello" on the en variant.
    const enProvenance = buildAudioProvenance(resolveTtsVariant(request('Hello', 'en'), 'Hello'), VOICE, MODEL);
    const row = rowState('Xin chào', 'vi', { provenance: enProvenance });

    // VI tab selected: the stored EN audio must not be reused.
    const viVariant = resolveTtsVariant(row, 'Xin chào');
    expect(canReuseItemAudio(row, viVariant, VOICE, MODEL)).toBe(false);
    expect(buildAudioCacheKey(ID, viVariant, VOICE, MODEL))
      .not.toBe(buildAudioCacheKey(ID, resolveTtsVariant(request('Hello', 'en'), 'Hello'), VOICE, MODEL));

    // Same target (en) but retranslated text: new cache variant, old audio unused.
    const retranslated = rowState('Hello again', 'en', { provenance: enProvenance });
    expect(canReuseItemAudio(retranslated, resolveTtsVariant(retranslated, 'Hello again'), VOICE, MODEL)).toBe(false);
  });

  test('scenario 2: VI -> EN roundtrip reuses the exact original EN variant', () => {
    const enVariant = resolveTtsVariant(request('Hello', 'en'), 'Hello');
    const enKey = buildAudioCacheKey(ID, enVariant, VOICE, MODEL);

    // VI generation writes its own key; EN generation wrote the one above.
    const viVariant = resolveTtsVariant(request('Xin chào', 'vi'), 'Xin chào');
    const viKey = buildAudioCacheKey(ID, viVariant, VOICE, MODEL);
    expect(viKey).not.toBe(enKey);

    // Back on the EN tab the exact EN key is looked up again -> cache reuse YES.
    expect(buildAudioCacheKey(ID, enVariant, VOICE, MODEL)).toBe(enKey);
    const rowBackOnEn = rowState('Hello', 'en', { provenance: buildAudioProvenance(enVariant, VOICE, MODEL) });
    expect(canReuseItemAudio(rowBackOnEn, enVariant, VOICE, MODEL)).toBe(true);
  });

  test('scenario 3: manual edit invalidates the old text audio', () => {
    const before = resolveTtsVariant(request('Hello', 'en'), 'Hello');
    const row = rowState('Hello there', 'en', { provenance: buildAudioProvenance(before, VOICE, MODEL) });
    expect(canReuseItemAudio(row, resolveTtsVariant(row, 'Hello there'), VOICE, MODEL)).toBe(false);
  });

  test('scenario 5+6: voice and model changes never reuse the previous audio', () => {
    const variant = resolveTtsVariant(request('Hello', 'en'), 'Hello');
    const row = rowState('Hello', 'en', { provenance: buildAudioProvenance(variant, VOICE, MODEL) });

    expect(canReuseItemAudio(row, variant, 'Puck', MODEL)).toBe(false);
    expect(canReuseItemAudio(row, variant, VOICE, 'gemini-2.5-flash-tts-other')).toBe(false);
    expect(canReuseItemAudio(row, variant, VOICE, MODEL)).toBe(true);
  });

  test('scenario 7: exact variant (text + target + voice + model) reuses the cache', () => {
    const variant = resolveTtsVariant(request('Hello', 'en'), 'Hello');
    const provenance = buildAudioProvenance(variant, VOICE, MODEL);
    const row = rowState('Hello', 'en', { provenance });
    expect(canReuseItemAudio(row, variant, VOICE, MODEL)).toBe(true);

    // The variant cache hit path re-binds the same provenance to the item.
    const promoted = rowState('Hello', 'en');
    promoted.audioBase64 = 'cached-bytes';
    promoted.audioProvenance = provenance;
    expect(canReuseItemAudio(promoted, variant, VOICE, MODEL)).toBe(true);
  });

  test('legacy cache entries and provenance-less audio are never reused', () => {
    // Legacy IndexedDB keys were `<id>:<voice>:<model>`: no target, no text
    // hash. The new key shape can never collide with them.
    const variant = resolveTtsVariant(request('Hello', 'en'), 'Hello');
    const legacyKey = `${ID}:${VOICE}:${MODEL}`;
    expect(buildAudioCacheKey(ID, variant, VOICE, MODEL)).not.toBe(legacyKey);
    expect(buildAudioCacheKey(ID, variant, VOICE, MODEL).split(':').length).toBe(5);

    // Audio without provenance (older versions, Drive restore) is not trusted.
    const restoredItem: Item = { translated: 'Hello', activeTarget: 'en', audioBase64: 'restored' };
    expect(canReuseItemAudio(restoredItem, variant, VOICE, MODEL)).toBe(false);
    expect(canReuseItemAudio(null, variant, VOICE, MODEL)).toBe(false);
    expect(canReuseItemAudio(itemWithAudio(''), variant, VOICE, MODEL)).toBe(false);
  });
});
