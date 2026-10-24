import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import * as runtime from '@momonga/runtime';

describe('runtime re-exports the foundation process contract', () => {
  it('runtimeMaxCloseMs is the foundation function', () => {
    expect(runtime.runtimeMaxCloseMs).toBe(foundation.runtimeMaxCloseMs);
  });

  it('the budgets equal the foundation budgets', () => {
    expect(runtime.RUNTIME_ABORT_BUDGET_MS).toBe(foundation.RUNTIME_ABORT_BUDGET_MS);
    expect(runtime.RUNTIME_TEARDOWN_BUDGET_MS).toBe(foundation.RUNTIME_TEARDOWN_BUDGET_MS);
  });
});
