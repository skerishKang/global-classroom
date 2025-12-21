import { ConversationItem } from '../types';
import { arrayBufferToBase64, base64ToUint8Array, wavArrayBufferToPcmBase64, pcm16Base64ToWavBlob } from './audioUtils';
import { getCachedAudioBase64 } from './idbAudioCache';
import { generateTtsBase64 } from './tts';

export type DriveBackupOptions = {
    includeAudio?: boolean;
    voiceName?: string;
    ttsModel?: string;
    generateMissingAudio?: boolean;
    notebookLMMode?: boolean;
};

export type DriveBackupResult = {
    success: boolean;
    message: string;
    folderId: string;
    folderUrl: string;
    transcriptFileId?: string;
    transcriptJsonFileId?: string;
    manifestFileId?: string;
    audioFolderId?: string;
    audioUploadedCount: number;
    audioFailedCount: number;
};

export type DriveSessionInfo = {
    folderId: string;
    folderName: string;
    createdTime?: string;
    folderUrl: string;
};

export type DriveRestoreResult = {
    success: boolean;
    message: string;
    folderId: string;
    folderUrl: string;
    sessionName?: string;
    voiceName?: string;
    ttsModel?: string;
    history: ConversationItem[];
    audioRestoredCount: number;
    audioFailedCount: number;
};

const getHeaders = (accessToken: string, contentType: string = 'application/json') => {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': contentType,
    };
};

// --- Internal Drive Helpers ---

const findOrCreateFolder = async (name: string, accessToken: string, parentId?: string): Promise<string> => {
    let query = `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`;
    if (parentId) {
        query += ` and '${parentId}' in parents`;
    }

    const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}`, {
        headers: getHeaders(accessToken)
    });
    const searchData = await searchRes.json();

    if (searchData.files && searchData.files.length > 0) {
        return searchData.files[0].id;
    }

    const metaData: any = {
        name: name,
        mimeType: 'application/vnd.google-apps.folder'
    };
    if (parentId) {
        metaData.parents = [parentId];
    }

    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: getHeaders(accessToken),
        body: JSON.stringify(metaData)
    });
    const createData = await createRes.json();
    return createData.id;
};

const findFolderId = async (name: string, accessToken: string, parentId?: string): Promise<string | null> => {
    let query = `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`;
    if (parentId) {
        query += ` and '${parentId}' in parents`;
    }

    const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`, {
        headers: getHeaders(accessToken)
    });
    const searchData = await searchRes.json();
    if (searchData.files && searchData.files.length > 0) {
        return searchData.files[0].id;
    }
    return null;
};

const uploadFile = async (name: string, mimeType: string, data: Blob, accessToken: string, parentId: string) => {
    const metadata = {
        name: name,
        parents: [parentId]
    };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', data);

    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`
        },
        body: form
    });

    return await res.json();
};

const listFolderChildren = async (accessToken: string, parentId: string, qExtra?: string, pageSize: number = 50) => {
    let query = `'${parentId}' in parents and trashed=false`;
    if (qExtra) {
        query += ` and ${qExtra}`;
    }

    const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&orderBy=createdTime desc&pageSize=${pageSize}&fields=files(id,name,mimeType,createdTime)`,
        { headers: getHeaders(accessToken) }
    );
    if (!res.ok) {
        throw new Error('Drive 목록 조회에 실패했습니다.');
    }
    const data = await res.json();
    return data.files || [];
};

const downloadDriveFileJson = async (accessToken: string, fileId: string): Promise<any> => {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!res.ok) {
        throw new Error('Drive 파일 다운로드에 실패했습니다.');
    }
    return await res.json();
};

const downloadDriveFileArrayBuffer = async (accessToken: string, fileId: string): Promise<ArrayBuffer> => {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!res.ok) {
        throw new Error('Drive 파일 다운로드에 실패했습니다.');
    }
    return await res.arrayBuffer();
};

// --- Main Drive Functions ---

export const listDriveSessions = async (accessToken: string, limit: number = 20): Promise<DriveSessionInfo[]> => {
    const rootId = await findFolderId('Global Classroom', accessToken);
    if (!rootId) return [];

    const dateFolders = await listFolderChildren(accessToken, rootId, "mimeType='application/vnd.google-apps.folder'", 20);

    const sessions: DriveSessionInfo[] = [];
    for (const dateFolder of dateFolders) {
        if (sessions.length >= limit) break;
        const children = await listFolderChildren(
            accessToken,
            dateFolder.id,
            "mimeType='application/vnd.google-apps.folder' and name contains 'Session_'",
            limit
        );

        for (const s of children) {
            sessions.push({
                folderId: s.id,
                folderName: s.name,
                createdTime: s.createdTime,
                folderUrl: `https://drive.google.com/drive/folders/${s.id}`,
            });
            if (sessions.length >= limit) break;
        }
    }

    return sessions;
};

