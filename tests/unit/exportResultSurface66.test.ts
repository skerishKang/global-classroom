import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    buildClassroomExportResult,
    buildDocsExportResult,
    buildDocsLocalFallbackResult,
    buildDriveExportResult,
    buildDriveFolderUrl,
    buildExportFailureResult,
    describeExportError,
    getExportResultMessages,
} from '../../utils/exportResult';
import type { DriveBackupResult } from '../../utils/googleDrive';
import { buildGoogleDocsDocumentUrl, type DocsExportResult } from '../../utils/googleDocs';

/**
 * Issue #66 — the export flow must report every outcome through one
 * non-blocking, actionable result surface instead of `alert()`, and must never
 * open a destination tab by itself.
 *
 * The repo has no jsdom/@testing-library, so `useExport` is driven through a
 * minimal React dispatcher (same approach as #39's retention tests) with the
 * Google/file helpers stubbed: no live Google call is made here.
 */

const reactRuntime = vi.hoisted(() => {
    let hookIndex = 0;
    let stateSlots: unknown[] = [];
    let refSlots: Array<{ current: unknown }> = [];
    let dirty = false;
    let current: unknown;

    const useState = <T,>(initial: T | (() => T)): [T, (next: unknown) => void] => {
        const index = hookIndex++;
        if (!(index in stateSlots)) {
            stateSlots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
        }
        const setState = (next: unknown): void => {
            const prev = stateSlots[index];
            const value = typeof next === 'function' ? (next as (p: unknown) => unknown)(prev) : next;
            if (!Object.is(prev, value)) {
                stateSlots[index] = value;
                dirty = true;
            }
        };
        return [stateSlots[index] as T, setState];
    };

    const useRef = <T,>(initial: T) => {
        const index = hookIndex++;
        if (!(index in refSlots)) refSlots[index] = { current: initial };
        return refSlots[index] as { current: T };
    };

    const render = (component: () => unknown): void => {
        hookIndex = 0;
        current = component();
    };

    const flush = (component: () => unknown): void => {
        let guard = 0;
        while (dirty) {
            guard += 1;
            if (guard > 200) throw new Error('render loop did not settle');
            dirty = false;
            render(component);
        }
    };

    const reset = (): void => {
        hookIndex = 0;
        stateSlots = [];
        refSlots = [];
        dirty = false;
        current = undefined;
    };

    return { useState, useRef, render, flush, reset, get current() { return current; } };
});

vi.mock('react', () => ({
    useState: reactRuntime.useState,
    useRef: reactRuntime.useRef,
}));

const workspace = vi.hoisted(() => ({
    backupToDrive: vi.fn(),
    exportToDocs: vi.fn(),
    listCourses: vi.fn(),
    createCourseWork: vi.fn(),
}));

vi.mock('../../utils/googleWorkspace', () => ({
    backupToDrive: workspace.backupToDrive,
    exportToDocs: workspace.exportToDocs,
    listCourses: workspace.listCourses,
    createCourseWork: workspace.createCourseWork,
}));

const fileExport = vi.hoisted(() => ({
    downloadTranscriptLocally: vi.fn(),
}));

vi.mock('../../utils/fileExport', () => ({
    downloadTranscriptLocally: fileExport.downloadTranscriptLocally,
}));

const { useExport } = await import('../../hooks/useExport');

// --- fixtures ---------------------------------------------------------------

const driveFolderUrl = 'https://drive.google.com/drive/folders/e2e-session-folder';

const driveBackupResult = (overrides: Partial<DriveBackupResult> = {}): DriveBackupResult => ({
    success: true,
    message: 'Backup complete.',
    folderId: 'e2e-session-folder',
    folderUrl: driveFolderUrl,
    audioUploadedCount: 0,
    audioFailedCount: 0,
    ...overrides,
});

const docsExportResult = (overrides: Partial<DocsExportResult> = {}): DocsExportResult => ({
    success: true,
    docId: 'e2e-doc-1',
    documentUrl: 'https://docs.google.com/document/d/e2e-doc-1/edit',
    title: 'Global Classroom Notes',
    message: 'Document created successfully.',
    ...overrides,
});

