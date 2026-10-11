import { getTranscribeAccountAvailability } from './_transcribeAccounts';

export default async (request: Request) => {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'GET만 지원합니다.' }), {
      status: 405, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  // Metadata only: never include raw credentials or their project identifiers.
  return new Response(JSON.stringify({ accounts: getTranscribeAccountAvailability(), defaultAccount: '1' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
};

export const config = { path: '/api/transcribe-accounts' };