export const restoreDriveSession = async (accessToken: string, sessionFolderId: string, includeAudio: boolean): Promise<DriveRestoreResult> => {
    const folderUrl = `https://drive.google.com/drive/folders/${sessionFolderId}`;

    const files = await listFolderChildren(accessToken, sessionFolderId, "mimeType!='application/vnd.google-apps.folder'", 50);
    const transcriptFile = (files || []).find((f: any) => f.name === 'transcript.json');
    const manifestFile = (files || []).find((f: any) => f.name === 'manifest.json');

    if (!transcriptFile) {
        return {
            success: false,
            message: 'transcript.json을 찾지 못했습니다.',
            folderId: sessionFolderId,
            folderUrl,
            history: [],
            audioRestoredCount: 0,
            audioFailedCount: 0,
        };
    }

    const transcriptJson = await downloadDriveFileJson(accessToken, transcriptFile.id);
    const rawHistory = Array.isArray(transcriptJson?.history) ? transcriptJson.history : [];
    const history: ConversationItem[] = rawHistory.map((x: any) => ({
        id: String(x.id),
        original: String(x.original || ''),
        translated: String(x.translated || ''),
        isTranslating: false,
        timestamp: Number(x.timestamp || Date.now()),
    }));

    if (!includeAudio) {
        return {
            success: true,
            message: '대화 복원을 완료했습니다.',
            folderId: sessionFolderId,
            folderUrl,
            sessionName: transcriptJson?.sessionName,
            voiceName: undefined,
            ttsModel: undefined,
            history,
            audioRestoredCount: 0,
            audioFailedCount: 0,
        };
    }

    if (!manifestFile) {
        return {
            success: true,
            message: '대화 복원을 완료했습니다. (manifest.json 없음)',
            folderId: sessionFolderId,
            folderUrl,
            sessionName: transcriptJson?.sessionName,
            voiceName: undefined,
            ttsModel: undefined,
            history,
            audioRestoredCount: 0,
            audioFailedCount: 0,
        };
    }

    const manifestJson = await downloadDriveFileJson(accessToken, manifestFile.id);
    const items = Array.isArray(manifestJson?.items) ? manifestJson.items : [];

    const manifestVoiceName = typeof manifestJson?.voiceName === 'string' ? manifestJson.voiceName : 'Kore';
    const manifestTtsModel = typeof manifestJson?.ttsModel === 'string' ? manifestJson.ttsModel : 'gemini-2.5-flash-preview-tts';

    const byId = new Map(history.map((h) => [h.id, h] as const));
    let audioRestoredCount = 0;
    let audioFailedCount = 0;

    for (const item of items) {
        const id = String(item?.id || '');
        const audioFileId = item?.audio?.fileId;
        if (!id || !audioFileId) continue;
        const target = byId.get(id);
        if (!target) continue;

        try {
            const itemVoiceName = typeof item?.audio?.voiceName === 'string' ? item.audio.voiceName : manifestVoiceName;
            const itemTtsModel = typeof item?.audio?.ttsModel === 'string' ? item.audio.ttsModel : manifestTtsModel;
            const cacheKey = `${id}:${itemVoiceName}:${itemTtsModel}`;
            const cached = await getCachedAudioBase64(cacheKey);
            if (cached) {
                target.audioBase64 = cached;
                audioRestoredCount += 1;
                continue;
            }
        } catch {
        }

        try {
            const wavBuf = await downloadDriveFileArrayBuffer(accessToken, audioFileId);
            const pcm = wavArrayBufferToPcmBase64(wavBuf);
            if (pcm.base64) {
                target.audioBase64 = pcm.base64;
                audioRestoredCount += 1;
            } else {
                audioFailedCount += 1;
            }
        } catch (e) {
            console.error('오디오 복원 실패', e);
            audioFailedCount += 1;
        }
    }

    return {
        success: true,
        message: '대화/음성 복원을 완료했습니다.',
        folderId: sessionFolderId,
        folderUrl,
        sessionName: manifestJson?.sessionName,
        voiceName: manifestJson?.voiceName,
        ttsModel: manifestJson?.ttsModel,
        history: Array.from(byId.values()),
        audioRestoredCount,
        audioFailedCount,
    };
};