interface ExportHarness {
    current: ReturnType<typeof useExport>;
    act: (fn: () => Promise<void> | void) => Promise<void>;
}

const renderExport = (accessToken: string | null, langCode = 'ko'): ExportHarness => {
    reactRuntime.reset();
    const component = () => useExport({
        accessToken,
        history: [],
        selectedVoice: { name: 'Kore', label: 'Kore', gender: 'Female', style: 'Calm' },
        uiLangCode: langCode,
        t: { exportSuccess: 'Localized done', offlineMode: 'Localized offline download' } as any,
        setIsLoginModalOpen: () => {},
        settings: {} as any,
    });

    reactRuntime.render(component);
    reactRuntime.flush(component);

    return {
        get current() {
            return reactRuntime.current as ReturnType<typeof useExport>;
        },
        act: async (fn) => {
            await fn();
            reactRuntime.flush(component);
        },
    };
};

let alertSpy: ReturnType<typeof vi.fn>;
let openSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
    workspace.backupToDrive.mockReset();
    workspace.exportToDocs.mockReset();
    workspace.listCourses.mockReset();
    workspace.createCourseWork.mockReset();
    fileExport.downloadTranscriptLocally.mockReset();
    workspace.listCourses.mockResolvedValue([]);

    alertSpy = vi.fn();
    openSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    vi.stubGlobal('window', { open: openSpy });
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// --- destination URL canonicalization ---------------------------------------

describe('export destination links are rebuilt from validated ids (#66)', () => {
    test('a Drive folder url is accepted only on drive.google.com and rebuilt from the id', () => {
        expect(buildDriveFolderUrl('https://drive.google.com/drive/folders/abc-123'))
            .toBe('https://drive.google.com/drive/folders/abc-123');

        expect(buildDriveFolderUrl('http://drive.google.com/drive/folders/abc-123')).toBeNull();
        expect(buildDriveFolderUrl('https://evil.example/drive/folders/abc-123')).toBeNull();
        expect(buildDriveFolderUrl('javascript:alert(1)')).toBeNull();
        expect(buildDriveFolderUrl('https://drive.google.com/drive/files/abc-123')).toBeNull();
        // Query/fragment cannot ride along into the rendered link.
        expect(buildDriveFolderUrl('https://drive.google.com/drive/folders/abc-123?redirect=evil'))
            .toBe('https://drive.google.com/drive/folders/abc-123');
        expect(buildDriveFolderUrl(undefined)).toBeNull();
    });

    test('a Docs url is built from the document id only', () => {
        expect(buildGoogleDocsDocumentUrl('e2e-doc-1'))
            .toBe('https://docs.google.com/document/d/e2e-doc-1/edit');
        expect(buildGoogleDocsDocumentUrl('https://evil.example/x')).toBeNull();
        expect(buildGoogleDocsDocumentUrl('')).toBeNull();
    });
});

// --- result construction ----------------------------------------------------

describe('drive export result (#66)', () => {
    test('a successful backup offers the folder as an explicit action', () => {
        const result = buildDriveExportResult(driveBackupResult(), getExportResultMessages('ko'));

        expect(result.tone).toBe('success');
        expect(result.target).toBe('drive');
        expect(result.action).toEqual({
            id: 'open-drive-folder',
            label: 'Drive 폴더 열기',
            href: driveFolderUrl,
        });
    });

    test('partial audio upload is reported instead of being hidden', () => {
        const result = buildDriveExportResult(
            driveBackupResult({ audioUploadedCount: 3, audioFailedCount: 1 }),
            getExportResultMessages('ko'),
        );

        expect(result.tone).toBe('success');
        expect(result.detail).toBe('오디오 3개는 저장했고, 1개는 저장하지 못했습니다.');
    });

    test('a backup without an audio step shows no audio detail', () => {
        const result = buildDriveExportResult(driveBackupResult(), getExportResultMessages('ko'));
        expect(result.detail).toBeUndefined();
    });

    test('an unsuccessful backup is never reported as a success', () => {
        const result = buildDriveExportResult(
            driveBackupResult({ success: false, message: 'upload failed' }),
            getExportResultMessages('ko'),
        );

        expect(result.tone).toBe('error');
        expect(result.action).toBeUndefined();
        expect(result.message).toContain('upload failed');
    });
});

