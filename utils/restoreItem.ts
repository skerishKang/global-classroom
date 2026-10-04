/**
 * Type-guarded restoration of one ConversationItem from external backup JSON.
 *
 * Drive content is external data and must never be spread into the app state
 * blindly (#35). Restores used to rebuild only id/original/translated/
 * timestamp, which silently dropped the Interview metadata introduced by #23
 * (source language, per-target translations, active variant, live/manual and
 * stale flags) and broke the multilingual tabs after a restore.
 *
 * Policy:
 *  - every field is validated individually; malformed values fall back to a
 *    safe default instead of crashing or poisoning the state;
 *  - old backups that only carry id/original/translated/timestamp still restore;
 *  - audioBase64 / audioProvenance / audioUrl / ttsStatus are NEVER restored
 *    from the transcript JSON. Audio has its own manifest/wav restore path and
 *    restored audio deliberately carries no provenance, so the #34 guard keeps
 *    it from being replayed as if it belonged to the displayed variant;
 *  - runtime UI state (ttsStatus) is never restored.
 */
import { ConversationItem, TranslationVariant } from '../types';

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;

const asString = (value: unknown): string =>
    typeof value === 'string' ? value : '';

const asFiniteNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const normalizeTranslationVariant = (value: unknown): TranslationVariant | null => {
    // Tolerate legacy backups that stored plain strings per target.
    if (typeof value === 'string') {
        return value.trim() ? { text: value } : null;
    }
    const record = asRecord(value);
    if (!record) return null;
    const text = asString(record.text).trim();
    if (!text) return null;
    const variant: TranslationVariant = { text };
    if (record.kind === 'live' || record.kind === 'manual') variant.kind = record.kind;
    if (typeof record.stale === 'boolean') variant.stale = record.stale;
    const updatedAt = asFiniteNumber(record.updatedAt);
    if (typeof updatedAt === 'number') variant.updatedAt = updatedAt;
    return variant;
};

const restoreId = (value: unknown): string => {
    const id = asString(value).trim();
    if (id) return id;
    // A missing id would break row identity (merging, edits, audio binding);
    // synthesize a stable-enough one instead of crashing on old/corrupt files.
    const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (typeof globalCrypto?.randomUUID === 'function') return `restored-${globalCrypto.randomUUID()}`;
    return `restored-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export function normalizeRestoredConversationItem(raw: unknown): ConversationItem {
    const source = asRecord(raw) || {};

    const item: ConversationItem = {
        id: restoreId(source.id),
        original: asString(source.original),
        translated: asString(source.translated),
        isTranslating: false,
        timestamp: asFiniteNumber(source.timestamp) ?? Date.now(),
    };

    const originalRaw = asString(source.originalRaw);
    if (originalRaw) item.originalRaw = originalRaw;

    if (source.sourceKind === 'voice' || source.sourceKind === 'text') {
        item.sourceKind = source.sourceKind;
    }
    if (source.translationKind === 'live' || source.translationKind === 'manual') {
        item.translationKind = source.translationKind;
    }
    if (typeof source.translationStale === 'boolean') {
        item.translationStale = source.translationStale;
    }

    const sourceLanguage = asString(source.sourceLanguage).trim();
    if (sourceLanguage) item.sourceLanguage = sourceLanguage;

    const activeTarget = asString(source.activeTarget).trim();
    if (activeTarget) item.activeTarget = activeTarget;

    const translations = asRecord(source.translations);
    if (translations) {
        const cleaned: Record<string, TranslationVariant> = {};
        for (const [code, value] of Object.entries(translations)) {
            if (!code) continue;
            const variant = normalizeTranslationVariant(value);
            if (variant) cleaned[code] = variant;
        }
        if (Object.keys(cleaned).length > 0) item.translations = cleaned;
    }

    const updatedAt = asFiniteNumber(source.updatedAt);
    if (typeof updatedAt === 'number') item.updatedAt = updatedAt;

    return item;
}
