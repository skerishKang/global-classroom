import { afterEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { backupToDrive, restoreDriveSession, type DriveRestoreResult } from '../../utils/googleDrive';
import { applyRestoreResult } from '../../hooks/useStorage';
import { exportToDocs } from '../../utils/googleDocs';
import { normalizeRestoredConversationItem } from '../../utils/restoreItem';
import { GoogleHttpError } from '../../utils/googleHttp';
import { pcm16Base64ToWavBlob } from '../../utils/audioUtils';

const ORIGIN = 'https://classroom.example';

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const installFetch = (handler: FetchHandler) => {
    const fetchMock = vi.fn(async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : String(input?.url || '');
        return await handler(url, init as RequestInit | undefined);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
};

const isFolderSearch = (url: string) => url.includes('/drive/v3/files?q=') && !url.includes('orderBy=createdTime');
const isChildListing = (url: string) => url.includes('/drive/v3/files?q=') && url.includes('orderBy=createdTime');

afterEach(() => {
    vi.unstubAllGlobals();
});

const MULTILINGUAL_FIXTURE = {
    id: 'row-1',
    original: '안녕하세요',
    translated: 'Xin chào',
    timestamp: 1700000000000,
    sourceKind: 'voice',
    originalRaw: '안녕하세요.',
    sourceLanguage: 'ko',
    translations: {
        en: { text: 'Hello', kind: 'manual', stale: false, updatedAt: 1 },
        vi: { text: 'Xin chào', kind: 'live', stale: false },
    },
    activeTarget: 'vi',
    translationKind: 'live',
    translationStale: false,
};

describe('drive restore contract (#35)', () => {
  test('restore failure reports success:false and carries no history field', async () => {
    installFetch(async (url) => {
        if (isChildListing(url)) {
            return jsonResponse({ files: [{ id: 'm1', name: 'manifest.json', mimeType: 'application/json' }] });
        }
        return jsonResponse({}, 404);
    });

    const result = await restoreDriveSession('token', 'folder-1', false);
    expect(result.success).toBe(false);
    if (!result.success) {
        expect(result.message).toContain('transcript.json');
    }
    // The old truthy-array hazard: a failed restore must not expose a history
    // array that a `result.history` check would treat as success.
    expect('history' in result).toBe(false);
  });

  test('an empty but successful restore stays distinguishable from failure', async () => {
    installFetch(async (url) => {
        if (isChildListing(url)) {
            return jsonResponse({ files: [{ id: 't1', name: 'transcript.json', mimeType: 'application/json' }] });
        }
        if (url.includes('alt=media')) {
            return jsonResponse({ app: 'Global Classroom', sessionName: 'Session_empty', history: [] });
        }
        return jsonResponse({}, 404);
    });

    const result = await restoreDriveSession('token', 'folder-1', false);
    expect(result.success).toBe(true);
    if (result.success) {
        expect(result.history).toEqual([]);
        expect(result.message).toContain('복원');
    }
  });

  // A present transcript.json is not enough: damaged payloads (missing/null/
  // non-array history) are failures, never a legitimate empty session.
  const malformedTranscript = (transcriptBody: unknown) =>
    installFetch(async (url) => {
        if (isChildListing(url)) {
            return jsonResponse({ files: [{ id: 't1', name: 'transcript.json', mimeType: 'application/json' }] });
        }
        if (url.includes('alt=media')) {
            return new Response(JSON.stringify(transcriptBody), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return jsonResponse({}, 404);
    });

  test('transcript without a history field fails instead of reporting an empty session', async () => {
    await malformedTranscript({ app: 'Global Classroom' });

    const result = await restoreDriveSession('token', 'folder-1', false);
    expect(result.success).toBe(false);
    if (!result.success) {
        expect(result.message).toContain('형식');
    }
    expect('history' in result).toBe(false);
  });

  test('transcript with history=null fails', async () => {
    await malformedTranscript({ history: null });

    const result = await restoreDriveSession('token', 'folder-1', false);
    expect(result.success).toBe(false);
    expect('history' in result).toBe(false);
  });

  test('transcript with a non-array history (string/object) fails', async () => {
    await malformedTranscript({ history: 'broken' });
    const stringHistory = await restoreDriveSession('token', 'folder-1', false);
    expect(stringHistory.success).toBe(false);
    expect('history' in stringHistory).toBe(false);

    await malformedTranscript({ history: { 0: 'row' } });
    const objectHistory = await restoreDriveSession('token', 'folder-1', false);
    expect(objectHistory.success).toBe(false);
    expect('history' in objectHistory).toBe(false);
  });

  test('the four transcript contracts are distinguishable end to end', async () => {
    // VALID_EMPTY -> success with history=[]
    await malformedTranscript({ history: [] });
    const validEmpty = await restoreDriveSession('token', 'folder-1', false);
    expect(validEmpty.success).toBe(true);
    if (validEmpty.success) expect(validEmpty.history).toEqual([]);

    // MISSING -> failure
    await malformedTranscript({});
    const missing = await restoreDriveSession('token', 'folder-1', false);
    expect(missing.success).toBe(false);

    // NULL -> failure
    await malformedTranscript({ history: null });
    const nulled = await restoreDriveSession('token', 'folder-1', false);
    expect(nulled.success).toBe(false);

    // NON_ARRAY -> failure
    await malformedTranscript({ history: 'broken' });
    const broken = await restoreDriveSession('token', 'folder-1', false);
    expect(broken.success).toBe(false);
  });

  test('multilingual interview metadata survives a backup roundtrip', async () => {
    installFetch(async (url) => {
        if (isChildListing(url)) {
            return jsonResponse({ files: [{ id: 't1', name: 'transcript.json', mimeType: 'application/json' }] });
        }
        if (url.includes('alt=media')) {
            return jsonResponse({ app: 'Global Classroom', history: [MULTILINGUAL_FIXTURE] });
        }
        return jsonResponse({}, 404);
    });

    const result = await restoreDriveSession('token', 'folder-1', false);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.history).toHaveLength(1);
    const item = result.history[0];
    expect(item).toEqual({
        id: 'row-1',
        original: '안녕하세요',
        translated: 'Xin chào',
        originalRaw: '안녕하세요.',
        isTranslating: false,
        timestamp: 1700000000000,
        sourceKind: 'voice',
        sourceLanguage: 'ko',
        translations: {
            en: { text: 'Hello', kind: 'manual', stale: false, updatedAt: 1 },
            vi: { text: 'Xin chào', kind: 'live', stale: false },
        },
        activeTarget: 'vi',
        translationKind: 'live',
        translationStale: false,
    });
  });

  test('legacy backups with only core fields restore without crash', () => {
    const item = normalizeRestoredConversationItem({
        id: 'legacy-1',
        original: 'hello',
        translated: '안녕',
        timestamp: 123,
    });
    expect(item).toEqual({
        id: 'legacy-1',
        original: 'hello',
        translated: '안녕',
        isTranslating: false,
        timestamp: 123,
    });
    expect(item.sourceKind).toBeUndefined();
    expect(item.translations).toBeUndefined();
    expect(item.activeTarget).toBeUndefined();
  });

  test('malformed metadata falls back to safe defaults', () => {
    const item = normalizeRestoredConversationItem({
        original: 5,
        translated: null,
        timestamp: 'not-a-number',
        sourceKind: 'alien',
        sourceLanguage: 42,
        translations: [],
        activeTarget: 123,
        translationStale: 'yes',
        translationKind: 'other',
        ttsStatus: 'playing',
        audioBase64: 'should-not-come-back',
        audioProvenance: 'should-not-come-back',
    });

    expect(item.id.startsWith('restored-')).toBe(true);
    expect(item.original).toBe('');
    expect(item.translated).toBe('');
    expect(Math.abs(item.timestamp - Date.now())).toBeLessThan(5000);
    expect(item.sourceKind).toBeUndefined();
    expect(item.sourceLanguage).toBeUndefined();
    expect(item.translations).toBeUndefined();
    expect(item.activeTarget).toBeUndefined();
    expect(item.translationStale).toBeUndefined();
    expect(item.translationKind).toBeUndefined();
    // Audio identity is never restored from the transcript JSON: the manifest
    // path owns audio, and no provenance is ever fabricated (#34 contract).
    expect(item.audioBase64).toBeUndefined();
    expect(item.audioProvenance).toBeUndefined();
    expect(item.ttsStatus).toBeUndefined();
  });

  test('Drive HTTP failures surface as failures, never as success', async () => {
    installFetch(async () => jsonResponse({ error: { message: 'backend error' } }, 500));

    await expect(restoreDriveSession('token', 'folder-1', false)).rejects.toBeInstanceOf(GoogleHttpError);
    await expect(backupToDrive('token', [], { includeAudio: false })).rejects.toBeInstanceOf(GoogleHttpError);
  });
});

describe('docs export truthfulness (#35)', () => {
  test('a failed create never reaches batchUpdate and never reports success', async () => {
    const fetchMock = installFetch(async () => jsonResponse({ error: { message: 'forbidden' } }, 403));

    await expect(exportToDocs('token', [])).rejects.toBeInstanceOf(GoogleHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v1/documents');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('batchUpdate');
  });

  test('a failed batchUpdate fails the whole export', async () => {
    let call = 0;
    installFetch(async (url) => {
        call += 1;
        if (url.includes('batchUpdate')) return jsonResponse({ error: { message: 'write failed' } }, 500);
        return jsonResponse({ documentId: 'doc-1' });
    });

    await expect(exportToDocs('token', [{ ...normalizeRestoredConversationItem({ id: 'a', original: 'a', translated: 'b', timestamp: 1 }) }]))
        .rejects.toBeInstanceOf(GoogleHttpError);
    expect(call).toBe(2);
  });

  test('create + batchUpdate both succeeding still reports success', async () => {
    installFetch(async (url) => {
        if (url.includes('batchUpdate')) return jsonResponse({ documentId: 'doc-1' });
        return jsonResponse({ documentId: 'doc-1' });
    });

    const result = await exportToDocs('token', []);
    expect(result.success).toBe(true);
    expect(result.docId).toBe('doc-1');
  });
});

describe('backup tts key policy parity (#35/#32)', () => {
  test('backup TTS generation forwards the personal key as x-user-api-key', async () => {
    const ttsHeaders: Array<Record<string, string>> = [];
    const pcmBase64 = Buffer.from([1, 2, 3, 4]).toString('base64');
    installFetch(async (url, init) => {
        if (url.includes('/api/tts')) {
            ttsHeaders.push((init?.headers || {}) as Record<string, string>);
            return jsonResponse({ audioBase64: pcmBase64 });
        }
        if (url.includes('/upload/')) return jsonResponse({ id: 'file-1', name: 'x.wav' });
        if (isFolderSearch(url)) return jsonResponse({ files: [] });
        return jsonResponse({ id: 'folder-1' });
    });

    const result = await backupToDrive('token', [
        normalizeRestoredConversationItem({ id: 'row-1', original: '안녕', translated: 'Hello', timestamp: 1 }),
    ], {
        includeAudio: true,
        generateMissingAudio: true,
        voiceName: 'Kore',
        ttsModel: 'gemini-2.5-flash-preview-tts',
        userApiKey: 'fake-user-key',
    });

    expect(ttsHeaders).toHaveLength(1);
    expect(ttsHeaders[0]['x-user-api-key']).toBe('fake-user-key');
    expect(result.success).toBe(true);
    expect(result.audioUploadedCount).toBe(1);
    expect(result.audioFailedCount).toBe(0);
  });

  test('without a personal key no x-user-api-key header is sent', async () => {
    const ttsHeaders: Array<Record<string, string>> = [];
    installFetch(async (url, init) => {
        if (url.includes('/api/tts')) {
            ttsHeaders.push((init?.headers || {}) as Record<string, string>);
            return jsonResponse({ audioBase64: Buffer.from([1, 2]).toString('base64') });
        }
        if (url.includes('/upload/')) return jsonResponse({ id: 'file-1' });
        if (isFolderSearch(url)) return jsonResponse({ files: [] });
        return jsonResponse({ id: 'folder-1' });
    });

    await backupToDrive('token', [
        normalizeRestoredConversationItem({ id: 'row-1', original: '안녕', translated: 'Hello', timestamp: 1 }),
    ], {
        includeAudio: true,
        generateMissingAudio: true,
        voiceName: 'Kore',
        ttsModel: 'gemini-2.5-flash-preview-tts',
    });

    expect(ttsHeaders).toHaveLength(1);
    expect(ttsHeaders[0]['x-user-api-key']).toBeUndefined();
  });

  test('backup TTS generation failure is recorded as missing audio, not as uploaded audio', async () => {
    installFetch(async (url) => {
        if (url.includes('/api/tts')) return jsonResponse({ error: 'quota exceeded' }, 429);
        if (url.includes('/upload/')) return jsonResponse({ id: 'file-1' });
        if (isFolderSearch(url)) return jsonResponse({ files: [] });
        return jsonResponse({ id: 'folder-1' });
    });

    const result = await backupToDrive('token', [
        normalizeRestoredConversationItem({ id: 'row-1', original: '안녕', translated: 'Hello', timestamp: 1 }),
    ], {
        includeAudio: true,
        generateMissingAudio: true,
        voiceName: 'Kore',
        ttsModel: 'gemini-2.5-flash-preview-tts',
    });

    expect(result.success).toBe(true);
    expect(result.audioUploadedCount).toBe(0);
    expect(result.audioFailedCount).toBe(1);
  });
});

describe('restore caller contract (#35): failures never touch the conversation', () => {
  const collect = (result: DriveRestoreResult) => {
    let historyReplacements = 0;
    let successToasts = 0;
    let errorToasts = 0;
    const handled = applyRestoreResult(
        result,
        () => { historyReplacements += 1; },
        (_message, type) => {
            if (type === 'error') errorToasts += 1;
            else successToasts += 1;
        },
    );
    return { handled, historyReplacements, successToasts, errorToasts };
  };

  test('a malformed-transcript failure replaces nothing and shows exactly one error', () => {
    const outcome = collect({
        success: false,
        message: 'transcript.json 형식이 올바르지 않습니다.',
        folderId: 'folder-1',
        folderUrl: 'https://drive.google.com/drive/folders/folder-1',
    });
    expect(outcome.handled).toBe(false);
    expect(outcome.historyReplacements).toBe(0);
    expect(outcome.successToasts).toBe(0);
    expect(outcome.errorToasts).toBe(1);
  });

  test('a successful restore replaces history once and shows exactly one success', () => {
    const outcome = collect({
        success: true,
        message: '대화 복원을 완료했습니다.',
        folderId: 'folder-1',
        folderUrl: 'https://drive.google.com/drive/folders/folder-1',
        history: [],
        audioRestoredCount: 0,
        audioFailedCount: 0,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.historyReplacements).toBe(1);
    expect(outcome.successToasts).toBe(1);
    expect(outcome.errorToasts).toBe(0);
  });
});

describe('drive audio restore keeps the #34 provenance contract', () => {
  test('restored audio carries no fabricated provenance', async () => {
    const pcmBase64 = Buffer.from([1, 2, 3, 4]).toString('base64');
    const wavBlob = pcm16Base64ToWavBlob(pcmBase64, 24000, 1);
    const wavBuffer = await wavBlob.arrayBuffer();

    installFetch(async (url) => {
        if (isChildListing(url)) {
            return jsonResponse({
                files: [
                    { id: 't1', name: 'transcript.json', mimeType: 'application/json' },
                    { id: 'm1', name: 'manifest.json', mimeType: 'application/json' },
                ],
            });
        }
        // Media downloads are distinguishable by the requested file id.
        if (url.includes('/files/t1?alt=media')) {
            return jsonResponse({ app: 'Global Classroom', history: [MULTILINGUAL_FIXTURE] });
        }
        if (url.includes('/files/m1?alt=media')) {
            return jsonResponse({
                sessionName: 'Session_x',
                voiceName: 'Kore',
                ttsModel: 'gemini-2.5-flash-preview-tts',
                items: [{ id: 'row-1', timestamp: 1, audio: { fileId: 'wav-1', voiceName: 'Kore', ttsModel: 'gemini-2.5-flash-preview-tts' } }],
            });
        }
        if (url.includes('/files/wav-1?alt=media')) {
            return new Response(wavBuffer, { status: 200 });
        }
        return jsonResponse({}, 404);
    });

    const result = await restoreDriveSession('token', 'folder-1', true);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.audioRestoredCount).toBe(1);
    const restored = result.history[0];
    expect(restored.audioBase64).toBeTruthy();
    // #34: restored audio must not pretend to belong to the displayed variant.
    expect(restored.audioProvenance).toBeUndefined();
  });
});
