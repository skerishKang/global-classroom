import { describe, expect, test } from 'vitest';

// Throwaway probe for issue #98. It exists only to make the `verify` check red
// on a disposable branch, proving that the main-verify-gate ruleset blocks a
// merge instead of merely running the check. This file is never merged: the
// probe branch and PR are closed and deleted immediately after the result is
// recorded.
describe('CI ruleset blocking probe', () => {
  test('intentionally fails so the verify check is red', () => {
    expect('probe').toBe('failing-on-purpose');
  });
});
