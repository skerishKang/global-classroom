/**
 * Multilingual Interview language routing policy.
 *
 * Policy (skerishKang/global-classroom#23):
 *  - Default target set for interview mode: {ko, en}
 *  - Source language is automatically excluded from the target set.
 *  - Three or more selected targets are supported.
 *  - Advanced pair rules are optional overrides.
 *
 * This module has no React/network dependency so routing logic is
 * testable deterministically.
 */

export type TranslationTarget = string;

export interface LanguagePairRule {
  source: string;
  target: string;
}

export interface InterviewLanguagePolicy {
  /** Selected output targets (user choice in settings). */
  targets: readonly TranslationTarget[];
  /** Optional explicit pair rules; when present they override auto-routing. */
  pairRules?: readonly LanguagePairRule[];
}

const DEFAULT_INTERVIEW_TARGETS: readonly TranslationTarget[] = ['ko', 'en'];

export function getDefaultTargets(): readonly TranslationTarget[] {
  return DEFAULT_INTERVIEW_TARGETS;
}

/**
 * Canonical base-language contract for interview routing.
 *
 * Gemini Transcribe reports full BCP-47 tags (`ko-KR`, `en-US`, `vi-VN`), while
 * the interview target set and pair rules store base language codes (`ko`,
 * `en`, `vi`). Routing is base-language scoped, so a tag is reduced to its
 * primary subtag, lowercased and whitespace/underscore normalized. Script and
 * region subtags (`zh-Hant-TW` -> `zh`) are intentionally ignored: the product
 * has exactly one target per base language. Full tags are never stored — every
 * comparison in this module happens on the canonical form.
 */
export function normalizeLanguageCode(code: string): string {
  if (typeof code !== 'string') return '';
  const trimmed = code.trim().toLowerCase().replace(/_/g, '-');
  if (!trimmed) return '';
  const primary = trimmed.split('-')[0];
  return primary || '';
}

/** Drop blanks, the `auto` pseudo-language and duplicates, preserving order. */
export function sanitizeTargets(targets: readonly TranslationTarget[]): TranslationTarget[] {
  const seen = new Set<TranslationTarget>();
  const result: TranslationTarget[] = [];
  for (const target of targets) {
    const code = normalizeLanguageCode(typeof target === 'string' ? target : '');
    if (!code || code === 'auto' || seen.has(code)) continue;
    seen.add(code);
    result.push(code);
  }
  return result;
}

/**
 * Return the ordered list of targets a given source should be translated to.
 *
 * All comparisons use the canonical base-language form, so a region-tagged
 * source (`ko-KR`) is excluded exactly like its base language (`ko`).
 * Auto mode: source is removed from selected targets.
 * Explicit pair rules: only rules whose source matches are used, and only
 * targets that are still inside `selectedTargets`. The returned codes are the
 * selected set's own codes, so callers can look them up unchanged.
 */
export function getTargetsForSource(
  detectedSource: string,
  policy: InterviewLanguagePolicy,
): readonly TranslationTarget[] {
  const source = normalizeLanguageCode(detectedSource);
  const isSelectable = (target: TranslationTarget) =>
    policy.targets.some((candidate) => normalizeLanguageCode(candidate) === normalizeLanguageCode(target));

  if (policy.pairRules && policy.pairRules.length > 0) {
    const ruled = policy.pairRules
      .filter((r) => normalizeLanguageCode(r.source) === source)
      .map((r) => r.target)
      .filter((t): t is TranslationTarget => isSelectable(t));
    if (ruled.length > 0) return ruled;
  }

  // Auto: drop the source language from the selected set.
  return policy.targets.filter((t) => normalizeLanguageCode(t) !== source);
}

/**
 * Crude heuristic fallback when the API detector is unavailable.
 * Mirrors the old `Korean vs non-Korean` behaviour but returns the actual
 * BCP-47 code so it can be excluded cleanly.
 */
export function detectSourceLanguageHeuristic(text: string): string {
  if (/[가-힣]/.test(text)) return 'ko';
  // Latin-script-dominant → English
  if (/[a-zA-Z]/.test(text)) return 'en';
  return 'en';
}

/** Which of several produced translations is shown by default. */
export function pickActiveTarget(
  available: readonly TranslationTarget[],
  preferred?: string | null,
): TranslationTarget {
  if (preferred && available.includes(preferred)) return preferred;
  return available[0] || '';
}

/** Compact header badge, e.g. `KO ↔ EN` for the default pair, `KO · EN · VI` beyond two. */
export function formatTargetBadge(targets: readonly TranslationTarget[]): string {
  const codes = sanitizeTargets(targets).map((target) => target.toUpperCase());
  if (codes.length === 0) return '';
  if (codes.length === 1) return codes[0];
  if (codes.length === 2) return `${codes[0]} ↔ ${codes[1]}`;
  return codes.join(' · ');
}

const PAIR_RULE_PATTERN = /^\s*([a-zA-Z-]{2,5})\s*(?:->|→|=>|=|:)\s*([a-zA-Z-]{2,5})\s*$/;

/** Parse the advanced settings textarea (`KO -> EN`, one rule per line). */
export function parsePairRules(text: string): LanguagePairRule[] {
  if (!text) return [];
  const rules: LanguagePairRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = PAIR_RULE_PATTERN.exec(line);
    if (!match) continue;
    // Rules are stored canonical too, so `JA-JP -> EN-US` matches `ja -> en`.
    const source = normalizeLanguageCode(match[1]);
    const target = normalizeLanguageCode(match[2]);
    if (!source || !target || source === target || source === 'auto') continue;
    rules.push({ source, target });
    if (rules.length >= 100) break;
  }
  return rules;
}

/** Render rules back into the advanced settings textarea format. */
export function formatPairRules(rules: readonly LanguagePairRule[]): string {
  return rules.map((rule) => `${rule.source.toUpperCase()} → ${rule.target.toUpperCase()}`).join('\n');
}
