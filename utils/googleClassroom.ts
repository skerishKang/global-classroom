import { ConversationItem } from '../types';

const getHeaders = (accessToken: string, contentType: string = 'application/json') => {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': contentType,
    };
};

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