export const backupToDrive = async (accessToken: string, history: ConversationItem[], options?: DriveBackupOptions): Promise<DriveBackupResult> => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const now = new Date();
        const sessionName = `Session_${now.toISOString().replace(/[:.]/g, '-')}`;
        let rootFolderName = 'Global Classroom';
        if (options?.notebookLMMode) {
            rootFolderName = 'NotebookLM Sources (Global Classroom)';
        }

        const rootId = await findOrCreateFolder(rootFolderName, accessToken);
        const dateFolderId = await findOrCreateFolder(today, accessToken, rootId);
        const sessionFolderId = await findOrCreateFolder(sessionName, accessToken, dateFolderId);

        const includeAudio = options?.includeAudio !== false;
        const generateMissingAudio = options?.generateMissingAudio !== false;
        const voiceName = options?.voiceName || 'Kore';
        const ttsModel = options?.ttsModel || 'gemini-2.5-flash-preview-tts';

        const folderUrl = `https://drive.google.com/drive/folders/${sessionFolderId}`;

        const transcript = {
            app: 'Global Classroom',
            createdAt: now.toISOString(),
            date: today,
            history: history.map(({ audioBase64, ...rest }) => rest),
        };

        let textContent = 'Global Classroom - Translation Log\n';
        textContent += `Date: ${today}\n`;
        textContent += `Session: ${sessionName}\n\n`;
        history.forEach((item) => {
            textContent += `[${new Date(item.timestamp).toLocaleTimeString()}]\n`;
            textContent += `Original: ${item.original}\n`;
            textContent += `Translated: ${item.translated}\n\n`;
        });

        const transcriptBlob = new Blob([textContent], { type: 'text/plain' });
        const transcriptJsonBlob = new Blob([JSON.stringify(transcript, null, 2)], { type: 'application/json' });

        const transcriptRes = await uploadFile('transcript.txt', 'text/plain', transcriptBlob, accessToken, sessionFolderId);
        const transcriptJsonRes = await uploadFile('transcript.json', 'application/json', transcriptJsonBlob, accessToken, sessionFolderId);

        let audioFolderId: string | undefined;
        if (includeAudio) {
            audioFolderId = await findOrCreateFolder('audio', accessToken, sessionFolderId);
        }

        let audioUploadedCount = 0;
        let audioFailedCount = 0;

        const manifestItems: Array<any> = [];

        for (let i = 0; i < history.length; i++) {
            const item = history[i];
            const manifestItem: any = {
                id: item.id,
                timestamp: item.timestamp,
                original: item.original,
                translated: item.translated,
            };

            if (includeAudio && audioFolderId && item.translated) {
                const order = String(i + 1).padStart(4, '0');
                const fileName = `${order}_${item.id}.wav`;

                let audioBase64 = item.audioBase64;
                if (!audioBase64 && generateMissingAudio) {
                    audioBase64 = await generateTtsBase64(item.translated, voiceName, ttsModel);
                }

                if (audioBase64) {
                    try {
                        const wavBlob = pcm16Base64ToWavBlob(audioBase64, 24000, 1);
                        const uploadRes = await uploadFile(fileName, 'audio/wav', wavBlob, accessToken, audioFolderId);
                        manifestItem.audio = {
                            fileId: uploadRes?.id,
                            fileName,
                            mimeType: 'audio/wav',
                            voiceName,
                            ttsModel,
                            sampleRate: 24000,
                            channels: 1,
                        };
                        audioUploadedCount += 1;
                    } catch (e) {
                        console.error('Drive 오디오 업로드 실패', e);
                        audioFailedCount += 1;
                    }
                } else {
                    manifestItem.audio = {
                        missing: true,
                        voiceName,
                        ttsModel,
                    };
                    audioFailedCount += 1;
                }
            }

            manifestItems.push(manifestItem);
        }

        const manifest = {
            app: 'Global Classroom',
            notebookLMReady: options?.notebookLMMode,
            createdAt: now.toISOString(),
            date: today,
            sessionName,
            folderId: sessionFolderId,
            folderUrl,
            includeAudio,
            voiceName,
            ttsModel,
            items: manifestItems,
        };

        const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
        const manifestRes = await uploadFile('manifest.json', 'application/json', manifestBlob, accessToken, sessionFolderId);

        return {
            success: true,
            message: 'Backup complete.',
            folderId: sessionFolderId,
            folderUrl,
            transcriptFileId: transcriptRes?.id,
            transcriptJsonFileId: transcriptJsonRes?.id,
            manifestFileId: manifestRes?.id,
            audioFolderId,
            audioUploadedCount,
            audioFailedCount,
        };

    } catch (error) {
        console.error("Drive Backup Error", error);
        throw error;
    }
};
