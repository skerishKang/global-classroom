import type { ConversationItem, ConversationSession } from '../types';

export const MAX_SESSION_METADATA_CHARS = 40_000;
export const DEFAULT_SESSION_TITLE = '새 대화';

/** This is a display fallback, never a replacement for the underlying transcript. */
export function sessionPreviewTitle(session: Pick<ConversationSession, 'title' | 'items'>): string {
  const stored = String(session.title || '').trim();
  if (stored && stored !== DEFAULT_SESSION_TITLE) return stored;
  const first = (session.items || []).find((item) => String(item.original || '').trim());
  return String(first?.original || '').replace(/\s+/g, ' ').trim().slice(0, 54) || DEFAULT_SESSION_TITLE;
}

export function needsSessionMetadata(session: ConversationSession): boolean {
  return !String(session.summary || '').trim() &&
    (session.items || []).some((item) => Boolean(String(item.original || '').trim()));
}

/**
 * Bound the per-session request even when there are hundreds of utterances.
 * Keep the first and last turns, then evenly sample middle turns. No stored
 * transcript is modified or removed by this request shaping.
 */
export function makeSessionMetadataInput(items: readonly ConversationItem[]): string {
  const turns = items
    .map((item, index) => ({ index, text: String(item.original || '').replace(/\s+/g, ' ').trim().slice(0, 850) }))
    .filter((turn) => turn.text);
  const serialize = (turnsToUse: typeof turns) => turnsToUse
    .map((turn) => `[${turn.index + 1}] ${turn.text}`).join('\n');
  const full = serialize(turns);
  if (full.length <= MAX_SESSION_METADATA_CHARS) return full;
  // Preserve timeline coverage: both ends plus equidistant middle snapshots.
  const first = turns.slice(0, 8);
  const last = turns.slice(-8);
  const mids = turns.slice(8, -8);
  const selected = [...first, ...last];
  let budget = MAX_SESSION_METADATA_CHARS - serialize(selected).length - 128;
  const stride = Math.max(1, Math.ceil(mids.length / 55));
  for (let index = 0; index < mids.length; index += stride) {
    const entry = mids[index];
    if (budget < entry.text.length + 20) break;
    selected.push(entry);
    budget -= entry.text.length + 20;
  }
  selected.sort((a, b) => a.index - b.index);
  return serialize(selected).slice(0, MAX_SESSION_METADATA_CHARS);
}

export function normalizeSessionMetadata(payload: { title?: string; summary?: string } | null | undefined): { title: string; summary: string } | null {
  const title = String(payload?.title || '').replace(/\s+/g, ' ').trim().slice(0, 76);
  const summary = String(payload?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 320);
  if (!title || !summary) return null;
  if (title === DEFAULT_SESSION_TITLE) return null;
  return { title, summary };
}
