import type { TranslationMap } from '../types';
import type { DriveBackupResult } from './googleDrive';
import { buildGoogleDocsDocumentUrl, type DocsExportResult } from './googleDocs';

/**
 * Export result surface (#66).
 *
 * The export flow used to report every outcome with a blocking `alert()`, and a
 * successful Drive backup additionally popped the destination folder open in a
 * new tab. This module turns each export outcome into a single declarative
 * `ExportResult` value that a non-blocking surface renders, including the
 * explicit "open the destination" action when a real destination exists.
 *
 * Every helper here is pure so the contract is unit-testable without a DOM, and
 * destination URLs are always rebuilt from a validated Google resource id —
 * never forwarded from whatever URL a caller happened to hand us.
 */

export type ExportTarget = 'drive' | 'docs' | 'classroom' | 'notebooklm';

/** `fallback` is deliberately distinct from `success`: nothing reached Google. */
export type ExportResultTone = 'success' | 'error' | 'fallback';

export type ExportResultActionId = 'open-drive-folder' | 'open-document';

export interface ExportResultAction {
    id: ExportResultActionId;
    label: string;
    href: string;
}

export interface ExportResult {
    target: ExportTarget;
    tone: ExportResultTone;
    title: string;
    message: string;
    detail?: string;
    /** Present only when a real destination was produced; never auto-opened. */
    action?: ExportResultAction;
}

export type ExportResultMessages = {
    driveSuccessTitle: string;
    driveSuccessBody: string;
    driveAudioDetail: (uploaded: number, failed: number) => string;
    driveFolderAction: string;
    docsSuccessTitle: string;
    docsSuccessBody: string;
    docsDocumentAction: string;
    classroomSuccessTitle: string;
    classroomSuccessBody: string;
    failureTitle: string;
    failureBody: (target: ExportTarget, reason: string) => string;
    localFallbackTitle: string;
    localFallbackSignedOut: string;
    localFallbackFailed: (reason: string) => string;
    close: string;
};

/**
 * Canonical Drive folder URL. The folder URL produced by `backupToDrive` is
 * parsed rather than trusted: only `https://drive.google.com/drive/folders/<id>`
 * is accepted, and the returned link is rebuilt from the extracted id so query
 * strings or fragments cannot ride along into the rendered href.
 */
export const buildDriveFolderUrl = (folderUrl: unknown): string | null => {
    if (typeof folderUrl !== 'string' || folderUrl.length === 0) return null;

    let parsed: URL;
    try {
        parsed = new URL(folderUrl);
    } catch {
        return null;
    }

    if (parsed.protocol !== 'https:' || parsed.hostname !== 'drive.google.com') return null;

    const match = /^\/drive\/folders\/([a-zA-Z0-9_-]{1,128})$/.exec(parsed.pathname);
    if (!match) return null;

    return `https://drive.google.com/drive/folders/${match[1]}`;
};

/**
 * Google failure messages are already sanitized by `googleHttp` before they
 * reach the UI; this only bounds the length and flattens line breaks so a
 * payload can never reshape the result surface.
 */
export const describeExportError = (error: unknown, fallback: string): string => {
    const raw = error instanceof Error
        ? error.message
        : typeof error === 'string'
            ? error
            : '';

    const normalized = raw.replace(/\s+/g, ' ').trim().slice(0, 240);
    return normalized || fallback;
};

const FAILURE_LABEL_KO: Record<ExportTarget, string> = {
    drive: 'Drive 백업 실패',
    docs: 'Google Docs 저장 실패',
    classroom: 'Classroom 제출 실패',
    notebooklm: 'NotebookLM용 소스 저장 실패',
};

const FAILURE_LABEL_EN: Record<ExportTarget, string> = {
    drive: 'Drive backup failed',
    docs: 'Google Docs save failed',
    classroom: 'Classroom submission failed',
    notebooklm: 'NotebookLM source save failed',
};

const KOREAN_MESSAGES: ExportResultMessages = {
    driveSuccessTitle: 'Drive 백업 완료',
    driveSuccessBody: '대화 기록을 Google Drive 폴더에 저장했습니다.',
    driveAudioDetail: (uploaded, failed) => `오디오 ${uploaded}개는 저장했고, ${failed}개는 저장하지 못했습니다.`,
    driveFolderAction: 'Drive 폴더 열기',
    docsSuccessTitle: 'Google Docs 저장 완료',
    docsSuccessBody: '대화 기록을 새 Google 문서에 저장했습니다.',
    docsDocumentAction: '문서 열기',
    classroomSuccessTitle: 'Classroom 제출 완료',
    classroomSuccessBody: '번역 노트를 수업 과제로 제출했습니다.',
    failureTitle: '내보내기 실패',
    failureBody: (target, reason) => `${FAILURE_LABEL_KO[target]}: ${reason}`,
    localFallbackTitle: '텍스트 파일로만 저장됨',
    localFallbackSignedOut: 'Google 로그인 상태가 아니어서 Google Docs에 저장하지 못했습니다. 대신 대화 기록을 텍스트 파일로 다운로드했습니다.',
    localFallbackFailed: (reason) => `Google Docs에 저장하지 못했습니다 (${reason}). 대신 대화 기록을 텍스트 파일로 다운로드했습니다.`,
    close: '닫기',
};

