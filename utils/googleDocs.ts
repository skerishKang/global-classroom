import { ConversationItem } from '../types';

const getHeaders = (accessToken: string, contentType: string = 'application/json') => {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': contentType,
    };
};

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
