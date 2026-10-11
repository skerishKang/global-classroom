import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTranscribeAccountAvailability, getTranscribeKey, parseTranscribeAccount } from '../../netlify/functions/_transcribeAccounts';

afterEach(() => vi.unstubAllEnvs());

describe('Transcribe account credentials', () => {
  it('keeps existing default key as account 1', () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-default-credential');
    vi.stubEnv('GEMINI_API_KEY_ACCOUNT_1', '');
    vi.stubEnv('GEMINI_API_KEY_ACCOUNT_2', '');
    expect(getTranscribeKey('1')).toBe('test-default-credential');
    expect(getTranscribeKey('2')).toBe('');
    expect(getTranscribeAccountAvailability()).toEqual({ '1': true, '2': false });
  });

  it('never silently falls back from account 2 to account 1', () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-default-credential');
    vi.stubEnv('GEMINI_API_KEY_ACCOUNT_2', 'test-second-credential');
    expect(getTranscribeKey('2')).toBe('test-second-credential');
    expect(getTranscribeAccountAvailability()['2']).toBe(true);
  });

  it('rejects unsupported account selection', () => {
    expect(parseTranscribeAccount('3')).toBeNull();
    expect(parseTranscribeAccount('2')).toBe('2');
    expect(parseTranscribeAccount(undefined)).toBe('1');
  });
});
