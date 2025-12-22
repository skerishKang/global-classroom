import { useState, useRef } from 'react';
import { backupToDrive, exportToDocs, listCourses, createCourseWork } from '../utils/googleWorkspace';
import { downloadTranscriptLocally } from '../utils/fileExport';
import { ConversationItem, TranslationMap, VoiceOption } from '../types';
import { MODEL_TTS } from '../constants';

interface UseExportProps {
    accessToken: string | null;
    history: ConversationItem[];
    selectedVoice: VoiceOption;
    t: TranslationMap;
    setIsLoginModalOpen: (v: boolean) => void;
}

export function useExport({ accessToken, history, selectedVoice, t, setIsLoginModalOpen }: UseExportProps) {
    const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [isClassroomModalOpen, setIsClassroomModalOpen] = useState(false);
    const [isNotebookLMGuideOpen, setIsNotebookLMGuideOpen] = useState(false);
    const [courses, setCourses] = useState<any[]>([]);
    const [isLoadingCourses, setIsLoadingCourses] = useState(false);

    const exportMenuRef = useRef<HTMLDivElement>(null);

    const fetchCourses = async () => {
        if (!accessToken) return;
        setIsLoadingCourses(true);
        try {
            const list = await listCourses(accessToken);
            setCourses(list);
        } catch (e) {
            console.error("Failed to fetch courses", e);
            window.open('https://classroom.google.com', '_blank');
            setIsClassroomModalOpen(false);
        } finally {
            setIsLoadingCourses(false);
        }
    };

    const handleExport = async (type: 'drive' | 'docs' | 'classroom' | 'notebooklm') => {
        setIsExportMenuOpen(false);
        if ((type === 'drive' || type === 'classroom' || type === 'notebooklm') && !accessToken) {
            setIsLoginModalOpen(true);
            return;
        }

        setIsExporting(true);
        try {
            if (type === 'drive') {
                const result = await backupToDrive(accessToken!, history, {
                    includeAudio: true,
                    generateMissingAudio: true,
                    voiceName: selectedVoice.name,
                    ttsModel: MODEL_TTS,
                });
                if (result?.folderUrl) window.open(result.folderUrl, '_blank');
                alert(`Drive: ${t.exportSuccess}`);
            } else if (type === 'notebooklm') {
                const result = await backupToDrive(accessToken!, history, {
                    includeAudio: false,
                    generateMissingAudio: false,
                    notebookLMMode: true,
                });
                if (result?.folderUrl) window.open(result.folderUrl, '_blank');
                setIsNotebookLMGuideOpen(true);
            } else if (type === 'docs') {
                if (accessToken) {
                    await exportToDocs(accessToken, history);
                    alert(`Docs: ${t.exportSuccess}`);
                } else {
                    downloadTranscriptLocally(history);
                    alert(t.offlineMode);
                }
            } else if (type === 'classroom') {
                setIsClassroomModalOpen(true);
                fetchCourses();
            }
        } catch (e) {
            console.error("Export failed", e);
            if (type === 'docs') {
                downloadTranscriptLocally(history);
                alert(t.offlineMode);
            } else {
                alert("Error: " + (e as Error).message);
            }
        } finally {
            setIsExporting(false);
        }
    };

    const handleSubmitCourseWork = async (courseId: string) => {
        if (!accessToken) return;
        setIsExporting(true);
        try {
            await createCourseWork(accessToken, courseId, history);
            alert(t.exportSuccess);
            setIsClassroomModalOpen(false);
        } catch (e) {
            console.error(e);
            alert("Failed to submit to Classroom");
        } finally {
            setIsExporting(false);
        }
    };

    return {
        isExportMenuOpen,
        setIsExportMenuOpen,
        isExporting,
        isClassroomModalOpen,
        setIsClassroomModalOpen,
        isNotebookLMGuideOpen,
        setIsNotebookLMGuideOpen,
        courses,
        isLoadingCourses,
        exportMenuRef,
        handleExport,
        handleSubmitCourseWork
    };
}
