import type { ElicitationRequestView, PermissionOption } from '@momonga/protocol';
import type { Approval, Claim, RuntimeStore } from '@momonga/store';
import { START_MS, callEvent, enqueue, mustClaim, newSession } from './helpers.ts';

export const OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];
export const DIGEST = 'a'.repeat(64);
export const EXPIRES_MS = START_MS + 60_000;
export const INPUT_REQUESTS: ElicitationRequestView[] = [{ key: 'who', mode: 'form', message: 'Who?', requestedSchema: { type: 'object' } }];

export type Awaiting = { runId: string; sessionId: string; claim: Claim; approvals: Approval[] };

export const requestFor = async (store: RuntimeStore, claim: Claim, callId: string, subjectDigest = DIGEST): Promise<Approval> => {
  const result = await store.requestApproval(claim, { callId, options: OPTIONS, event: { subjectDigest, suggestedRule: `Write(/work/a/${callId}.txt)`, reason: 'edits require approval', shown: { title: 'approval', input: {} } } });
  if (result.kind !== 'ok') throw new Error(`expected an approval for ${callId}, got ${result.kind}`);
  return result.approval;
};

export const inputFor = async (store: RuntimeStore, claim: Claim, callId: string, expiresAt = EXPIRES_MS): Promise<Approval> => {
  const result = await store.requestElicitation(claim, { callId, expiresAt, server: 'remote', requests: INPUT_REQUESTS });
  if (result.kind !== 'ok') throw new Error(`expected a request for input for ${callId}, got ${result.kind}`);
  return result.approval;
};

const awaiting = async <Call extends { callId: string }>(
  store: RuntimeStore,
  calls: readonly Call[],
  end: 'running' | 'waiting',
  ask: (claim: Claim, call: Call) => Promise<Approval>,
): Promise<Awaiting> => {
  const session = newSession(store);
  const run = await enqueue(store, session.id);
  const claim = mustClaim(store, 'worker-1');
  const appended = store.append(claim, calls.map((call) => callEvent(call.callId)));
  if (appended.kind !== 'ok') throw new Error('expected the tool calls to be appended');
  const approvals: Approval[] = [];
  for (const call of calls) approvals.push(await ask(claim, call));
  if (end === 'waiting') {
    const released = await store.release(claim, 'WAITING_HUMAN');
    if (released.kind !== 'ok') throw new Error('expected the run to be released to WAITING_HUMAN');
  }
  return { runId: run.id, sessionId: session.id, claim, approvals };
};

export const awaitingApproval = async (store: RuntimeStore, calls: readonly { callId: string }[], end: 'running' | 'waiting'): Promise<Awaiting> =>
  await awaiting(store, calls, end, (claim, call) => requestFor(store, claim, call.callId));

export const awaitingInput = async (store: RuntimeStore, calls: readonly { callId: string; expiresAt?: number }[], end: 'running' | 'waiting'): Promise<Awaiting> =>
  await awaiting(store, calls, end, (claim, call) => inputFor(store, claim, call.callId, call.expiresAt));

export const parkWaitingHuman = async (store: RuntimeStore, claim: Claim): Promise<Approval> => {
  const callId = `park-${claim.leaseToken}`;
  const appended = store.append(claim, [callEvent(callId)]);
  if (appended.kind !== 'ok') throw new Error('expected the parking call to be appended');
  const approval = await requestFor(store, claim, callId);
  const released = await store.release(claim, 'WAITING_HUMAN');
  if (released.kind !== 'ok' || released.run.status !== 'WAITING_HUMAN') throw new Error('expected the run to park in WAITING_HUMAN');
  return approval;
};
