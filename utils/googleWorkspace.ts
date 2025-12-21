import { ConversationItem } from '../types';

export * from './googleDrive';
export * from './googleDocs';
export * from './googleClassroom';
export * from './tts';

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