describe('docs export result (#66/#35)', () => {
    test('a written document offers an Open document action built from the doc id', () => {
        const result = buildDocsExportResult(docsExportResult(), getExportResultMessages('ko'));

        expect(result.tone).toBe('success');
        expect(result.action).toEqual({
            id: 'open-document',
            label: '문서 열기',
            href: 'https://docs.google.com/document/d/e2e-doc-1/edit',
        });
    });

    test('a document url carried by the API result is never trusted', () => {
        const result = buildDocsExportResult(
            docsExportResult({ documentUrl: 'https://evil.example/steal' }),
            getExportResultMessages('ko'),
        );

        expect(result.action?.href).toBe('https://docs.google.com/document/d/e2e-doc-1/edit');
    });

    test('a result without a document id is reported as a failure, never a success', () => {
        expect(buildDocsExportResult(null, getExportResultMessages('ko')).tone).toBe('error');
        expect(buildDocsExportResult(
            docsExportResult({ success: false, docId: '' }),
            getExportResultMessages('ko'),
        ).tone).toBe('error');
    });
});

describe('docs local fallback is truthful (#66)', () => {
    test('signed-out fallback states that nothing reached Google Docs', () => {
        const result = buildDocsLocalFallbackResult({ kind: 'signed-out' }, getExportResultMessages('ko'));

        expect(result.tone).toBe('fallback');
        expect(result.action).toBeUndefined();
        expect(result.title).toBe('텍스트 파일로만 저장됨');
        expect(result.message).toContain('Google Docs에 저장하지 못했습니다');
        expect(result.message).toContain('텍스트 파일로 다운로드');
    });

    test('failed-export fallback names the reason and still only a text file', () => {
        const result = buildDocsLocalFallbackResult(
            { kind: 'failed', error: new Error('Google Docs 내용 쓰기 요청이 실패했습니다. (500)') },
            getExportResultMessages('ko'),
        );

        expect(result.tone).toBe('fallback');
        expect(result.action).toBeUndefined();
        expect(result.message).toContain('(500)');
        expect(result.message).toContain('텍스트 파일로 다운로드');
    });
});

describe('classroom export result (#66)', () => {
    test('a submission reports success without inventing a Classroom deep link', () => {
        const result = buildClassroomExportResult(getExportResultMessages('ko'));

        expect(result.tone).toBe('success');
        expect(result.target).toBe('classroom');
        expect(result.action).toBeUndefined();
    });

    test('a submission failure is reported as an error with no action', () => {
        const result = buildExportFailureResult(
            'classroom',
            new Error('Failed to create coursework'),
            getExportResultMessages('ko'),
        );

        expect(result.tone).toBe('error');
        expect(result.action).toBeUndefined();
        expect(result.message).toContain('Classroom 제출 실패');
    });
});

describe('export result copy', () => {
    test('existing non-KO/EN locales preserve their localized export/offline copy', () => {
        expect(getExportResultMessages('ko').close).toBe('닫기');
        expect(getExportResultMessages('en').close).toBe('Close');

        const french = getExportResultMessages('fr', {
            exportSuccess: 'Terminé !',
            offlineMode: 'Téléchargé comme fichier texte.',
        });
        expect(french.driveSuccessBody).toBe('Terminé !');
        expect(french.docsSuccessBody).toBe('Terminé !');
        expect(french.classroomSuccessBody).toBe('Terminé !');
        expect(french.localFallbackSignedOut).toBe('Téléchargé comme fichier texte.');
        expect(french.close).toBe('Close');

        expect(getExportResultMessages().close).toBe('Close');
    });

    test('error text is flattened and bounded before it reaches the surface', () => {
        expect(describeExportError(new Error('a\n\nb'), 'fallback')).toBe('a b');
        expect(describeExportError('plain', 'fallback')).toBe('plain');
        expect(describeExportError(undefined, 'fallback')).toBe('fallback');
        expect(describeExportError(new Error('x'.repeat(500)), 'fallback')).toHaveLength(240);
    });
});

// --- useExport caller contract ---------------------------------------------

