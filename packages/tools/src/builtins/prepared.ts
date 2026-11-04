import type { ToolIdempotencyRecord } from '../ports.ts';
import type { ReconcileContext, ReconcileResult } from '../types.ts';
import { hashOfFileIfExists } from './files.ts';
import { shownPath } from './paths.ts';

export type PreparedWrite = { path: string; preHash: string | null; postHash: string };

export const parsePreparedWrite = (value: unknown): PreparedWrite => {
  if (typeof value !== 'object' || value === null) throw new TypeError('prepared state is missing');
  const { path, preHash, postHash } = value as Record<string, unknown>;
  if (typeof path !== 'string' || typeof postHash !== 'string' || (preHash !== null && typeof preHash !== 'string')) {
    throw new TypeError('prepared state is malformed');
  }
  return { path, preHash, postHash };
};

export const reconcileWrite = async (record: ToolIdempotencyRecord, label: string, ctx: ReconcileContext): Promise<ReconcileResult> => {
  const prepared = parsePreparedWrite(record.meta['prepared']);
  const shown = shownPath(ctx, prepared.path);
  const current = await hashOfFileIfExists(prepared.path);
  if (current === prepared.postHash) return { outcome: 'already_applied', output: `${label} to ${shown} had already been applied` };
  if (current === prepared.preHash) return { outcome: 'not_applied', output: '' };
  return {
    outcome: 'unknown',
    output: `${shown} matches neither the state before nor after the interrupted ${label}; inspect it before retrying.`,
  };
};
