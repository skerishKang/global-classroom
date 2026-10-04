import React, { useState, useCallback } from 'react';
import { listDriveSessions, restoreDriveSession } from '../utils/googleWorkspace';
import { DriveRestoreResult } from '../utils/googleWorkspace';
import { ConversationItem } from '../types';

/**
 * The restore branch extracted so the caller contract is unit-testable (#35):
 * history is replaced and the success toast shown ONLY when the result
 * discriminant says success. A failed restore — including a malformed
 * transcript.json — can never wipe the current conversation.
 */
export function applyRestoreResult(
    result: DriveRestoreResult,
    setHistory: React.Dispatch<React.SetStateAction<ConversationItem[]>>,
    enqueueToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void,
): boolean {
    if (result.success) {
        setHistory(result.history);
        enqueueToast(result.message || '성공적으로 복원되었습니다.', 'success');
        return true;
    }
    enqueueToast(`복원 실패: ${result.message}`, 'error');
    return false;
}

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
            // Discriminated contract (#35): applyRestoreResult only replaces
            // history after success; a failure keeps the current conversation.
            if (applyRestoreResult(result, setHistory, enqueueToast)) {
                setIsHistoryModalOpen(false);
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
