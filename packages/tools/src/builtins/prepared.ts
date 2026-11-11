import type { ToolIdempotencyRecord } from '../ports.ts';
import type { ReconcileContext, ReconcileResult } from '../types.ts';
import { appliedDiffOf } from './applied-diff.ts';
import type { AppliedDiff } from './applied-diff.ts';
import { hashOfFileIfExists } from './files.ts';
import { shownPath } from './paths.ts';

export type PreparedWrite = { path: string; preHash: string | null; postHash: string; diff?: AppliedDiff };

export const parsePreparedWrite = (value: unknown): PreparedWrite => {
  if (typeof value !== 'object' || value === null) throw new TypeError('prepared state is missing');
  const { path, preHash, postHash, diff: recorded } = value as Record<string, unknown>;
  if (typeof path !== 'string' || typeof postHash !== 'string' || (preHash !== null && typeof preHash !== 'string')) {
    throw new TypeError('prepared state is malformed');
  }
  if (recorded === undefined) return { path, preHash, postHash };
  const diff = appliedDiffOf(recorded);
  if (diff === undefined) throw new TypeError('prepared state is malformed: its diff is not a diff');
  return { path, preHash, postHash, diff };
};

export const reconcileWrite = async (record: ToolIdempotencyRecord, label: string, ctx: ReconcileContext, requested: string): Promise<ReconcileResult> => {
  const prepared = parsePreparedWrite(record.meta['prepared']);
  const shown = await shownPath(ctx, requested);
  const current = await hashOfFileIfExists(ctx.files, prepared.path);
  if (current === prepared.postHash) return { outcome: 'already_applied', output: `${label} to ${shown} had already been applied`, ...prepared.diff };
  if (current === prepared.preHash) return { outcome: 'not_applied', output: '' };
  return {
    outcome: 'unknown',
    output: `${shown} matches neither the state before nor after the interrupted ${label}; inspect it before retrying.`,
  };
};
