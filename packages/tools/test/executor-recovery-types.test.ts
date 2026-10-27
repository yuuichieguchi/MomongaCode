import { describe, expectTypeOf, it } from 'vitest';
import type { ExecutionBatchInput, ReconcileContext, RecoveryBatchInput } from '@momonga/tools';

describe('recovery types', () => {
  it('ReconcileContext names no sandbox and no sandbox policy', () => {
    expectTypeOf<ReconcileContext>().not.toHaveProperty('sandbox');
    expectTypeOf<ReconcileContext>().not.toHaveProperty('sandboxPolicy');
  });

  it('RecoveryBatchInput carries no sandbox and only empty rules', () => {
    expectTypeOf<RecoveryBatchInput>().not.toHaveProperty('sandbox');
    expectTypeOf<RecoveryBatchInput>().not.toHaveProperty('sandboxPolicy');
    expectTypeOf<RecoveryBatchInput['rules']>().toEqualTypeOf<readonly []>();
    expectTypeOf<RecoveryBatchInput['recoverOnly']>().toEqualTypeOf<true>();
  });

  it('a RecoveryBatchInput and an ExecutionBatchInput are not assignable to each other', () => {
    expectTypeOf<RecoveryBatchInput>().not.toExtend<ExecutionBatchInput>();
    expectTypeOf<ExecutionBatchInput>().not.toExtend<RecoveryBatchInput>();
  });
});
