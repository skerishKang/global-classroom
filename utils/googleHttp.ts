/**
 * Minimal Google API HTTP guard shared by the Drive/Docs/Classroom clients.
 *
 * Every Google API call must verify the HTTP status before its payload is used;
 * without this a 403/500 response silently produced "successful" exports that
 * had actually written nothing (#35). Error bodies are parsed defensively and
 * only a short message is surfaced — raw responses can echo request metadata
 * and are never shown to the user as-is.
 */

export class GoogleHttpError extends Error {
    readonly status: number;
    readonly operation: string;

    constructor(operation: string, status: number, detail?: string) {
        super(`Google ${operation} 요청이 실패했습니다. (${status})${detail ? ` ${detail}` : ''}`);
        this.name = 'GoogleHttpError';
        this.status = status;
        this.operation = operation;
    }
}

const extractDetail = (body: unknown): string => {
    if (!body || typeof body !== 'object') return '';
    const record = body as Record<string, unknown>;
    const candidates = [
        record.error,
        record.message,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 200);
        if (candidate && typeof candidate === 'object') {
            const message = (candidate as Record<string, unknown>).message;
            if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 200);
        }
    }
    return '';
};

/** Throws a sanitized GoogleHttpError when the response is not ok. */
export const requireGoogleOk = async (response: Response, operation: string): Promise<Response> => {
    if (response.ok) return response;
    let detail = '';
    try {
        detail = extractDetail(await response.clone().json());
    } catch {
        // Body was empty or not JSON — the status alone is surfaced.
    }
    throw new GoogleHttpError(operation, response.status, detail);
};

/** requireGoogleOk + JSON parsing for the common payload path. */
export const requireGoogleJson = async <T = any>(response: Response, operation: string): Promise<T> => {
    const ok = await requireGoogleOk(response, operation);
    return await ok.json() as T;
};
