// Only the Netlify Function runtime can access the actual API keys.
// Account 1 preserves the deployed default key unless explicitly overridden.
export type TranscribeAccount = '1' | '2';

export function parseTranscribeAccount(value: unknown): TranscribeAccount | null {
  if (value == null || value === '') return '1';
  return value === '1' || value === '2' ? value : null;
}

function serverKey(name: string): string {
  const netlify = (globalThis as any).Netlify?.env?.get?.(name);
  return (typeof netlify === 'string' ? netlify : process.env[name] || '').trim();
}

export function getTranscribeKey(account: TranscribeAccount): string {
  if (account === '2') return serverKey('GEMINI_API_KEY_ACCOUNT_2');
  return serverKey('GEMINI_API_KEY_ACCOUNT_1') || serverKey('GEMINI_API_KEY') || serverKey('API_KEY');
}

export function getTranscribeAccountAvailability() {
  return { '1': Boolean(getTranscribeKey('1')), '2': Boolean(getTranscribeKey('2')) };
}
