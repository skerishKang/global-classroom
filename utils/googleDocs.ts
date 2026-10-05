import { ConversationItem } from '../types';
import { requireGoogleJson, requireGoogleOk } from './googleHttp';

const getHeaders = (accessToken: string, contentType: string = 'application/json') => {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': contentType,
    };
};

const GOOGLE_DOC_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

/** Canonical Docs URL built only from a validated document id. */
export const buildGoogleDocsDocumentUrl = (docId: unknown): string | null =>
    typeof docId === 'string' && GOOGLE_DOC_ID_PATTERN.test(docId)
        ? `https://docs.google.com/document/d/${docId}/edit`
        : null;

/**
 * Destination metadata for the export result surface (#66). `documentUrl` is
 * derived from `docId` by the canonical builder, so the caller never has to
 * trust a URL handed to it from elsewhere.
 */
export type DocsExportResult = {
    success: boolean;
    docId: string;
    documentUrl: string | null;
    title: string;
    message: string;
};

export const exportToDocs = async (accessToken: string, history: ConversationItem[]): Promise<DocsExportResult> => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const title = `Global Classroom Notes - ${today}`;

        // Both steps must succeed for the export to be reported as success:
        // a created-but-empty document must never be sold as a completed
        // export (#35). If the create fails, batchUpdate is never attempted.
        const createRes = await fetch('https://docs.googleapis.com/v1/documents', {
            method: 'POST',
            headers: getHeaders(accessToken),
            body: JSON.stringify({ title: title })
        });
        const docData = await requireGoogleJson<{ documentId?: string }>(createRes, 'Docs 문서 생성');
        const docId = docData.documentId;
        if (!docId) {
            throw new Error('Docs 문서 생성 응답에 documentId가 없습니다.');
        }

        let contentString = "";
        history.forEach(item => {
            contentString += `Time: ${new Date(item.timestamp).toLocaleTimeString()}\n`;
            contentString += `Original: ${item.original}\n`;
            contentString += `Translation: ${item.translated}\n`;
            contentString += `----------------------------------------\n`;
        });

        const finalBody = `Translation Notes - ${today}\n\n${contentString}`;

        const batchRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
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
        await requireGoogleOk(batchRes, 'Docs 내용 쓰기');

        return {
            success: true,
            docId: docId,
            documentUrl: buildGoogleDocsDocumentUrl(docId),
            title: title,
            message: "Document created successfully.",
        };

    } catch (error) {
        console.error("Docs Export Error", error);
        throw error;
    }
};
