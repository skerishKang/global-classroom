import { ConversationItem } from '../types';
import { base64ToUint8Array } from './audioUtils';

// --- Helpers ---

type DriveBackupOptions = {
  includeAudio?: boolean;
  voiceName?: string;
  ttsModel?: string;
  generateMissingAudio?: boolean;
};

type DriveBackupResult = {
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

const getHeaders = (accessToken: string, contentType: string = 'application/json') => {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': contentType,
  };
};

// --- Local Offline Export Helpers ---

export const downloadTranscriptLocally = (history: ConversationItem[]) => {
  const today = new Date().toISOString().split('T')[0];
  let contentString = `Global Classroom - Translation Notes\nDate: ${today}\n\n`;

  history.forEach(item => {
    contentString += `[${new Date(item.timestamp).toLocaleTimeString()}]\n`;
    contentString += `Original: ${item.original}\n`;
    contentString += `Translated: ${item.translated}\n`;
    contentString += `----------------------------------------\n`;
  });

  const blob = new Blob([contentString], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `GlobalClassroom_Transcript_${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  return { success: true, local: true };
};

export const downloadBackupLocally = (history: ConversationItem[]) => {
  const backupData = {
    date: new Date().toISOString(),
    app: "Global Classroom",
    history: history.map(({ audioBase64, ...rest }) => rest) 
  };

  const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `GlobalClassroom_Backup_${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return { success: true, local: true };
};

// --- Drive API ---

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

const pcm16Base64ToWavBlob = (base64Pcm16: string, sampleRate = 24000, numChannels = 1): Blob => {
  const pcmBytes = base64ToUint8Array(base64Pcm16);

  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBytes.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer, 44).set(pcmBytes);
  return new Blob([buffer], { type: 'audio/wav' });
};

const generateTtsBase64 = async (text: string, voiceName: string, model: string): Promise<string | null> => {
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voiceName, model }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((json as any)?.error || 'TTS 요청에 실패했습니다.');
    }
    return typeof (json as any).audioBase64 === 'string' ? (json as any).audioBase64 : null;
  } catch (e) {
    console.error('TTS 생성 실패', e);
    return null;
  }
};

export const backupToDrive = async (accessToken: string, history: ConversationItem[], options?: DriveBackupOptions): Promise<DriveBackupResult> => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const now = new Date();
    const sessionName = `Session_${now.toISOString().replace(/[:.]/g, '-')}`;
    const rootId = await findOrCreateFolder('Global Classroom', accessToken);
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

// --- Docs API ---

export const exportToDocs = async (accessToken: string, history: ConversationItem[]) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const title = `Global Classroom Notes - ${today}`;

    const createRes = await fetch('https://docs.googleapis.com/v1/documents', {
      method: 'POST',
      headers: getHeaders(accessToken),
      body: JSON.stringify({ title: title })
    });
    const docData = await createRes.json();
    const docId = docData.documentId;

    let contentString = "";
    history.forEach(item => {
      contentString += `Time: ${new Date(item.timestamp).toLocaleTimeString()}\n`;
      contentString += `Original: ${item.original}\n`;
      contentString += `Translation: ${item.translated}\n`;
      contentString += `----------------------------------------\n`;
    });

    const finalBody = `Translation Notes - ${today}\n\n${contentString}`;

    await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
      method: 'POST',
      headers: getHeaders(accessToken),
      body: JSON.stringify({
        requests: [
            {
                insertText: {
                    location: { index: 1 },
                    text: finalBody
                }
            }
        ]
      })
    });

    return { success: true, docId: docId, message: "Document created successfully." };

  } catch (error) {
    console.error("Docs Export Error", error);
    throw error;
  }
};

// --- Classroom API ---

export const listCourses = async (accessToken: string) => {
  const res = await fetch('https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE', {
    headers: getHeaders(accessToken)
  });
  if (!res.ok) throw new Error('Failed to fetch courses');
  const data = await res.json();
  return data.courses || [];
};

export const createCourseWork = async (accessToken: string, courseId: string, history: ConversationItem[]) => {
  const today = new Date().toISOString().split('T')[0];
  let description = "Automatic translation notes from Global Classroom.\n\n";
  history.slice(0, 10).forEach(item => { // Preview only
    description += `${item.original} -> ${item.translated}\n`;
  });
  description += "\n(See attached or full transcript)";

  // Note: Creating a full text file and attaching it requires Drive upload then linking.
  // For simplicity in this demo, we create a 'Text' based assignment or Link.
  
  const body = {
    title: `Translation Notes ${today}`,
    description: description,
    workType: "ASSIGNMENT",
    state: "PUBLISHED",
  };

  const res = await fetch(`https://classroom.googleapis.com/v1/courses/${courseId}/courseWork`, {
    method: 'POST',
    headers: getHeaders(accessToken),
    body: JSON.stringify(body)
  });
  
  if (!res.ok) throw new Error('Failed to create coursework');
  return await res.json();
};