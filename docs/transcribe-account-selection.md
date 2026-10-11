# Transcribe — Google API account selection

The Transcribe page supports account 1 and account 2. This is **only for the Transcribe page**; Global Classroom and Interview retain their existing authentication paths.

- **Account 1:** Uses `GEMINI_API_KEY_ACCOUNT_1` when present, otherwise the deployed `GEMINI_API_KEY` or `API_KEY`. No new key is needed for the existing account.
- **Account 2:** Uses **only** `GEMINI_API_KEY_ACCOUNT_2`. The account 2 control is rendered but disabled when that variable is unset. It never silently falls back to account 1.

Later activation:
1. In the **7-global-classroom** Netlify site, set `GEMINI_API_KEY_ACCOUNT_2` as a secret environment variable available to Functions. Do **not** put its value in GitHub, `netlify.toml`, browser source, or client-side build variables.
2. Trigger a new Netlify production deployment to apply the environment change.
3. Open `/transcribe`, click **연결 상태 확인**, and select account 2 once it is enabled.
4. Run one authorized file/live request to confirm actual Gemini model access. The status endpoint checks only whether a key is **configured**, not whether it is valid, billable, or within quota.

The GET `/api/transcribe-accounts` endpoint returns only two configured/unconfigured booleans and no credentials. Both POST `/api/transcribe-file` and live token generation route the selected account on the server; an unconfigured account 2 fails closed. Switching is disabled during active recording/processing. Browser-local file request counters are kept separately per account; these are **not** authoritative Google project quotas.

Existing Netlify credentials are not changed by this feature.