const ENGLISH_MESSAGES: ExportResultMessages = {
    driveSuccessTitle: 'Drive backup complete',
    driveSuccessBody: 'Your conversation was saved to a Google Drive folder.',
    driveAudioDetail: (uploaded, failed) => `${uploaded} audio file(s) saved, ${failed} could not be saved.`,
    driveFolderAction: 'Open Drive folder',
    docsSuccessTitle: 'Saved to Google Docs',
    docsSuccessBody: 'Your conversation was saved to a new Google Doc.',
    docsDocumentAction: 'Open document',
    classroomSuccessTitle: 'Submitted to Classroom',
    classroomSuccessBody: 'The translation notes were submitted as coursework.',
    failureTitle: 'Export failed',
    failureBody: (target, reason) => `${FAILURE_LABEL_EN[target]}: ${reason}`,
    localFallbackTitle: 'Saved as a text file only',
    localFallbackSignedOut: 'You are not signed in to Google, so nothing was saved to Google Docs. Your conversation was downloaded as a text file instead.',
    localFallbackFailed: (reason) => `Nothing was saved to Google Docs (${reason}). Your conversation was downloaded as a text file instead.`,
    close: 'Close',
};

const MESSAGES_BY_LANG: Record<string, ExportResultMessages> = {
    ko: KOREAN_MESSAGES,
    en: ENGLISH_MESSAGES,
};

/**
 * Keep the polished KO/EN copy for the new result surface. For every other
 * existing UI locale, preserve the already-localized export/offline messages
 * from `constants.ts` instead of regressing those users to English (#66).
 * Newly introduced action labels still fall back to English until dedicated
 * translations are added to the shared TranslationMap.
 */
export const getExportResultMessages = (
    langCode?: string,
    existing?: Pick<TranslationMap, 'exportSuccess' | 'offlineMode'>,
): ExportResultMessages => {
    const direct = MESSAGES_BY_LANG[langCode || ''];
    if (direct || !existing) return direct || ENGLISH_MESSAGES;

    return {
        ...ENGLISH_MESSAGES,
        driveSuccessTitle: 'Google Drive',
        driveSuccessBody: existing.exportSuccess,
        docsSuccessTitle: 'Google Docs',
        docsSuccessBody: existing.exportSuccess,
        classroomSuccessTitle: 'Google Classroom',
        classroomSuccessBody: existing.exportSuccess,
        localFallbackTitle: 'Google Docs',
        localFallbackSignedOut: existing.offlineMode,
        localFallbackFailed: (reason) => reason + ' — ' + existing.offlineMode,
    };
};

export const buildExportFailureResult = (
    target: ExportTarget,
    error: unknown,
    messages: ExportResultMessages = ENGLISH_MESSAGES,
): ExportResult => ({
    target,
    tone: 'error',
    title: messages.failureTitle,
    message: messages.failureBody(target, describeExportError(error, messages.failureTitle)),
});

/**
 * Drive backup result. The destination folder is offered as an explicit action;
 * it is never opened on the user's behalf (#66).
 */
export const buildDriveExportResult = (
    result: DriveBackupResult,
    messages: ExportResultMessages = ENGLISH_MESSAGES,
): ExportResult => {
    if (!result?.success) {
        return buildExportFailureResult('drive', result?.message, messages);
    }

    const folderUrl = buildDriveFolderUrl(result.folderUrl);
    const audioWasAttempted = result.audioUploadedCount > 0 || result.audioFailedCount > 0;

    return {
        target: 'drive',
        tone: 'success',
        title: messages.driveSuccessTitle,
        message: messages.driveSuccessBody,
        detail: audioWasAttempted
            ? messages.driveAudioDetail(result.audioUploadedCount, result.audioFailedCount)
            : undefined,
        action: folderUrl
            ? { id: 'open-drive-folder', label: messages.driveFolderAction, href: folderUrl }
            : undefined,
    };
};

/**
 * A Docs export is only ever reported as successful when the API returned both
 * a document id and a truthy success flag (#35): a created-but-unwritten
 * document must never be sold as a completed export.
 */
export const buildDocsExportResult = (
    result: DocsExportResult | null | undefined,
    messages: ExportResultMessages = ENGLISH_MESSAGES,
): ExportResult => {
    if (!result?.success || !result.docId) {
        return buildExportFailureResult('docs', result?.message, messages);
    }

    // Rebuilt from the document id, so a documentUrl coming back from the API
    // layer can never redirect the action somewhere else.
    const documentUrl = buildGoogleDocsDocumentUrl(result.docId);

    return {
        target: 'docs',
        tone: 'success',
        title: messages.docsSuccessTitle,
        message: messages.docsSuccessBody,
        action: documentUrl
            ? { id: 'open-document', label: messages.docsDocumentAction, href: documentUrl }
            : undefined,
    };
};

/**
 * The Docs offline/failure path: `downloadTranscriptLocally` already ran, so the
 * surface states that outcome instead of implying anything reached Google Docs.
 */
export const buildDocsLocalFallbackResult = (
    reason: { kind: 'signed-out' } | { kind: 'failed'; error: unknown },
    messages: ExportResultMessages = ENGLISH_MESSAGES,
): ExportResult => ({
    target: 'docs',
    tone: 'fallback',
    title: messages.localFallbackTitle,
    message: reason.kind === 'signed-out'
        ? messages.localFallbackSignedOut
        : messages.localFallbackFailed(describeExportError(reason.error, messages.failureTitle)),
});

export const buildClassroomExportResult = (
    messages: ExportResultMessages = ENGLISH_MESSAGES,
): ExportResult => ({
    target: 'classroom',
    tone: 'success',
    title: messages.classroomSuccessTitle,
    message: messages.classroomSuccessBody,
});