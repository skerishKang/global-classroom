import React, { useState, useCallback } from 'react';
import { listDriveSessions, restoreDriveSession } from '../utils/googleWorkspace';
import { ConversationItem } from '../types';

interface UseStorageProps {
    accessToken: string | null;
    setHistory: React.Dispatch<React.SetStateAction<ConversationItem[]>>;
    setCurrentSessionId: (id: string) => void;
    enqueueToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
}

export function useStorage({ accessToken, setHistory, setCurrentSessionId, enqueueToast }: UseStorageProps) {
    const [driveSessions, setDriveSessions] = useState<any[]>([]);
    const [isLoadingDriveSessions, setIsLoadingDriveSessions] = useState(false);
    const [selectedDriveSessionId, setSelectedDriveSessionId] = useState('');
    const [isRestoringDriveSession, setIsRestoringDriveSession] = useState(false);
    const [driveRestoreMessage, setDriveRestoreMessage] = useState('');
    const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
    const [selectedLocalSessionId, setSelectedLocalSessionId] = useState('');

    const handleOpenHistory = useCallback(async () => {
        setDriveRestoreMessage('');
        setSelectedDriveSessionId('');
        if (accessToken) {
            setIsLoadingDriveSessions(true);
            try {
                const list = await listDriveSessions(accessToken, 20);
                setDriveSessions(list || []);
            } catch (e) {
                console.error(e);
                setDriveSessions([]);
            } finally {
                setIsLoadingDriveSessions(false);
            }
        } else {
            setDriveSessions([]);
        }
        setIsHistoryModalOpen(true);
    }, [accessToken]);

    const handleRestoreFromDrive = async (includeAudio: boolean) => {
        if (!accessToken || !selectedDriveSessionId) return;
        setIsRestoringDriveSession(true);
        setDriveRestoreMessage('복원 중...');
        try {
            const result = await restoreDriveSession(accessToken, selectedDriveSessionId, includeAudio);
            // Discriminated contract (#35): the history is only ever replaced
            // after success. A failed restore must not be able to wipe the
            // current conversation, even if it returned an empty array.
            if (result.success) {
                setHistory(result.history);
                enqueueToast(result.message || '성공적으로 복원되었습니다.', 'success');
                setIsHistoryModalOpen(false);
            } else {
                enqueueToast(`복원 실패: ${result.message}`, 'error');
            }
        } catch (e) {
            console.error(e);
            enqueueToast('복원 중 오류가 발생했습니다.', 'error');
        } finally {
            setIsRestoringDriveSession(false);
            setDriveRestoreMessage('');
        }
    };

    return {
        driveSessions,
        isLoadingDriveSessions,
        selectedDriveSessionId,
        setSelectedDriveSessionId,
        isRestoringDriveSession,
        driveRestoreMessage,
        setDriveRestoreMessage,
        isHistoryModalOpen,
        setIsHistoryModalOpen,
        selectedLocalSessionId,
        setSelectedLocalSessionId,
        handleOpenHistory,
        handleRestoreFromDrive
    };
}
