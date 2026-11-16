import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { PropertyFailure, forEachSeed, seedsFrom } from '@momonga/testkit';
import type { Generator } from '@momonga/testkit';
import { START_MS, makeEnv, toolKey } from './harness.ts';
import type { Env } from './harness.ts';
import { functionCallItem, requestedOffering, textStep } from './scripts.ts';

const PROPERTY_SEEDS = seedsFrom(1, 24);
const MOST_UNKNOWN_CALLS = 3;
const MOST_ACTIONS = 6;
const ACTIONS = ['claim', 'requeue', 'answer'] as const;
type Action = (typeof ACTIONS)[number];

type Journaled = { type: string; callIds?: readonly string[] };

const askViolations = (journal: readonly Journaled[]): string[] => {
  const violations: string[] = [];
  const asked: string[] = [];
  const acknowledged = new Set<string>();
  for (const event of journal) {
    if (event.type === 'tool.unknown.resolved') for (const callId of asked.at(-1)?.split(',') ?? []) acknowledged.add(callId);
    if (event.type !== 'tool.unknown.requested') continue;
    const set = [...(event.callIds ?? [])].sort().join(',');
    if (asked.includes(set) && !set.split(',').some((callId) => acknowledged.has(callId))) violations.push(`a second ask for the unacknowledged set ${set} (P-U2)`);
    if (set.split(',').some((callId) => acknowledged.has(callId))) violations.push(`an ask for ${set} after its acknowledgement (P-U3)`);
    asked.push(set);
  }
  return violations;
};

const interrupted = async (env: Env, count: number): Promise<string> => {
  const run = await env.enqueue('Write the files');
  const callIds = Array.from({ length: count }, (_, index) => `call_p_${index + 1}`);
  const targetOf = (callId: string): string => path.join(env.project, `${callId}.txt`);
  const payloads: RunEventPayload[] = [
    requestedOffering(1, ['Write']),
    {
      type: 'model.responded',
      step: 1,
      attempt: 1,
      response: { status: 'completed', output: callIds.map((callId) => functionCallItem({ callId, name: 'Write', args: { file_path: targetOf(callId), content: 'x' } })), usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } },
    },
    ...callIds.flatMap((callId): RunEventPayload[] => [
      { type: 'tool.call', callId, providerCallId: callId, name: 'Write', kind: 'edit', title: `Write ${targetOf(callId)}`, rawInput: { file_path: targetOf(callId), content: 'x' } },
      { type: 'tool.started', callId, idemKey: toolKey(run.id, 1, callId) },
    ]),
  ];
  await env.seed(run.id, payloads, 'crash');
  for (const callId of callIds) env.store.idempotency.begin(toolKey(run.id, 1, callId), { expiresAt: START_MS + 86_400_000, meta: { tool: 'Write' } });
  return run.id;
};

const act = async (env: Env, runId: string, action: Action, round: number): Promise<void> => {
  if (action === 'answer') {
    const [pending] = env.store.approvals.listPending(runId);
    if (pending !== undefined) expect((await env.store.resolveApproval(pending.id, 'allow_once')).kind).toBe('ok');
    return;
  }
  if (action === 'requeue' && env.run(runId).status === 'WAITING_HUMAN') env.raw().prepare("UPDATE runs SET status = 'QUEUED' WHERE id = ?").run(runId);
  if (env.run(runId).status !== 'QUEUED') return;
  env.gateway.script.push(textStep('Checked.'));
  await env.runOnce(env.worker(`worker-${round}`));
};

const recoveries = async (generator: Generator): Promise<void> => {
  const env = await makeEnv({ mode: 'acceptEdits' });
  const runId = await interrupted(env, 1 + generator.below(MOST_UNKNOWN_CALLS));
  const actions = Array.from({ length: 1 + generator.below(MOST_ACTIONS) }, () => generator.pick(ACTIONS));
  for (const [round, action] of actions.entries()) {
    await act(env, runId, action, round);
    expect(askViolations(env.events(runId).map((event) => event as Journaled)), `after ${actions.slice(0, round + 1).join(', ')}`).toEqual([]);
    expect((env.raw().prepare('SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?').get(runId) as { n: number }).n).toBeLessThanOrEqual(1);
  }
};

describe('one ask per unknown set across recoveries, over generated crash points (P-U2, P-U3)', () => {
  it('no sequence of claims, crashes while waiting and answers asks twice for an unacknowledged set, or again after the acknowledgement', async () => {
    await forEachSeed('one ask per unknown set', PROPERTY_SEEDS, recoveries);
  });

  it('the checker of the property finds a planted second ask and a planted ask after the acknowledgement, and names the seed', async () => {
    const asked = { type: 'tool.unknown.requested', callIds: ['call_p_1'] };
    expect(askViolations([asked, asked])).toEqual(['a second ask for the unacknowledged set call_p_1 (P-U2)']);
    expect(askViolations([asked, { type: 'tool.unknown.resolved' }, asked])).toEqual(['an ask for call_p_1 after its acknowledgement (P-U3)']);
    const failure = await forEachSeed('planted', [7], () => {
      throw new Error('planted');
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PropertyFailure);
    expect((failure as PropertyFailure).seed).toBe(7);
  });
});