describe('useExport surfaces every outcome without alert() (#66)', () => {
    test('a drive backup never alerts and never opens a tab by itself', async () => {
        workspace.backupToDrive.mockResolvedValue(driveBackupResult());
        const h = renderExport('token');

        await h.act(() => h.current.handleExport('drive'));

        expect(alertSpy).not.toHaveBeenCalled();
        expect(openSpy).not.toHaveBeenCalled();
        expect(h.current.exportResult?.tone).toBe('success');
        expect(h.current.exportResult?.action?.href).toBe(driveFolderUrl);
    });

    test('a drive backup failure is reported through the result surface', async () => {
        workspace.backupToDrive.mockRejectedValue(new Error('Drive 폴더 생성 요청이 실패했습니다. (403)'));
        const h = renderExport('token');

        await h.act(() => h.current.handleExport('drive'));

        expect(alertSpy).not.toHaveBeenCalled();
        expect(h.current.exportResult?.tone).toBe('error');
        expect(h.current.exportResult?.action).toBeUndefined();
    });

    test('a docs export exposes the created document as an action', async () => {
        workspace.exportToDocs.mockResolvedValue(docsExportResult());
        const h = renderExport('token');

        await h.act(() => h.current.handleExport('docs'));

        expect(alertSpy).not.toHaveBeenCalled();
        expect(fileExport.downloadTranscriptLocally).not.toHaveBeenCalled();
        expect(h.current.exportResult?.tone).toBe('success');
        expect(h.current.exportResult?.action?.id).toBe('open-document');
    });

    test('a docs failure falls back to a local download and says so', async () => {
        workspace.exportToDocs.mockRejectedValue(new Error('Google Docs 문서 생성 요청이 실패했습니다. (403)'));
        const h = renderExport('token');

        await h.act(() => h.current.handleExport('docs'));

        expect(alertSpy).not.toHaveBeenCalled();
        expect(fileExport.downloadTranscriptLocally).toHaveBeenCalledTimes(1);
        expect(h.current.exportResult?.tone).toBe('fallback');
        expect(h.current.exportResult?.action).toBeUndefined();
    });

    test('a docs export without a Google session downloads locally without claiming Docs success', async () => {
        const h = renderExport(null);

        await h.act(() => h.current.handleExport('docs'));

        expect(alertSpy).not.toHaveBeenCalled();
        expect(workspace.exportToDocs).not.toHaveBeenCalled();
        expect(fileExport.downloadTranscriptLocally).toHaveBeenCalledTimes(1);
        expect(h.current.exportResult?.tone).toBe('fallback');
        expect(h.current.exportResult?.message).toContain('Google 로그인 상태가 아니어서');
    });

    test('a classroom submission reports success and failure without alert()', async () => {
        workspace.createCourseWork.mockResolvedValue({ id: 'work-1' });
        const ok = renderExport('token');
        await ok.act(() => ok.current.handleSubmitCourseWork('course-1'));

        expect(alertSpy).not.toHaveBeenCalled();
        expect(ok.current.exportResult?.tone).toBe('success');
        expect(ok.current.exportResult?.target).toBe('classroom');
        expect(ok.current.exportResult?.action).toBeUndefined();

        workspace.createCourseWork.mockRejectedValue(new Error('Failed to create coursework'));
        const failed = renderExport('token');
        await failed.act(() => failed.current.handleSubmitCourseWork('course-1'));

        expect(alertSpy).not.toHaveBeenCalled();
        expect(failed.current.exportResult?.tone).toBe('error');
        expect(failed.current.exportResult?.action).toBeUndefined();
    });

    test('the NotebookLM flow keeps its own guide and folder tab', async () => {
        workspace.backupToDrive.mockResolvedValue(driveBackupResult());
        const h = renderExport('token');

        await h.act(() => h.current.handleExport('notebooklm'));

        expect(workspace.backupToDrive).toHaveBeenCalledWith(
            'token',
            [],
            expect.objectContaining({ notebookLMMode: true }),
        );
        expect(openSpy).toHaveBeenCalledWith(driveFolderUrl, '_blank');
        expect(h.current.isNotebookLMGuideOpen).toBe(true);
        expect(alertSpy).not.toHaveBeenCalled();
    });
});