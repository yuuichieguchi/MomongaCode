import type { PermissionOption } from '@momonga/protocol';
import type { Approval, Claim, RuntimeStore } from '@momonga/store';
import { START_MS, callEvent, enqueue, mustClaim, newSession } from './helpers.ts';

export const OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];
export const DIGEST = 'a'.repeat(64);
export const EXPIRES_MS = START_MS + 60_000;

export type Awaiting = { runId: string; sessionId: string; claim: Claim; approvals: Approval[] };

export const requestFor = (store: RuntimeStore, claim: Claim, callId: string, expiresAt = EXPIRES_MS, subjectDigest = DIGEST): Approval => {
  const result = store.requestApproval(claim, { callId, options: OPTIONS, expiresAt, event: { subjectDigest, suggestedRule: `Write(/work/a/${callId}.txt)`, reason: 'edits require approval' } });
  if (result.kind !== 'ok') throw new Error(`expected an approval for ${callId}, got ${result.kind}`);
  return result.approval;
};

export const awaitingApproval = (
  store: RuntimeStore,
  calls: readonly { callId: string; expiresAt?: number }[],
  end: 'running' | 'waiting',
): Awaiting => {
  const session = newSession(store);
  const run = enqueue(store, session.id);
  const claim = mustClaim(store, 'worker-1');
  const appended = store.append(claim, calls.map((call) => callEvent(call.callId)));
  if (appended.kind !== 'ok') throw new Error('expected the tool calls to be appended');
  const approvals = calls.map((call) => requestFor(store, claim, call.callId, call.expiresAt));
  if (end === 'waiting') {
    const released = store.release(claim, 'WAITING_HUMAN');
    if (released.kind !== 'ok') throw new Error('expected the run to be released to WAITING_HUMAN');
  }
  return { runId: run.id, sessionId: session.id, claim, approvals };
};

export const parkWaitingHuman = (store: RuntimeStore, claim: Claim): Approval => {
  const callId = `park-${claim.leaseToken}`;
  const appended = store.append(claim, [callEvent(callId)]);
  if (appended.kind !== 'ok') throw new Error('expected the parking call to be appended');
  const approval = requestFor(store, claim, callId);
  const released = store.release(claim, 'WAITING_HUMAN');
  if (released.kind !== 'ok' || released.run.status !== 'WAITING_HUMAN') throw new Error('expected the run to park in WAITING_HUMAN');
  return approval;
};
