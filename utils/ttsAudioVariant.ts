/**
 * TTS audio variant identity for Global Classroom (#34).
 *
 * Since #23 a ConversationItem can hold several translation variants, and the
 * displayed one is `item.translated` with `item.activeTarget` naming which
 * variant is active. A TTS result depends on exactly four inputs — the spoken
 * text, the target/variant, the voice and the TTS model — so an audio cache
 * entry may only be reused when all four match. Before #34 the cache key was
 * `<itemId>:<voice>:<model>`, which let an EN audio replay under the VI tab
 * and a stale audio replay after edits/retranslation.
 *
 * This module is pure and dependency-free so the exact policy the player runs
 * can be unit-tested in Node and executed in the browser unchanged.
 */

export interface TtsVariant {
  /** Active target language code ('' for the single-translation items). */
  target: string;
  /** Exact text the TTS will speak (normalized the same way as playback). */
  text: string;
  /** Stable hash of `text`, used inside cache keys and provenance. */
  textHash: string;
}

export interface AudioProvenanceParts {
  target: string;
  textHash: string;
  voice: string;
  model: string;
}

/** Minimal shape of ConversationItem the variant helpers need. */
export interface TtsVariantSource {
  translated?: string;
  activeTarget?: string;
  audioProvenance?: string;
}

/** Same normalization the player applies before speaking/segmenting. */
export function normalizeTtsText(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Stable, deterministic full-content hash (FNV-1a 32-bit over UTF-16 code
 * units, length-prefixed). Not cryptographic — it only has to tell different
 * spoken texts apart, which a plain length/prefix scheme could not.
 */
export function hashTtsText(text: string): string {
  const normalized = normalizeTtsText(text);
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${normalized.length.toString(36)}-${hash.toString(36)}`;
}

/**
 * The authoritative TTS variant for one playback request.
 *
 * `requestedText` is the text the caller is about to speak — every call site
 * passes exactly the text the UI displays (`item.translated`), and programmatic
 * callers pass the text they just stored, so the spoken text and the displayed
 * text always share one source of truth. The target comes from the item's
 * active translation variant. `item.translated` is only a fallback for callers
 * that pass no text.
 */
export function resolveTtsVariant(
  item: TtsVariantSource | null | undefined,
  requestedText?: string,
): TtsVariant {
  const text = normalizeTtsText(
    requestedText !== undefined && requestedText !== '' ? requestedText : item?.translated || '',
  );
  const target = String(item?.activeTarget || '').trim();
  return { target, text, textHash: hashTtsText(text) };
}

/** What an audio blob on an item (or in the variant cache) was produced for. */
export function buildAudioProvenance(variant: TtsVariant, voice: string, model: string): string {
  return `${variant.target}:${variant.textHash}:${voice}:${model}`;
}

/**
 * IndexedDB cache key of one audio variant:
 * `<itemId>:<target>:<textHash>:<voice>:<model>`.
 *
 * Legacy entries used `<itemId>:<voice>:<model>` (3 segments, no target and
 * no text hash) and can therefore never collide with this shape; they are
 * simply never looked up again.
 */
export function buildAudioCacheKey(
  itemId: string,
  variant: TtsVariant,
  voice: string,
  model: string,
): string {
  return `${itemId}:${buildAudioProvenance(variant, voice, model)}`;
}

/**
 * Whether an item's in-memory `audioBase64` may be replayed right now. It is
 * only trusted when its recorded provenance proves it was generated for the
 * exact (target, text, voice, model) being requested — audio restored from
 * Drive or saved by older versions carries no provenance and is never reused.
 */
export function canReuseItemAudio(
  item: TtsVariantSource | null | undefined,
  variant: TtsVariant,
  voice: string,
  model: string,
): boolean {
  const candidate = item as (TtsVariantSource & { audioBase64?: string }) | null | undefined;
  if (!candidate || !candidate.audioBase64) return false;
  return candidate.audioProvenance === buildAudioProvenance(variant, voice, model);
}
