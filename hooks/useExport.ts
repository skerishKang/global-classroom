import { useState, useRef } from 'react';
import { backupToDrive, exportToDocs, listCourses, createCourseWork } from '../utils/googleWorkspace';
import { downloadTranscriptLocally } from '../utils/fileExport';
import {
    ExportResult,
    buildClassroomExportResult,
    buildDocsExportResult,
    buildDocsLocalFallbackResult,
    buildDriveExportResult,
    buildExportFailureResult,
    getExportResultMessages,
} from '../utils/exportResult';
import { AppSettings, ConversationItem, TranslationMap, VoiceOption } from '../types';
import { MODEL_TTS } from '../constants';

interface UseExportProps {
    accessToken: string | null;
    history: ConversationItem[];
    selectedVoice: VoiceOption;
    uiLangCode: string;
    t: TranslationMap;
    setIsLoginModalOpen: (v: boolean) => void;
    /** Settings carry the local-only personal key used by the backup TTS path. */
    settings: AppSettings;
}

export function useExport({ accessToken, history, selectedVoice, uiLangCode, t, setIsLoginModalOpen, settings }: UseExportProps) {
    const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [isClassroomModalOpen, setIsClassroomModalOpen] = useState(false);
    const [isNotebookLMGuideOpen, setIsNotebookLMGuideOpen] = useState(false);
    const [courses, setCourses] = useState<any[]>([]);
    const [isLoadingCourses, setIsLoadingCourses] = useState(false);
    // #66: export outcomes go to one actionable surface instead of a blocking
    // alert, so the destination stays openable without hijacking a tab.
    const [exportResult, setExportResult] = useState<ExportResult | null>(null);

    const exportMenuRef = useRef<HTMLDivElement>(null);

    const fetchCourses = async () => {
        if (!accessToken) return;
        setIsLoadingCourses(true);
        try {
            const list = await listCourses(accessToken);
            setCourses(list);
        } catch (e) {
            console.error("Failed to fetch courses", e);
            setExportResult(buildExportFailureResult('classroom', e, getExportResultMessages(uiLangCode, t)));
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

        const messages = getExportResultMessages(uiLangCode, t);

        setIsExporting(true);
        try {
            if (type === 'drive') {
                const result = await backupToDrive(accessToken!, history, {
                    includeAudio: true,
                    generateMissingAudio: true,
                    voiceName: selectedVoice.name,
                    ttsModel: MODEL_TTS,
                    userApiKey: settings.userApiKey || undefined,
                });
                // No automatic popup: the result surface offers the folder as an
                // explicit action the user chooses to follow (#66).
                setExportResult(buildDriveExportResult(result, messages));
            } else if (type === 'notebooklm') {
                const result = await backupToDrive(accessToken!, history, {
                    includeAudio: false,
                    generateMissingAudio: false,
                    notebookLMMode: true,
                    userApiKey: settings.userApiKey || undefined,
                });
                if (result?.folderUrl) window.open(result.folderUrl, '_blank');
                setIsNotebookLMGuideOpen(true);
            } else if (type === 'docs') {
                if (accessToken) {
                    const result = await exportToDocs(accessToken, history);
                    setExportResult(buildDocsExportResult(result, messages));
                } else {
                    downloadTranscriptLocally(history);
                    setExportResult(buildDocsLocalFallbackResult({ kind: 'signed-out' }, messages));
                }
            } else if (type === 'classroom') {
                setIsClassroomModalOpen(true);
                fetchCourses();
            }
        } catch (e) {
            console.error("Export failed", e);
            if (type === 'docs') {
                downloadTranscriptLocally(history);
                setExportResult(buildDocsLocalFallbackResult({ kind: 'failed', error: e }, messages));
            } else {
                setExportResult(buildExportFailureResult(type, e, messages));
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
            setIsClassroomModalOpen(false);
            setExportResult(buildClassroomExportResult(getExportResultMessages(uiLangCode, t)));
        } catch (e) {
            console.error(e);
            setExportResult(buildExportFailureResult('classroom', e, getExportResultMessages(uiLangCode, t)));
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
        exportResult,
        setExportResult,
        handleExport,
        handleSubmitCourseWork
    };
}
